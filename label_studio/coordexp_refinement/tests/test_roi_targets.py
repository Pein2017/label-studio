from __future__ import annotations

import copy
import os
import tempfile
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from coordexp_refinement.roi_targets import (
    DjangoRoiProjectBinding,
    DjangoRoiTargetCatalog,
    DjangoRoiTargetError,
    ResolvedRoiProfile,
    canonical_db_revision,
)
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from organizations.models import Organization, OrganizationMember
from PIL import Image
from projects.models import Project
from rest_framework.test import APIClient
from src.label_studio_coco_refinement.geometry import (
    norm1000_bbox_to_label_studio_xywh,
)
from src.label_studio_coco_refinement.store import DraftRestore, sha256_json
from tasks.models import Annotation, AnnotationDraft, Prediction, Task


class _FakeStore:
    def __init__(self, *, split: str, row: dict[str, Any], generation: int = 7):
        self.split = split
        self.row = copy.deepcopy(row)
        self.generation = generation
        self.source_index = 0
        self.restore_calls: list[int] = []
        self.restore_savepoint_depths: list[int] = []
        self.resolve_calls: list[dict[str, Any]] = []

    def restore_draft(self, image_id: int) -> DraftRestore:
        self.restore_calls.append(image_id)
        self.restore_savepoint_depths.append(len(connection.savepoint_ids))
        object_id = self.row['objects'][0]['coco_ann_id']
        return DraftRestore(
            split=self.split,
            image_id=image_id,
            generation=self.generation,
            row_hash=sha256_json(self.row),
            row=copy.deepcopy(self.row),
            region_id_mapping={f'{self.split}:coco:{object_id}': object_id},
        )

    def resolve_source_row_index(self, **kwargs: Any) -> int:
        self.resolve_calls.append(dict(kwargs))
        return self.source_index


class _Profiles:
    def __init__(self) -> None:
        self.selected = ResolvedRoiProfile(
            fingerprint='a' * 64,
            processor_factor=32,
            default_width=1024,
            default_height=1024,
            min_axis_pixels=32,
            max_axis_pixels=2048,
            max_total_pixels=2048 * 2048,
            deadline_seconds=20.0,
        )
        self.live = self.selected
        self.selected_calls: list[tuple[str, str]] = []
        self.current_calls: list[str] = []
        self.selected_savepoint_depths: list[int] = []
        self.current_savepoint_depths: list[int] = []

    def resolve_selected(self, *, project_id: str, selector: str) -> ResolvedRoiProfile:
        self.selected_calls.append((project_id, selector))
        self.selected_savepoint_depths.append(len(connection.savepoint_ids))
        return self.selected

    def current(self, *, project_id: str) -> ResolvedRoiProfile:
        self.current_calls.append(project_id)
        self.current_savepoint_depths.append(len(connection.savepoint_ids))
        return self.live


class RoiTargetTestCase(TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.image_root = Path(self.temporary.name) / 'images'
        (self.image_root / 'train2017').mkdir(parents=True)
        self.image_id = 41
        self.image_path = self.image_root / 'train2017' / f'{self.image_id:012d}.jpg'
        Image.new('L', (640, 480), color=127).save(self.image_path, format='JPEG')

        self.user = _user('roi-owner@example.test')
        self.organization = Organization.objects.create(title='CoordExp ROI', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=self.organization)
        self.user.active_organization = self.organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='COCO train',
            organization=self.organization,
            created_by=self.user,
            is_published=True,
        )
        self.row = _row(self.image_id)
        self.store = _FakeStore(split='train', row=self.row)
        self.profiles = _Profiles()
        self.binding = DjangoRoiProjectBinding(
            project_pk=self.project.pk,
            split='train',
            store=self.store,
            image_root=self.image_root,
            profiles=self.profiles,
        )
        self.catalog = DjangoRoiTargetCatalog({self.project.pk: self.binding})
        self.task, self.annotation, self.draft = self._task_with_draft()

    def tearDown(self) -> None:
        self.temporary.cleanup()
        super().tearDown()

    def _task_with_draft(self, *, create_draft: bool = True):
        task = Task.objects.create(
            project=self.project,
            data={
                'image': f'/data/local-files/?d=train2017/{self.image_id:012d}.jpg',
                'coordexp_task_key': f'train:{self.image_id}',
                'split': 'train',
                'image_id': self.image_id,
                'source_line': 1,
            },
        )
        annotation = Annotation.objects.create(
            task=task,
            project=self.project,
            completed_by=self.user,
            ground_truth=False,
            was_cancelled=False,
            result=_result(self.image_id),
        )
        draft = None
        if create_draft:
            draft = AnnotationDraft.objects.create(
                task=task,
                annotation=annotation,
                user=self.user,
                result=_result(self.image_id),
            )
        return task, annotation, draft

    def capture(self):
        return self.catalog.capture(
            user=self.user,
            project_pk=self.project.pk,
            task_pk=self.task.pk,
            request_id=str(uuid4()),
            roi={'x': 10.0, 'y': 20.0, 'width': 50.0, 'height': 40.0},
            resolution={'width': 1024, 'height': 768},
            profile_selector='accepted',
        )

    def test_capture_derives_all_authority_and_decodes_exact_rgb_image(self) -> None:
        annotation_before = canonical_db_revision(self.annotation.updated_at)
        draft_before = canonical_db_revision(self.draft.updated_at)
        result_before = copy.deepcopy(self.draft.result)

        with self.capture() as captured:
            target = captured.target
            self.assertEqual(captured.image.mode, 'RGB')
            self.assertEqual(captured.image.size, (640, 480))
            self.assertEqual(captured.transform.canvas_size, (1024, 768))
            self.assertEqual(target.project_id, str(self.project.pk))
            self.assertEqual(target.task_id, f'train:{self.image_id}')
            self.assertEqual(target.image_id, str(self.image_id))
            self.assertEqual(target.annotation_id, str(self.annotation.pk))
            self.assertEqual(target.annotation_revision, annotation_before)
            self.assertEqual(target.draft_id, str(self.draft.pk))
            self.assertEqual(target.draft_revision, draft_before)
            self.assertEqual(target.current_user_id, str(self.user.pk))
            self.assertEqual(target.project_generation, 7)
            self.assertEqual(target.profile_fingerprint, 'a' * 64)
            self.assertFalse(target.preexisting_draft_dirty)
            self.assertEqual(len(target.task_epoch), 64)

        self.draft.refresh_from_db()
        self.annotation.refresh_from_db()
        self.assertEqual(self.draft.result, result_before)
        self.assertEqual(canonical_db_revision(self.draft.updated_at), draft_before)
        self.assertEqual(canonical_db_revision(self.annotation.updated_at), annotation_before)
        self.assertEqual(self.profiles.selected_calls, [(str(self.project.pk), 'accepted')])
        self.assertLess(
            self.profiles.selected_savepoint_depths[0],
            self.store.restore_savepoint_depths[0],
        )
        self.assertEqual(self.store.restore_calls, [self.image_id])

    def test_capture_interprets_roi_as_label_studio_percent_xywh_once(self) -> None:
        with self.catalog.capture(
            user=self.user,
            project_pk=self.project.pk,
            task_pk=self.task.pk,
            request_id=str(uuid4()),
            roi={'x': 25.0, 'y': 25.0, 'width': 25.0, 'height': 25.0},
            resolution={'width': 1024, 'height': 768},
            profile_selector='accepted',
        ) as captured:
            roi = captured.transform.roi_percent
            self.assertEqual((roi.x, roi.y, roi.width, roi.height), (25.0, 25.0, 25.0, 25.0))
            self.assertEqual(captured.transform.crop_edges, (160, 120, 320, 240))

    def test_current_target_relocks_and_reports_revision_profile_generation_drift(self) -> None:
        with self.capture() as captured:
            frozen = captured.target
        next_revision = self.draft.updated_at + timedelta(seconds=1)
        AnnotationDraft.objects.filter(pk=self.draft.pk).update(
            result=_result(self.image_id, bbox=(120, 120, 300, 420)),
            updated_at=next_revision,
        )
        self.store.generation = 8
        self.profiles.live = ResolvedRoiProfile(
            fingerprint='b' * 64,
            processor_factor=32,
            default_width=1024,
            default_height=1024,
            min_axis_pixels=32,
            max_axis_pixels=2048,
            max_total_pixels=2048 * 2048,
            deadline_seconds=20.0,
        )

        current = self.catalog.current_target(frozen)

        self.assertEqual(current.task_id, frozen.task_id)
        self.assertEqual(current.task_epoch, frozen.task_epoch)
        self.assertNotEqual(current.draft_revision, frozen.draft_revision)
        self.assertEqual(current.profile_fingerprint, 'b' * 64)
        self.assertLess(
            self.profiles.current_savepoint_depths[-1],
            self.store.restore_savepoint_depths[-1],
        )
        self.assertEqual(current.project_generation, 8)

    def test_task_row_and_cardinality_drift_fail_closed(self) -> None:
        cases = ('task_data', 'draft', 'annotation', 'prediction')
        for case in cases:
            with self.subTest(case=case):
                if case == 'task_data':
                    original = dict(self.task.data)
                    self.task.data = {**original, 'unexpected': True}
                    self.task.save(update_fields=['data'])
                elif case == 'draft':
                    duplicate = AnnotationDraft.objects.create(
                        task=self.task,
                        annotation=self.annotation,
                        user=self.user,
                        result=self.draft.result,
                    )
                elif case == 'annotation':
                    duplicate = Annotation.objects.create(
                        task=self.task,
                        project=self.project,
                        result=self.annotation.result,
                    )
                else:
                    duplicate = Prediction.objects.create(
                        task=self.task,
                        project=self.project,
                        result=[],
                    )
                with self.assertRaises(DjangoRoiTargetError):
                    self.capture()
                if case == 'task_data':
                    self.task.data = original
                    self.task.save(update_fields=['data'])
                else:
                    duplicate.delete()

    def test_wrong_user_project_task_and_profile_resolution_fail_closed(self) -> None:
        other = _user('roi-other@example.test')
        for mutation in ('user', 'project', 'task', 'profile'):
            with self.subTest(mutation=mutation):
                kwargs = {
                    'user': self.user,
                    'project_pk': self.project.pk,
                    'task_pk': self.task.pk,
                    'request_id': str(uuid4()),
                    'roi': {'x': 0, 'y': 0, 'width': 100, 'height': 100},
                    'resolution': {'width': 1024, 'height': 1024},
                    'profile_selector': 'accepted',
                }
                if mutation == 'user':
                    kwargs['user'] = other
                elif mutation == 'project':
                    kwargs['project_pk'] = self.project.pk + 999
                elif mutation == 'task':
                    kwargs['task_pk'] = self.task.pk + 999
                else:
                    self.profiles.selected = None
                with self.assertRaises(DjangoRoiTargetError):
                    self.catalog.capture(**kwargs)
                self.profiles.selected = self.profiles.live

    def test_resolution_and_image_dimension_mismatch_fail_before_service(self) -> None:
        with self.assertRaisesRegex(DjangoRoiTargetError, 'divisible'):
            self.catalog.capture(
                user=self.user,
                project_pk=self.project.pk,
                task_pk=self.task.pk,
                request_id=str(uuid4()),
                roi=(0, 0, 100, 100),
                resolution=(1000, 1024),
                profile_selector='accepted',
            )

        Image.new('RGB', (641, 480), color='black').save(self.image_path, format='JPEG')
        with self.assertRaisesRegex(DjangoRoiTargetError, 'dimensions'):
            self.capture()

    def test_symlink_and_nonregular_image_are_rejected_without_escape(self) -> None:
        outside = Path(self.temporary.name) / 'outside.jpg'
        Image.new('RGB', (640, 480), color='black').save(outside, format='JPEG')
        self.image_path.unlink()
        self.image_path.symlink_to(outside)
        with self.assertRaises(DjangoRoiTargetError):
            self.capture()

        self.image_path.unlink()
        os.mkdir(self.image_path)
        with self.assertRaisesRegex(DjangoRoiTargetError, 'regular|failed'):
            self.capture()

    def test_ancestor_symlink_swap_cannot_replace_pinned_image_root(self) -> None:
        trusted_parent = Path(self.temporary.name) / 'trusted-parent'
        trusted_root = trusted_parent / 'images'
        (trusted_root / 'train2017').mkdir(parents=True)
        Image.new('RGB', (640, 480), color='white').save(
            trusted_root / 'train2017' / f'{self.image_id:012d}.jpg',
            format='JPEG',
        )
        binding = DjangoRoiProjectBinding(
            project_pk=self.project.pk,
            split='train',
            store=self.store,
            image_root=trusted_root,
            profiles=self.profiles,
        )
        catalog = DjangoRoiTargetCatalog({self.project.pk: binding})

        preserved_parent = Path(self.temporary.name) / 'trusted-parent-preserved'
        trusted_parent.rename(preserved_parent)
        attacker_parent = Path(self.temporary.name) / 'attacker-parent'
        attacker_image = attacker_parent / 'images' / 'train2017' / f'{self.image_id:012d}.jpg'
        attacker_image.parent.mkdir(parents=True)
        # Invalid bytes prove rejection occurs at the pinned-root check, before decode.
        attacker_image.write_bytes(b'not-an-image')
        trusted_parent.symlink_to(attacker_parent, target_is_directory=True)

        with self.assertRaisesRegex(DjangoRoiTargetError, 'root identity changed'):
            catalog.capture(
                user=self.user,
                project_pk=self.project.pk,
                task_pk=self.task.pk,
                request_id=str(uuid4()),
                roi={'x': 0, 'y': 0, 'width': 100, 'height': 100},
                resolution={'width': 1024, 'height': 1024},
                profile_selector='accepted',
            )

    def test_native_draft_serializer_create_and_patch_shape_is_strict(self) -> None:
        # Exercise the native DRF serializer/API rather than a hand-built payload;
        # this is the response contract consumed by the managed frontend save seam.
        self.draft.delete()
        client = APIClient()
        client.force_authenticate(self.user)
        create = client.post(
            f'/api/tasks/{self.task.pk}/annotations/{self.annotation.pk}/drafts',
            data={'result': _result(self.image_id), 'lead_time': 1.25},
            format='json',
        )
        self.assertEqual(create.status_code, 201, create.content)
        created = create.json()
        create_body = {key: value for key, value in created.items() if key != '$meta'}
        self.assertEqual(
            set(create_body),
            {
                'id',
                'result',
                'lead_time',
                'task',
                'annotation',
                'user',
                'was_postponed',
                'import_id',
                'created_at',
                'updated_at',
                'created_username',
                'created_ago',
            },
        )
        self.assertEqual(create_body['task'], self.task.pk)
        self.assertEqual(create_body['annotation'], self.annotation.pk)
        self.assertIsInstance(create_body['updated_at'], str)
        self.assertTrue(create_body['updated_at'])

        revised = _result(self.image_id, bbox=(120, 120, 320, 430))
        patch = client.patch(
            f'/api/drafts/{create_body["id"]}/',
            data={'result': revised},
            format='json',
        )
        self.assertEqual(patch.status_code, 200, patch.content)
        patched = patch.json()
        patch_body = {key: value for key, value in patched.items() if key != '$meta'}
        self.assertEqual(set(patch_body), set(create_body))
        self.assertEqual(patch_body['id'], create_body['id'])
        self.assertEqual(patch_body['task'], self.task.pk)
        self.assertEqual(patch_body['annotation'], self.annotation.pk)
        self.assertEqual(patch_body['result'], revised)
        self.assertGreaterEqual(patch_body['updated_at'], create_body['updated_at'])


def _row(image_id: int) -> dict[str, Any]:
    return {
        'images': [f'../rescale_32_1024_bbox/images/train2017/{image_id:012d}.jpg'],
        'objects': [
            {
                'bbox_2d': [100, 120, 300, 420],
                'desc': 'person',
                'category_name': 'person',
                'category_id': 1,
                'coco_ann_id': image_id * 10 + 1,
            }
        ],
        'width': 640,
        'height': 480,
        'image_id': image_id,
        'file_name': f'images/train2017/{image_id:012d}.jpg',
        'metadata': {'source': 'coco2017', 'split': 'train'},
    }


def _result(
    image_id: int,
    *,
    bbox: tuple[int, int, int, int] = (100, 120, 300, 420),
) -> list[dict[str, Any]]:
    x, y, width, height = norm1000_bbox_to_label_studio_xywh(bbox)
    object_id = image_id * 10 + 1
    key = f'train:coco:{object_id}'
    return [
        {
            'id': key,
            'type': 'rectanglelabels',
            'from_name': 'bbox',
            'to_name': 'image',
            'original_width': 640,
            'original_height': 480,
            'image_rotation': 0,
            'value': {
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'rotation': 0,
                'rectanglelabels': ['person'],
            },
            'meta': {
                'coordexp_region_key': key,
                'last_committed_bbox': [100, 120, 300, 420],
                'coco_ann_id': object_id,
            },
        }
    ]


def _user(email: str):
    return get_user_model().objects.create(
        email=email,
        username=email,
        is_active=True,
    )

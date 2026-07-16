from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import replace
from typing import Any
from unittest.mock import patch

from coordexp_refinement.catalog import (
    DjangoAnnotationVerifier,
    DjangoDraftCatalog,
    DraftLifecycleConflict,
)
from django.contrib.auth import get_user_model
from django.test import TestCase
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from src.label_studio_coco_refinement.draft_adapter import canonicalize_label_studio_draft
from src.label_studio_coco_refinement.geometry import (
    norm1000_bbox_to_label_studio_xywh,
)
from src.label_studio_coco_refinement.runtime import (
    AuthenticatedPrincipal,
    DraftCatalogError,
    DraftCatalogRequest,
)
from src.label_studio_coco_refinement.store import (
    AuthoritativeDraftIdentity,
    BatchMember,
    BatchRequest,
    CommitRequest,
    DraftRestore,
    DraftSaveReceipt,
    semantic_hash,
    sha256_json,
)
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.serializers import AnnotationDraftSerializer


class FakeStore:
    def __init__(self, *, split: str, generation: int = 7) -> None:
        self.split = split
        self.generation = generation
        self.restores: dict[int, DraftRestore] = {}
        self.source_indexes: dict[int, int] = {}
        self.restore_calls: list[tuple[int, ...]] = []
        self.resolve_calls: list[dict[str, Any]] = []

    def add(
        self,
        image_id: int,
        *,
        source_index: int,
        bbox: tuple[int, int, int, int] = (100, 120, 300, 420),
    ) -> None:
        object_id = image_id * 10 + 1
        row = {
            'image_id': image_id,
            'width': 640,
            'height': 480,
            'objects': [
                {
                    'bbox_2d': list(bbox),
                    'desc': 'person',
                    'category_name': 'person',
                    'category_id': 1,
                    'coco_ann_id': object_id,
                }
            ],
        }
        self.restores[image_id] = DraftRestore(
            split=self.split,
            image_id=image_id,
            generation=self.generation,
            row_hash=sha256_json(row),
            row=copy.deepcopy(row),
            region_id_mapping={f'{self.split}:coco:{object_id}': object_id},
        )
        self.source_indexes[image_id] = source_index

    def resolve_source_row_index(self, **kwargs: Any) -> int:
        self.resolve_calls.append(dict(kwargs))
        return self.source_indexes[kwargs['image_id']]

    def restore_drafts(self, image_ids: tuple[int, ...]) -> tuple[DraftRestore, ...]:
        self.restore_calls.append(tuple(image_ids))
        return tuple(copy.deepcopy(self.restores[image_id]) for image_id in image_ids)

    def restore_draft(self, image_id: int) -> DraftRestore:
        self.restore_calls.append((image_id,))
        return copy.deepcopy(self.restores[image_id])


class CatalogTestCase(TestCase):
    def setUp(self) -> None:
        self.user = _user('owner@example.test')
        organization = Organization.objects.create(title='CoordExp test', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=organization)
        self.user.active_organization = organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='COCO train',
            organization=organization,
            created_by=self.user,
            is_published=True,
        )
        self.store = FakeStore(split='train')
        self.catalog = DjangoDraftCatalog({'train': self.store}, {'train': self.project.pk})

    def make_task(
        self,
        image_id: int,
        *,
        source_line: int,
        bbox: tuple[int, int, int, int] = (101, 120, 300, 420),
        user=None,
    ):
        self.store.add(image_id, source_index=source_line - 1)
        task = Task.objects.create(
            project=self.project,
            data={
                'image': f'/data/local-files/?d=train2017/{image_id:012d}.jpg',
                'coordexp_task_key': f'train:{image_id}',
                'split': 'train',
                'image_id': image_id,
                'source_line': source_line,
            },
        )
        annotation = Annotation.objects.create(
            task=task,
            project=self.project,
            ground_truth=False,
            was_cancelled=False,
            result=_result('train', image_id, bbox=(100, 120, 300, 420)),
        )
        result = _result('train', image_id, bbox=bbox)
        draft = AnnotationDraft.objects.create(
            task=task,
            annotation=annotation,
            user=user or self.user,
            result=result,
        )
        return task, annotation, draft, result

    def capture(self):
        return self.catalog.capture_current_user_drafts(
            DraftCatalogRequest(
                split='train',
                project_id=str(self.project.pk),
                principal=AuthenticatedPrincipal(user_id=str(self.user.pk), authenticated=True),
            )
        )

    def project_state(self):
        store_state = {
            'generation': self.store.generation,
            'working_sha256': getattr(self.store, 'working_sha256', 'a' * 64),
            'working_line_count': getattr(self.store, 'working_line_count', 117_266),
            'active_batch_id': None,
            'batch_state': None,
            'active_batch': None,
            'active_member_semantic_hashes': {},
            'last_terminal_batch': None,
            'last_terminal_member_semantic_hashes': {},
        }
        with patch(
            'coordexp_refinement.catalog._store_project_state',
            side_effect=lambda _store: copy.deepcopy(store_state),
        ):
            return self.catalog.project_state(
                split='train',
                principal=AuthenticatedPrincipal(
                    user_id=str(self.user.pk),
                    authenticated=True,
                ),
            )

    def lifecycle(self, task: Task, draft: AnnotationDraft, *, action: str, expected=None):
        canonical = canonicalize_label_studio_draft(
            draft.result,
            split='train',
            image_id=task.data['image_id'],
            image_width=640,
            image_height=480,
        )
        token = expected or {
            'draft_id': draft.pk,
            'draft_updated_at': AnnotationDraftSerializer(draft).data['updated_at'],
            'draft_semantic_hash': canonical.semantic_hash,
        }
        terminal_state = {
            'generation': self.store.generation,
            'working_sha256': 'a' * 64,
            'working_line_count': 1,
            'active_batch_id': None,
            'batch_state': None,
            'active_batch': None,
            'active_member_semantic_hashes': {},
            'last_terminal_batch': {
                'batch_id': 'terminal-batch',
                'state': 'succeeded',
                'member_count': 1,
                'base_generation': self.store.generation - 1,
                'generation': self.store.generation,
                'error': None,
                'payload_hash': 'b' * 64,
                'member_task_keys': [f"train:{task.data['image_id']}"],
            },
            'last_terminal_member_semantic_hashes': {
                f"train:{task.data['image_id']}": token['draft_semantic_hash']
            },
        }
        with patch(
            'coordexp_refinement.catalog._store_project_state',
            return_value=terminal_state,
        ):
            return self.catalog.current_task_lifecycle(
                split='train',
                principal=AuthenticatedPrincipal(user_id=str(self.user.pk), authenticated=True),
                task_pk=task.pk,
                action=action,
                expected_draft=token,
            )

    def test_exact_terminal_reconcile_resets_the_persisted_result_to_committed_truth(self) -> None:
        task, _, draft, _ = self.make_task(41, source_line=1, bbox=(100, 120, 300, 420))
        prior_updated_at = draft.updated_at

        payload = self.lifecycle(task, draft, action='reconcile')
        draft.refresh_from_db()

        self.assertEqual(payload['disposition'], 'rebased')
        self.assertTrue(payload['expected_draft_matches'])
        self.assertEqual(payload['committed']['generation'], 7)
        self.assertEqual(draft.result, payload['committed']['result'])
        self.assertGreater(draft.updated_at, prior_updated_at)
        self.assertEqual(draft.result[0]['meta']['coco_ann_id'], 411)

    def test_newer_semantics_receive_metadata_only_without_replacing_the_draft(self) -> None:
        task, _, draft, result = self.make_task(42, source_line=1, bbox=(101, 120, 300, 420))
        original = copy.deepcopy(result)

        payload = self.lifecycle(task, draft, action='inspect')
        draft.refresh_from_db()

        self.assertEqual(payload['disposition'], 'metadata_only')
        self.assertTrue(payload['expected_draft_matches'])
        self.assertEqual(draft.result, original)
        self.assertNotEqual(payload['committed']['result'], original)

    def test_exact_terminal_reconcile_accepts_newly_allocated_negative_identity(self) -> None:
        task, _, draft, result = self.make_task(45, source_line=1, bbox=(100, 120, 300, 420))
        result[0]['id'] = 'new-region'
        result[0]['meta'] = {'coordexp_region_key': 'new-region'}
        draft.result = result
        draft.save(update_fields=['result', 'updated_at'])
        committed = copy.deepcopy(self.store.restores[45])
        committed_row = copy.deepcopy(committed.row)
        committed_row['objects'][0]['coco_ann_id'] = -1
        self.store.restores[45] = replace(
            committed,
            row=committed_row,
            row_hash=sha256_json(committed_row),
            region_id_mapping={'new-region': -1},
        )

        payload = self.lifecycle(task, draft, action='reconcile')
        draft.refresh_from_db()

        self.assertEqual(payload['disposition'], 'rebased')
        self.assertEqual(draft.result[0]['meta']['coco_ann_id'], -1)
        self.assertEqual(draft.result[0]['meta']['coordexp_region_key'], 'new-region')

    def test_explicit_discard_atomically_resets_the_exact_persisted_draft(self) -> None:
        task, _, draft, result = self.make_task(43, source_line=1, bbox=(102, 120, 300, 420))

        payload = self.lifecycle(task, draft, action='discard')
        draft.refresh_from_db()

        self.assertEqual(payload['disposition'], 'reset')
        self.assertNotEqual(draft.result, result)
        self.assertEqual(draft.result, payload['committed']['result'])
        self.assertEqual(
            payload['draft']['draft_semantic_hash'],
            payload['committed']['semantic_hash'],
        )

    def test_explicit_discard_rejects_a_stale_draft_token_without_mutation(self) -> None:
        task, _, draft, result = self.make_task(44, source_line=1, bbox=(102, 120, 300, 420))
        stale = {
            'draft_id': draft.pk,
            'draft_updated_at': '2026-07-15T00:00:00Z',
            'draft_semantic_hash': '0' * 64,
        }

        with self.assertRaises(DraftLifecycleConflict):
            self.lifecycle(task, draft, action='discard', expected=stale)
        draft.refresh_from_db()
        self.assertEqual(draft.result, result)

    def test_task_lifecycle_rolls_back_when_working_authority_changes_mid_request(self) -> None:
        task, _, draft, result = self.make_task(46, source_line=1, bbox=(102, 120, 300, 420))
        canonical = canonicalize_label_studio_draft(
            draft.result,
            split='train',
            image_id=46,
            image_width=640,
            image_height=480,
        )
        token = {
            'draft_id': draft.pk,
            'draft_updated_at': AnnotationDraftSerializer(draft).data['updated_at'],
            'draft_semantic_hash': canonical.semantic_hash,
        }
        stable = {
            'generation': 7,
            'working_sha256': 'a' * 64,
            'working_line_count': 1,
            'active_batch_id': None,
            'batch_state': None,
            'active_batch': None,
            'active_member_semantic_hashes': {},
            'last_terminal_batch': None,
            'last_terminal_member_semantic_hashes': {},
        }
        changed = {**stable, 'generation': 8, 'working_sha256': 'b' * 64}

        with patch(
            'coordexp_refinement.catalog._store_project_state',
            side_effect=[stable, changed],
        ), self.assertRaisesRegex(DraftCatalogError, 'working store changed'):
            self.catalog.current_task_lifecycle(
                split='train',
                principal=AuthenticatedPrincipal(user_id=str(self.user.pk), authenticated=True),
                task_pk=task.pk,
                action='discard',
                expected_draft=token,
            )
        draft.refresh_from_db()
        self.assertEqual(draft.result, result)

    def test_project_state_with_zero_drafts_never_scans_working_jsonl(self) -> None:
        state = self.project_state()

        self.assertEqual(state['generation'], 7)
        self.assertEqual(state['pending_draft_count'], 0)
        self.assertEqual(state['members'], [])
        self.assertEqual(self.store.restore_calls, [])

    def test_project_state_reuses_attested_baselines_for_same_store_authority(self) -> None:
        task, _, draft, _ = self.make_task(10, source_line=1)

        first = self.project_state()
        second = self.project_state()

        self.assertEqual(self.store.restore_calls, [(10,)])
        self.assertEqual(second, first)
        self.assertEqual(
            first['members'],
            [
                {
                    'task_id': task.pk,
                    'task_key': 'train:10',
                    'draft_id': draft.pk,
                    'draft_updated_at': AnnotationDraftSerializer(draft).data['updated_at'],
                    'draft_semantic_hash': first['members'][0]['draft_semantic_hash'],
                    'committed_semantic_hash': first['members'][0]['committed_semantic_hash'],
                    'pending': True,
                    'draft_ahead_of_committed': True,
                    'active_batch_member': False,
                    'active_batch_semantic_hash': None,
                    'draft_ahead_of_active_batch': False,
                    'last_terminal_batch_member': False,
                    'last_terminal_batch_semantic_hash': None,
                    'draft_matches_last_terminal_batch': False,
                }
            ],
        )

    def test_project_state_rescans_after_generation_or_working_hash_change(self) -> None:
        self.make_task(16, source_line=1)

        self.project_state()
        self.store.generation = 8
        self.store.working_sha256 = 'b' * 64
        self.store.restores[16] = replace(self.store.restores[16], generation=8)
        self.project_state()
        self.store.working_sha256 = 'c' * 64
        self.project_state()

        self.assertEqual(self.store.restore_calls, [(16,), (16,), (16,)])

    def test_project_state_cache_never_weakens_explicit_draft_capture(self) -> None:
        self.make_task(17, source_line=1)

        self.project_state()
        capture = self.capture()

        self.assertEqual([snapshot.image_id for snapshot in capture.snapshots], [17])
        self.assertEqual(self.store.restore_calls, [(17,), (17,)])

    def test_capture_is_current_user_scoped_and_ignores_other_user_draft(self) -> None:
        task, annotation, _, _ = self.make_task(11, source_line=1)
        other = _user('other@example.test')
        OrganizationMember.objects.create(user=other, organization=self.project.organization)
        other.active_organization = self.project.organization
        other.save(update_fields=['active_organization'])
        AnnotationDraft.objects.create(
            task=task,
            annotation=annotation,
            user=other,
            result=_result('train', 11, bbox=(103, 120, 300, 420)),
        )

        capture = self.capture()

        self.assertEqual(capture.current_user_id, str(self.user.pk))
        self.assertEqual([snapshot.image_id for snapshot in capture.snapshots], [11])

    def test_rejects_multiple_current_user_drafts_for_one_task(self) -> None:
        task, annotation, _, result = self.make_task(12, source_line=1)
        AnnotationDraft.objects.create(
            task=task,
            annotation=annotation,
            user=self.user,
            result=result,
        )

        with self.assertRaisesRegex(DraftCatalogError, 'multiple Drafts'):
            self.capture()

    def test_rejects_alternate_annotation_prediction_and_wrong_binding(self) -> None:
        cases = ('annotation', 'prediction', 'binding', 'annotation_project')
        for case in cases:
            with self.subTest(case=case):
                AnnotationDraft.objects.all().delete()
                Annotation.objects.all().delete()
                Prediction.objects.all().delete()
                task, annotation, draft, _ = self.make_task(13, source_line=1)
                if case == 'annotation':
                    Annotation.objects.create(
                        task=task,
                        project=self.project,
                        completed_by=self.user,
                        result=[],
                    )
                elif case == 'prediction':
                    Prediction.objects.create(task=task, project=self.project, result=[])
                elif case == 'binding':
                    other_task = Task.objects.create(project=self.project, data={'text': 'alternate'})
                    other_annotation = Annotation.objects.create(
                        task=other_task,
                        project=self.project,
                        completed_by=self.user,
                        result=[],
                    )
                    AnnotationDraft.objects.filter(pk=draft.pk).update(annotation=other_annotation)
                else:
                    other_project = Project.objects.create(
                        title='Other',
                        organization=self.project.organization,
                        created_by=self.user,
                    )
                    Annotation.objects.filter(pk=annotation.pk).update(project=other_project)
                with self.assertRaises(DraftCatalogError):
                    self.capture()

    def test_rejects_each_invalid_task_identity_field(self) -> None:
        mutations = {
            'coordexp_task_key': 'train:999',
            'split': 'val',
            'image_id': -1,
            'source_line': 2,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                AnnotationDraft.objects.all().delete()
                Annotation.objects.all().delete()
                task, _, _, _ = self.make_task(14, source_line=1)
                data = dict(task.data)
                data[field] = value
                task.data = data
                task.save(update_fields=['data'])
                with self.assertRaises(DraftCatalogError):
                    self.capture()

    def test_excludes_semantically_equal_baseline(self) -> None:
        self.make_task(15, source_line=1, bbox=(100, 120, 300, 420))

        with self.assertRaisesRegex(DraftCatalogError, 'no eligible Drafts'):
            self.capture()

    def test_captures_one_generation_in_source_order_and_deep_freezes_payload(self) -> None:
        _, _, late_draft, late_raw = self.make_task(22, source_line=2)
        self.make_task(21, source_line=1)

        capture = self.capture()

        self.assertEqual(self.store.restore_calls, [(21, 22)])
        self.assertEqual(capture.base_generation, 7)
        self.assertEqual([item.image_id for item in capture.snapshots], [21, 22])
        late_snapshot = capture.snapshots[1]
        self.assertEqual(late_snapshot.result_hash, sha256_json(late_raw))
        self.assertEqual(
            late_snapshot.regions[0]['label_studio_result']['meta']['coordexp_region_key'],
            'train:coco:221',
        )
        late_draft.result[0]['meta']['caller_mutation'] = True
        late_raw[0]['meta']['caller_mutation'] = True
        self.assertNotIn(
            'caller_mutation',
            late_snapshot.regions[0]['label_studio_result']['meta'],
        )


class VerifierTestCase(TestCase):
    make_task = CatalogTestCase.make_task
    capture = CatalogTestCase.capture

    def setUp(self) -> None:
        CatalogTestCase.setUp(self)
        self.task, self.annotation, self.draft, result = self.make_task(31, source_line=1)
        result.append(_inference_result())
        self.draft.result = result
        self.draft.save(update_fields=['result', 'updated_at'])
        self.snapshot = self.capture().snapshots[0]
        receipt = DraftSaveReceipt(
            project_id=self.snapshot.project_id,
            task_id=self.snapshot.task_id,
            annotation_id=self.snapshot.annotation_id,
            draft_id=self.snapshot.draft_id,
            annotation_revision=self.snapshot.annotation_revision,
            draft_updated_at=self.snapshot.draft_updated_at,
            semantic_hash=self.snapshot.semantic_hash,
            result_hash=self.snapshot.result_hash,
            durable=True,
        )
        self.commit = CommitRequest(
            commit_id='batch-1:member:train:31',
            split='train',
            image_id=31,
            project_id=str(self.project.pk),
            task_id='train:31',
            annotation_id=str(self.annotation.pk),
            draft_id=str(self.draft.pk),
            annotation_revision=self.snapshot.annotation_revision,
            draft_updated_at=self.snapshot.draft_updated_at,
            semantic_hash=self.snapshot.semantic_hash,
            result_hash=self.snapshot.result_hash,
            base_row_hash=self.snapshot.base_row_hash,
            observed_generation=self.snapshot.observed_generation,
            regions=_thaw(self.snapshot.regions),
            draft_save=receipt,
            inference_receipts=self.snapshot.inference_receipts,
        )
        self.member = BatchMember(source_row_index=0, request=self.commit)
        self.batch = BatchRequest(
            batch_id='batch-1',
            split='train',
            current_user_id=str(self.user.pk),
            base_generation=self.snapshot.observed_generation,
            members=(self.member,),
        )
        self.verifier = DjangoAnnotationVerifier({'train': self.project.pk})
        self.store.restore_calls.clear()
        self.store.resolve_calls.clear()

    def batch_with_commit(self, commit: CommitRequest) -> BatchRequest:
        return replace(
            self.batch,
            members=(replace(self.member, request=commit),),
        )

    def test_exact_batch_succeeds_legacy_verify_fails_and_store_is_untouched(self) -> None:
        identity = AuthoritativeDraftIdentity.from_request(self.commit)
        self.assertFalse(self.verifier.verify(identity))
        self.assertTrue(self.verifier.verify_batch(self.batch))
        self.assertEqual(self.store.restore_calls, [])
        self.assertEqual(self.store.resolve_calls, [])

    def test_every_member_identity_revision_or_hash_drift_fails_closed(self) -> None:
        mutations = {
            'split': 'val',
            'image_id': 999,
            'project_id': '999',
            'task_id': 'train:999',
            'annotation_id': '999',
            'draft_id': '999',
            'annotation_revision': 'changed',
            'draft_updated_at': 'changed',
            'semantic_hash': '0' * 64,
            'result_hash': '0' * 64,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                changed = replace(self.commit, **{field: value})
                self.assertFalse(self.verifier.verify_batch(self.batch_with_commit(changed)))

    def test_current_user_draft_owner_and_project_access_drift_fail_closed(self) -> None:
        other = _user('other-verifier@example.test')
        OrganizationMember.objects.create(user=other, organization=self.project.organization)
        other.active_organization = self.project.organization
        other.save(update_fields=['active_organization'])
        self.assertFalse(self.verifier.verify_batch(replace(self.batch, current_user_id=str(other.pk))))

        AnnotationDraft.objects.filter(pk=self.draft.pk).update(user=other)
        self.assertFalse(self.verifier.verify_batch(self.batch))
        AnnotationDraft.objects.filter(pk=self.draft.pk).update(user=self.user)

        foreign_org = Organization.objects.create(title='Foreign', created_by=other)
        OrganizationMember.objects.create(user=self.user, organization=foreign_org)
        self.user.active_organization = foreign_org
        self.user.save(update_fields=['active_organization'])
        self.assertFalse(self.verifier.verify_batch(self.batch))

    def test_current_user_id_requires_canonical_decimal_text(self) -> None:
        for value in (self.user.pk, True, f'0{self.user.pk}', ' 1'):
            with self.subTest(value=value):
                self.assertFalse(self.verifier.verify_batch(replace(self.batch, current_user_id=value)))

    def test_retained_meta_only_request_tamper_fails_full_payload_attestation(self) -> None:
        regions = _thaw(self.commit.regions)
        regions[0]['draft_meta']['review_only_tamper'] = True
        self.assertEqual(semantic_hash(regions), self.commit.semantic_hash)
        changed = replace(self.commit, regions=regions)
        self.assertFalse(self.verifier.verify_batch(self.batch_with_commit(changed)))

    def test_raw_result_order_and_meta_drift_fail_even_when_semantics_match(self) -> None:
        original = copy.deepcopy(self.draft.result)
        reversed_result = list(reversed(original))
        self.assertNotEqual(sha256_json(reversed_result), self.commit.result_hash)
        AnnotationDraft.objects.filter(pk=self.draft.pk).update(result=reversed_result)
        self.assertFalse(self.verifier.verify_batch(self.batch))

        changed_meta = copy.deepcopy(original)
        changed_meta[0]['meta']['non_semantic_note'] = 'tampered'
        AnnotationDraft.objects.filter(pk=self.draft.pk).update(result=changed_meta)
        self.assertFalse(self.verifier.verify_batch(self.batch))

    def test_inference_receipts_must_match_canonical_draft_exactly(self) -> None:
        self.assertEqual(self.commit.inference_receipts, ('receipt-1',))
        changed = replace(self.commit, inference_receipts=())
        self.assertFalse(self.verifier.verify_batch(self.batch_with_commit(changed)))

    def test_extra_draft_annotation_and_prediction_each_fail_closed(self) -> None:
        extra = AnnotationDraft.objects.create(
            task=self.task,
            annotation=self.annotation,
            user=self.user,
            result=self.draft.result,
        )
        self.assertFalse(self.verifier.verify_batch(self.batch))
        extra.delete()

        alternate = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.user,
            result=self.annotation.result,
        )
        self.assertFalse(self.verifier.verify_batch(self.batch))
        alternate.delete()

        prediction = Prediction.objects.create(task=self.task, project=self.project, result=[])
        self.assertFalse(self.verifier.verify_batch(self.batch))
        prediction.delete()

    def test_source_row_index_and_task_source_line_must_match(self) -> None:
        changed_member = replace(self.member, source_row_index=1)
        self.assertFalse(self.verifier.verify_batch(replace(self.batch, members=(changed_member,))))

        self.task.data = {**self.task.data, 'source_line': 2}
        self.task.save(update_fields=['data'])
        self.assertFalse(self.verifier.verify_batch(self.batch))

    def test_empty_invalid_and_inconsistent_annotation_dimensions_fail_closed(self) -> None:
        baseline = copy.deepcopy(self.annotation.result)
        cases = {
            'empty': [],
            'invalid': [{**baseline[0], 'original_width': 0}],
            'inconsistent': [baseline[0], {**baseline[0], 'original_height': 481}],
        }
        for label, result in cases.items():
            with self.subTest(label=label):
                Annotation.objects.filter(pk=self.annotation.pk).update(result=result)
                self.assertFalse(self.verifier.verify_batch(self.batch))


def _result(
    split: str,
    image_id: int,
    *,
    bbox: tuple[int, int, int, int],
) -> list[dict[str, Any]]:
    x, y, width, height = norm1000_bbox_to_label_studio_xywh(bbox)
    object_id = image_id * 10 + 1
    region_key = f'{split}:coco:{object_id}'
    return [
        {
            'id': region_key,
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
                'coordexp_region_key': region_key,
                'last_committed_bbox': [100, 120, 300, 420],
                'coco_ann_id': object_id,
                'coordexp_training_metadata': {'review': 'retained'},
            },
        }
    ]


def _inference_result() -> dict[str, Any]:
    x, y, width, height = norm1000_bbox_to_label_studio_xywh((400, 200, 500, 320))
    return {
        'id': 'inferred:region-1',
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
            'rectanglelabels': ['dog'],
        },
        'meta': {
            'coordexp_region_key': 'inferred:region-1',
            'coordexp_creation_ordinal': 1,
            'coordexp_inference_receipt_id': 'receipt-1',
            'coordexp_inference_request_id': 'request-1',
            'coordexp_inference_result_id': 'result-1',
            'coordexp_inference_source_draft_revision': 'source-draft-revision-1',
        },
    }


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    if isinstance(value, list):
        return [_thaw(item) for item in value]
    return value


def _user(email: str):
    return get_user_model().objects.create_user(email=email, password='test', username=email.split('@', 1)[0])

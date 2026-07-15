from __future__ import annotations

import copy
import hashlib
import os
import tempfile
import threading
import time
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch
from uuid import uuid4

from coordexp_refinement.roi_finalization import DjangoRoiFinalizationError, DjangoRoiFinalizer
from coordexp_refinement.roi_targets import (
    DjangoRoiProjectBinding,
    DjangoRoiTargetCatalog,
    canonical_db_revision,
    proof_json_sha256,
)
from coordexp_refinement.transition_fence import (
    DraftTransitionFence,
    DraftTransitionFenceError,
    ProjectMutationBindingRegistry,
    project_mutation_bindings,
)
from django.contrib.auth import get_user_model
from django.db import DatabaseError, close_old_connections, connection
from django.test import SimpleTestCase, TransactionTestCase
from organizations.models import Organization, OrganizationMember
from PIL import Image
from projects.models import Project
from rest_framework.test import APIClient
from src.inference.parsing import parse_compact_object_box_closed
from src.label_studio_coco_refinement.inference_results import (
    CurrentTarget,
    InferenceAttemptReceipt,
    RequestLifecycle,
    RequestState,
    classify_parser_result,
    finalize_region_links,
)
from src.label_studio_coco_refinement.roi_runtime import InferenceReceiptStore
from src.templates.renderer import BOX_END_TOKEN, BOX_START_TOKEN, OBJECT_REF_END_TOKEN, OBJECT_REF_START_TOKEN
from tasks.models import Annotation, AnnotationDraft, Task

from .test_roi_finalization import _inference_result, _result
from .test_roi_targets import _FakeStore, _Profiles, _row, _user

# pytest-django otherwise chooses its shared in-memory SQLite URI.  This module
# specifically attests independent thread-local connections against a real file.
if connection.vendor == 'sqlite':
    connection.settings_dict.setdefault('TEST', {})['NAME'] = str(
        Path(tempfile.gettempdir()) / f'coordexp-transition-{os.getpid()}.sqlite3'
    )


class DraftTransitionFenceTestCase(SimpleTestCase):
    def setUp(self) -> None:
        self.fence = DraftTransitionFence()
        self.key = {'project_id': 7, 'user_id': 11, 'task_key': 'train:51'}

    def test_same_key_serializes_and_cleans_waiter_reference(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        second_entered = threading.Event()

        def first() -> None:
            with self.fence.hold(**self.key):
                entered.set()
                release.wait(timeout=2)

        def second() -> None:
            entered.wait(timeout=2)
            with self.fence.hold(**self.key):
                second_entered.set()

        first_thread = threading.Thread(target=first)
        second_thread = threading.Thread(target=second)
        first_thread.start()
        self.assertTrue(entered.wait(timeout=2))
        second_thread.start()
        self.assertFalse(second_entered.wait(timeout=0.05))
        self.assertEqual(self.fence.reference_count(**self.key), 2)
        release.set()
        first_thread.join(timeout=2)
        second_thread.join(timeout=2)

        self.assertTrue(second_entered.is_set())
        self.assertEqual(self.fence.active_key_count, 0)

    def test_different_task_keys_can_enter_in_parallel(self) -> None:
        first_entered = threading.Event()
        release = threading.Event()

        def first() -> None:
            with self.fence.hold(**self.key):
                first_entered.set()
                release.wait(timeout=2)

        thread = threading.Thread(target=first)
        thread.start()
        self.assertTrue(first_entered.wait(timeout=2))
        started = time.monotonic()
        with self.fence.hold(project_id=7, user_id=11, task_key='train:52'):
            elapsed = time.monotonic() - started
        release.set()
        thread.join(timeout=2)

        self.assertLess(elapsed, 0.5)
        self.assertEqual(self.fence.active_key_count, 0)

    def test_same_thread_can_reenter_identical_key(self) -> None:
        with self.fence.hold(**self.key):
            self.assertEqual(self.fence.reference_count(**self.key), 1)
            with self.fence.hold(**self.key):
                self.assertEqual(self.fence.reference_count(**self.key), 2)
            self.assertEqual(self.fence.reference_count(**self.key), 1)
        self.assertEqual(self.fence.active_key_count, 0)

    def test_exception_does_not_leak_entry(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'boom'):
            with self.fence.hold(**self.key):
                raise RuntimeError('boom')
        self.assertEqual(self.fence.active_key_count, 0)

    def test_binding_registry_requires_identical_finalizer_fence(self) -> None:
        registry = ProjectMutationBindingRegistry()
        finalizer = SimpleNamespace(
            fence=self.fence,
            preflight_draft_result=lambda **kwargs: (),
            finalize_inserted=lambda **kwargs: None,
        )
        binding = registry.register(project_id=7, fence=self.fence, finalizer=finalizer)
        self.assertIs(registry.get(7), binding)
        self.assertIs(registry.register(project_id=7, fence=self.fence, finalizer=finalizer), binding)

        with self.assertRaisesRegex(DraftTransitionFenceError, 'identical'):
            registry.register(
                project_id=8,
                fence=self.fence,
                finalizer=SimpleNamespace(
                    fence=DraftTransitionFence(),
                    preflight_draft_result=lambda **kwargs: (),
                    finalize_inserted=lambda **kwargs: None,
                ),
            )
        registry.unregister(7, expected=binding)
        self.assertIsNone(registry.get(7))


class SqliteDraftTransitionInterleavingTestCase(TransactionTestCase):
    """Exercise both transition orders over independent SQLite connections."""

    reset_sequences = True

    def setUp(self) -> None:
        self.assertEqual(connection.vendor, 'sqlite')
        self.assertNotIn('memory', str(connection.settings_dict['NAME']).lower())
        self.temporary = tempfile.TemporaryDirectory()
        self.image_root = Path(self.temporary.name) / 'images'
        (self.image_root / 'train2017').mkdir(parents=True)
        self.image_id = 71
        Image.new('RGB', (640, 480), color='black').save(
            self.image_root / 'train2017' / f'{self.image_id:012d}.jpg',
            format='JPEG',
        )
        self.user = _user('roi-interleaving@example.test')
        organization = Organization.objects.create(title='ROI interleaving', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=organization)
        self.user.active_organization = organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='COCO train',
            organization=organization,
            created_by=self.user,
            is_published=True,
        )
        store = _FakeStore(split='train', row=_row(self.image_id))
        profiles = _Profiles()
        targets = DjangoRoiTargetCatalog(
            {
                self.project.pk: DjangoRoiProjectBinding(
                    project_pk=self.project.pk,
                    split='train',
                    store=store,
                    image_root=self.image_root,
                    profiles=profiles,
                )
            }
        )
        self.task = Task.objects.create(
            project=self.project,
            data={
                'image': f'/data/local-files/?d=train2017/{self.image_id:012d}.jpg',
                'coordexp_task_key': f'train:{self.image_id}',
                'split': 'train',
                'image_id': self.image_id,
                'source_line': 1,
            },
        )
        self.annotation = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.user,
            result=_result(self.image_id),
        )
        self.draft = AnnotationDraft.objects.create(
            task=self.task,
            annotation=self.annotation,
            user=self.user,
            result=_result(self.image_id),
        )
        with targets.capture(
            user=self.user,
            project_pk=self.project.pk,
            task_pk=self.task.pk,
            request_id=str(uuid4()),
            roi={'x': 0, 'y': 0, 'width': 100, 'height': 100},
            resolution={'width': 1024, 'height': 1024},
            profile_selector='accepted',
        ) as captured:
            self.target = captured.target
            transform = captured.transform
        self.result_id = f'{self.target.request_id}:result-0'
        self.region_key = f'roi:{self.target.request_id}:1'
        self.receipts = InferenceReceiptStore(Path(self.temporary.name) / 'receipts.jsonl')
        self.receipt_id = _append_real_produced_receipt(
            store=self.receipts,
            target=self.target,
            transform=transform,
            result_id=self.result_id,
            region_key=self.region_key,
        )
        self.fence = DraftTransitionFence()
        self.finalizer = DjangoRoiFinalizer(targets=targets, receipt_store=self.receipts, fence=self.fence)
        self.linked_result = _result(self.image_id) + [_inference_result(self)]
        self.mutation_binding = project_mutation_bindings.register(
            project_id=self.project.pk,
            fence=self.fence,
            finalizer=self.finalizer,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self) -> None:
        project_mutation_bindings.unregister(self.project.pk, expected=self.mutation_binding)
        self.temporary.cleanup()
        super().tearDown()

    def _thread_user(self):
        return get_user_model().objects.get(pk=self.user.pk)

    def test_save_first_forces_inserted_and_later_abandonment_rejects(self) -> None:
        saved = threading.Event()
        release_save = threading.Event()
        abandon_started = threading.Event()
        errors: list[tuple[str, BaseException]] = []
        connection_ids: list[int] = []

        def save() -> None:
            close_old_connections()
            try:
                user = self._thread_user()
                connection.ensure_connection()
                connection_ids.append(id(connection.connection))
                with self.fence.hold(
                    project_id=self.project.pk,
                    user_id=self.user.pk,
                    task_key=f'train:{self.image_id}',
                ):
                    plan = self.finalizer.preflight_draft_result(
                        user=user,
                        project_id=self.project.pk,
                        task_key=f'train:{self.image_id}',
                        draft_id=self.draft.pk,
                        annotation_id=self.annotation.pk,
                        result=self.linked_result,
                    )
                    self.assertEqual(plan.produced_receipt_ids, (self.receipt_id,))
                    AnnotationDraft.objects.filter(pk=self.draft.pk).update(
                        result=self.linked_result,
                        updated_at=self.draft.updated_at + timedelta(seconds=1),
                    )
                    saved.set()
                    self.assertTrue(release_save.wait(timeout=5))
                    self.finalizer.finalize_inserted(user=user, receipt_id_or_request_id=self.receipt_id)
            except BaseException as exc:  # pragma: no cover - asserted below
                errors.append(('save', exc))
            finally:
                close_old_connections()

        def abandon() -> None:
            self.assertTrue(saved.wait(timeout=5))
            close_old_connections()
            try:
                user = self._thread_user()
                connection.ensure_connection()
                connection_ids.append(id(connection.connection))
                abandon_started.set()
                self.finalizer.finalize_abandoned(
                    user=user,
                    receipt_id_or_request_id=self.receipt_id,
                    reason='target_changed',
                )
            except BaseException as exc:
                errors.append(('abandon', exc))
            finally:
                close_old_connections()

        save_thread = threading.Thread(target=save)
        abandon_thread = threading.Thread(target=abandon)
        save_thread.start()
        abandon_thread.start()
        self.assertTrue(abandon_started.wait(timeout=5))
        release_save.set()
        save_thread.join(timeout=5)
        abandon_thread.join(timeout=5)

        self.assertFalse(save_thread.is_alive())
        self.assertFalse(abandon_thread.is_alive())
        self.assertEqual([label for label, _ in errors], ['abandon'])
        self.assertIsInstance(errors[0][1], DjangoRoiFinalizationError)
        self.assertEqual(len(set(connection_ids)), 2)
        self.assertEqual(self.receipts.disposition(self.receipt_id)['disposition'], 'inserted')
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, self.linked_result)
        self.assertEqual(self.fence.active_key_count, 0)

    def test_abandonment_first_forces_later_save_preflight_to_reject(self) -> None:
        abandoned = threading.Event()
        save_started = threading.Event()
        errors: list[tuple[str, BaseException]] = []
        connection_ids: list[int] = []

        def abandon() -> None:
            close_old_connections()
            try:
                user = self._thread_user()
                connection.ensure_connection()
                connection_ids.append(id(connection.connection))
                with self.fence.hold(
                    project_id=self.project.pk,
                    user_id=self.user.pk,
                    task_key=f'train:{self.image_id}',
                ):
                    self.finalizer.finalize_abandoned(
                        user=user,
                        receipt_id_or_request_id=self.receipt_id,
                        reason='target_changed',
                    )
                    abandoned.set()
                    self.assertTrue(save_started.wait(timeout=5))
            except BaseException as exc:  # pragma: no cover - asserted below
                errors.append(('abandon', exc))
            finally:
                close_old_connections()

        def save() -> None:
            self.assertTrue(abandoned.wait(timeout=5))
            close_old_connections()
            try:
                user = self._thread_user()
                connection.ensure_connection()
                connection_ids.append(id(connection.connection))
                save_started.set()
                with self.fence.hold(
                    project_id=self.project.pk,
                    user_id=self.user.pk,
                    task_key=f'train:{self.image_id}',
                ):
                    self.finalizer.preflight_draft_result(
                        user=user,
                        project_id=self.project.pk,
                        task_key=f'train:{self.image_id}',
                        draft_id=self.draft.pk,
                        annotation_id=self.annotation.pk,
                        result=self.linked_result,
                    )
                    AnnotationDraft.objects.filter(pk=self.draft.pk).update(result=self.linked_result)
            except BaseException as exc:
                errors.append(('save', exc))
            finally:
                close_old_connections()

        abandon_thread = threading.Thread(target=abandon)
        save_thread = threading.Thread(target=save)
        abandon_thread.start()
        save_thread.start()
        abandon_thread.join(timeout=5)
        save_thread.join(timeout=5)

        self.assertFalse(abandon_thread.is_alive())
        self.assertFalse(save_thread.is_alive())
        self.assertEqual([label for label, _ in errors], ['save'])
        self.assertIsInstance(errors[0][1], DjangoRoiFinalizationError)
        self.assertEqual(len(set(connection_ids)), 2)
        self.assertEqual(self.receipts.disposition(self.receipt_id)['disposition'], 'abandoned')
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, _result(self.image_id))
        self.assertEqual(self.fence.active_key_count, 0)

    def test_external_disposition_then_db_commit_failure_rolls_back_and_exact_retry_reconciles(self) -> None:
        before_result = copy.deepcopy(self.draft.result)
        before_revision = self.draft.updated_at
        annotation_result = copy.deepcopy(self.annotation.result)
        annotation_revision = self.annotation.updated_at
        with patch.object(connection, 'commit', side_effect=DatabaseError('simulated commit failure')):
            failed = self.client.patch(
                f'/api/drafts/{self.draft.pk}/',
                {'result': self.linked_result},
                format='json',
            )

        self.assertEqual(failed.status_code, 503)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, before_result)
        self.assertEqual(self.draft.updated_at, before_revision)
        self.annotation.refresh_from_db()
        self.assertEqual(self.annotation.result, annotation_result)
        self.assertEqual(self.annotation.updated_at, annotation_revision)
        disposition = self.receipts.disposition(self.receipt_id)
        self.assertEqual(disposition['disposition'], 'inserted')
        proof = disposition['proof']

        conflicting_result = copy.deepcopy(self.linked_result)
        conflicting_result[-1]['value']['width'] += 1
        rejected = self.client.patch(
            f'/api/drafts/{self.draft.pk}/',
            {'result': conflicting_result},
            format='json',
        )
        self.assertEqual(rejected.status_code, 409)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, before_result)
        self.assertEqual(self.draft.updated_at, before_revision)
        self.assertEqual(self.receipts.disposition(self.receipt_id), disposition)

        retried = self.client.patch(
            f'/api/drafts/{self.draft.pk}/',
            {'result': self.linked_result},
            format='json',
        )

        self.assertEqual(retried.status_code, 200)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, self.linked_result)
        self.assertEqual(canonical_db_revision(self.draft.updated_at), proof['inserted_draft_revision'])
        self.assertEqual(proof_json_sha256(self.draft.result), proof['saved_full_result_sha256'])
        self.assertEqual(self.receipts.disposition(self.receipt_id), disposition)

    def test_managed_create_commit_failure_returns_503_without_row(self) -> None:
        before_ids = tuple(AnnotationDraft.objects.order_by('pk').values_list('pk', flat=True))
        annotation_result = copy.deepcopy(self.annotation.result)
        annotation_revision = self.annotation.updated_at
        with patch.object(connection, 'commit', side_effect=DatabaseError('simulated commit failure')):
            response = self.client.post(
                f'/api/tasks/{self.task.pk}/drafts',
                {'result': _result(self.image_id)},
                format='json',
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            tuple(AnnotationDraft.objects.order_by('pk').values_list('pk', flat=True)),
            before_ids,
        )
        self.annotation.refresh_from_db()
        self.assertEqual(self.annotation.result, annotation_result)
        self.assertEqual(self.annotation.updated_at, annotation_revision)
        self.assertIsNone(self.receipts.disposition(self.receipt_id))

    def test_managed_delete_commit_failure_returns_503_and_restores_exact_row(self) -> None:
        inserted = self.client.patch(
            f'/api/drafts/{self.draft.pk}/',
            {'result': self.linked_result},
            format='json',
        )
        self.assertEqual(inserted.status_code, 200)
        self.draft.refresh_from_db()
        before_result = copy.deepcopy(self.draft.result)
        before_revision = self.draft.updated_at
        annotation_result = copy.deepcopy(self.annotation.result)
        annotation_revision = self.annotation.updated_at
        disposition = self.receipts.disposition(self.receipt_id)

        with patch.object(connection, 'commit', side_effect=DatabaseError('simulated commit failure')):
            failed = self.client.delete(f'/api/drafts/{self.draft.pk}/')

        self.assertEqual(failed.status_code, 503)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, before_result)
        self.assertEqual(self.draft.updated_at, before_revision)
        self.annotation.refresh_from_db()
        self.assertEqual(self.annotation.result, annotation_result)
        self.assertEqual(self.annotation.updated_at, annotation_revision)
        self.assertEqual(self.receipts.disposition(self.receipt_id), disposition)

        retried = self.client.delete(f'/api/drafts/{self.draft.pk}/')
        self.assertEqual(retried.status_code, 204)
        self.assertFalse(AnnotationDraft.objects.filter(pk=self.draft.pk).exists())


def _append_real_produced_receipt(*, store, target, transform, result_id: str, region_key: str) -> str:
    text = (
        f'{OBJECT_REF_START_TOKEN}person{OBJECT_REF_END_TOKEN}'
        f'{BOX_START_TOKEN}<|coord_400|><|coord_300|><|coord_600|><|coord_700|>{BOX_END_TOKEN}'
    )
    parsed = parse_compact_object_box_closed(
        text,
        row_id=target.request_id,
        row_index=0,
        image_width=transform.canvas_width,
        image_height=transform.canvas_height,
    )
    result = classify_parser_result(
        parse_row=parsed,
        raw_response_text=text,
        target=target,
        transform=transform,
    )
    result = finalize_region_links(
        result,
        CurrentTarget(**target.binding_payload()),
        region_links={result_id: region_key},
    )
    lifecycle = RequestLifecycle().transition(RequestState.RUNNING, at_seconds=1)
    lifecycle = lifecycle.transition(RequestState.PRODUCED, at_seconds=2)
    attempt = InferenceAttemptReceipt(
        target=target,
        lifecycle=lifecycle,
        profile_receipt=_profile_receipt(target),
        transform_receipt=transform.to_receipt_dict(),
        result=result,
    )
    response = {
        'receipt_id': f'roi-receipt:{target.request_id}',
        'request_id': target.request_id,
        'request_state': 'produced',
        'terminal_status': None,
        'clear_roi': False,
        'insertion_payload': result.insertion_payload.to_dict(),
        'failure': None,
        'counts': {'parsed': 1, 'produced': 1, 'rejected': 0},
    }
    execution = {
        'schema_version': 'coordexp-resident-roi-execution-v1',
        'canonical_profile_fingerprint': target.profile_fingerprint,
        'resident_profile': None,
        'canvas': {
            'mode': 'RGB',
            'width': transform.canvas_width,
            'height': transform.canvas_height,
            'sha256': 'b' * 64,
        },
        'decode': {
            'backend': 'hf',
            'backend_mode': 'generate',
            'response_family': 'hf',
            'raw_generated_text': text,
            'raw_generated_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'parser_text': text,
            'parser_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'strip_policy': 'none',
            'stop_reason': 'eos_token',
            'generation_config_fingerprint': 'c' * 64,
            'model_identity_sha256': 'd' * 64,
            'tokenizer_identity_sha256': 'e' * 64,
        },
        'parse': {'row_index': 0},
        'cancellation': None,
        'cuda': None,
    }
    return store.append(attempt=attempt, execution=execution, response=response)


def _profile_receipt(target) -> dict[str, Any]:
    return {
        'schema_version': 'coordexp-roi-engine-profile-v1',
        'profile_name': 'test-profile',
        'profile_fingerprint': target.profile_fingerprint,
        'endpoint': 'http://127.0.0.1:8123/infer',
        'artifacts': [
            {
                'role': role,
                'kind': 'file',
                'sha256': chr(ord('b') + index) * 64,
                'file_count': 1,
                'total_bytes': 1,
            }
            for index, role in enumerate(('base_weights', 'model_config', 'processor', 'tokenizer'))
        ],
        'identity_fingerprints': {
            field: 'f' * 64
            for field in (
                'resolved_config',
                'prompt_policy',
                'parser',
                'adapter',
                'transform',
                'transformers',
                'processor_kwargs',
                'runtime',
            )
        },
        'processor': {
            'factor': 32,
            'default_canvas': [1024, 1024],
            'axis_bounds': [32, 2048],
            'max_total_pixels': 2_097_152,
            'do_resize': False,
        },
        'deadline_seconds': 20.0,
    }

from __future__ import annotations

import copy
import tempfile
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from coordexp_refinement.roi_finalization import (
    DjangoRoiFinalizationError,
    DjangoRoiFinalizer,
)
from coordexp_refinement.roi_targets import (
    DjangoRoiProjectBinding,
    DjangoRoiTargetCatalog,
    canonical_db_revision,
    proof_json_sha256,
)
from coordexp_refinement.transition_fence import project_mutation_bindings
from django.db import transaction
from django.test import TestCase
from organizations.models import Organization, OrganizationMember
from PIL import Image
from projects.models import Project
from rest_framework.test import APIClient
from src.label_studio_coco_refinement.geometry import (
    norm1000_bbox_to_label_studio_xywh,
)
from src.label_studio_coco_refinement.inference_results import (
    AuthoritativeAbandonmentProof,
    AuthoritativeInsertionProof,
)
from tasks.models import Annotation, AnnotationDraft, Task
from tasks.serializers import AnnotationDraftSerializer

from .test_roi_targets import _FakeStore, _Profiles, _result, _row, _user


class _ReceiptStore:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.requests: dict[str, str] = {}
        self.dispositions: dict[str, tuple[str, dict[str, Any]]] = {}
        self.finalize_atomic: list[bool] = []
        self.fail_next_inserted = False
        self.fail_after_inserted = False
        self.fail_after_abandoned = False

    def add_produced(self, target, *, mappings: list[tuple[str, str]]) -> str:
        receipt_id = f'roi-receipt:{target.request_id}'
        regions = [{'result_id': result_id, 'region_key': region_key} for result_id, region_key in mappings]
        record = {
            'record_kind': 'attempt',
            'receipt_id': receipt_id,
            'request_id': target.request_id,
            'attempt': {
                'request_state': 'produced',
                'request': target.to_receipt_dict(),
            },
            'response': {
                'insertion_payload': {
                    'target': target.to_receipt_dict(),
                    'mode': 'append_one_undo_action',
                    'regions': regions,
                }
            },
        }
        self.records[receipt_id] = record
        self.requests[target.request_id] = receipt_id
        return receipt_id

    def get(self, receipt_id: str):
        value = self.records.get(receipt_id)
        return None if value is None else copy.deepcopy(value)

    def by_request(self, request_id: str):
        receipt_id = self.requests.get(request_id)
        return None if receipt_id is None else self.get(receipt_id)

    def disposition(self, receipt_id: str):
        value = self.dispositions.get(receipt_id)
        if value is None:
            return None
        kind, proof = value
        return {
            'record_kind': 'disposition',
            'receipt_id': receipt_id,
            'request_id': proof['request_id'],
            'disposition': kind,
            'proof': copy.deepcopy(proof),
        }

    def replay(self):
        records = [copy.deepcopy(record) for record in self.records.values()]
        records.extend(
            {
                'record_kind': 'disposition',
                'receipt_id': receipt_id,
                'request_id': proof['request_id'],
                'disposition': kind,
                'proof': copy.deepcopy(proof),
            }
            for receipt_id, (kind, proof) in self.dispositions.items()
        )
        return tuple(records)

    def finalize_inserted(self, proof: AuthoritativeInsertionProof) -> str:
        self.finalize_atomic.append(transaction.get_connection().in_atomic_block)
        if self.fail_next_inserted:
            self.fail_next_inserted = False
            raise OSError('simulated append failure')
        result = self._finalize('inserted', proof.receipt_id, proof.to_dict())
        if self.fail_after_inserted:
            self.fail_after_inserted = False
            raise OSError('simulated post-append failure')
        return result

    def finalize_abandoned(self, proof: AuthoritativeAbandonmentProof) -> str:
        self.finalize_atomic.append(transaction.get_connection().in_atomic_block)
        result = self._finalize('abandoned', proof.receipt_id, proof.to_dict())
        if self.fail_after_abandoned:
            self.fail_after_abandoned = False
            raise OSError('simulated post-append failure')
        return result

    def _finalize(self, kind: str, receipt_id: str, proof: dict[str, Any]) -> str:
        prior = self.dispositions.get(receipt_id)
        candidate = (kind, copy.deepcopy(proof))
        if prior is not None and proof_json_sha256(prior) != proof_json_sha256(candidate):
            raise RuntimeError('receipt disposition conflicts')
        self.dispositions[receipt_id] = candidate
        return receipt_id


class RoiFinalizationTestCase(TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.image_root = Path(self.temporary.name) / 'images'
        (self.image_root / 'train2017').mkdir(parents=True)
        self.image_id = 51
        Image.new('RGB', (640, 480), color='black').save(
            self.image_root / 'train2017' / f'{self.image_id:012d}.jpg',
            format='JPEG',
        )
        self.user = _user('roi-finalizer@example.test')
        organization = Organization.objects.create(title='ROI finalization', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=organization)
        self.user.active_organization = organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='COCO train',
            organization=organization,
            created_by=self.user,
            is_published=True,
        )
        self.store = _FakeStore(split='train', row=_row(self.image_id))
        self.profiles = _Profiles()
        binding = DjangoRoiProjectBinding(
            project_pk=self.project.pk,
            split='train',
            store=self.store,
            image_root=self.image_root,
            profiles=self.profiles,
        )
        self.targets = DjangoRoiTargetCatalog({self.project.pk: binding})
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
        with self.targets.capture(
            user=self.user,
            project_pk=self.project.pk,
            task_pk=self.task.pk,
            request_id=str(uuid4()),
            roi={'x': 0, 'y': 0, 'width': 100, 'height': 100},
            resolution={'width': 1024, 'height': 1024},
            profile_selector='accepted',
        ) as captured:
            self.target = captured.target
        self.result_id = f'{self.target.request_id}:result-0'
        self.region_key = f'roi:{self.target.request_id}:1'
        self.receipts = _ReceiptStore()
        self.receipt_id = self.receipts.add_produced(self.target, mappings=[(self.result_id, self.region_key)])
        self.finalizer = DjangoRoiFinalizer(
            targets=self.targets,
            receipt_store=self.receipts,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self) -> None:
        project_mutation_bindings.unregister(self.project.pk)
        self.temporary.cleanup()
        super().tearDown()

    def _persist_inserted(self, *, result: list[dict[str, Any]] | None = None) -> None:
        source = self.draft.updated_at
        AnnotationDraft.objects.filter(pk=self.draft.pk).update(
            result=(_result(self.image_id) + [_inference_result(self)] if result is None else result),
            updated_at=source + timedelta(seconds=1),
        )
        self.draft.refresh_from_db()

    def test_inserted_proof_is_recomputed_under_locks_and_idempotent(self) -> None:
        self._persist_inserted()
        result_before = copy.deepcopy(self.draft.result)
        revision_before = canonical_db_revision(self.draft.updated_at)
        annotation_before = canonical_db_revision(self.annotation.updated_at)

        first = self.finalizer.finalize_inserted(
            user=self.user,
            receipt_id_or_request_id=self.receipt_id,
        )
        second = self.finalizer.finalize_inserted(
            user=self.user,
            receipt_id_or_request_id=self.target.request_id,
        )

        self.assertEqual(first, self.receipt_id)
        self.assertEqual(second, self.receipt_id)
        self.assertEqual(self.receipts.finalize_atomic, [True, True])
        kind, raw_proof = self.receipts.dispositions[self.receipt_id]
        self.assertEqual(kind, 'inserted')
        proof = AuthoritativeInsertionProof(**raw_proof)
        self.assertEqual(proof.result_region_keys, {self.result_id: self.region_key})
        self.assertEqual(proof.source_draft_revision, self.target.draft_revision)
        self.assertEqual(proof.inserted_draft_revision, revision_before)
        self.assertEqual(proof.inserted_draft_updated_at, revision_before)
        self.assertEqual(proof.observed_annotation_revision, annotation_before)
        self.assertEqual(proof.saved_full_result_sha256, proof_json_sha256(result_before))
        self.draft.refresh_from_db()
        self.annotation.refresh_from_db()
        self.assertEqual(self.draft.result, result_before)
        self.assertEqual(canonical_db_revision(self.draft.updated_at), revision_before)
        self.assertEqual(canonical_db_revision(self.annotation.updated_at), annotation_before)
        self.assertEqual(self.finalizer.fence.active_key_count, 0)

    def test_preflight_resolves_produced_inserted_and_abandoned_dispositions(self) -> None:
        linked = _result(self.image_id) + [_inference_result(self)]
        produced = self.finalizer.preflight_draft_result(
            user=self.user,
            project_id=self.project.pk,
            task_key=f'train:{self.image_id}',
            draft_id=self.draft.pk,
            annotation_id=self.annotation.pk,
            result=linked,
        )
        self.assertEqual(produced.produced_receipt_ids, (self.receipt_id,))
        self.assertEqual(produced.inserted_receipt_ids, ())

        self._persist_inserted(result=linked)
        self.finalizer.finalize_inserted(user=self.user, receipt_id_or_request_id=self.receipt_id)
        inserted = self.finalizer.preflight_draft_result(
            user=self.user,
            project_id=self.project.pk,
            task_key=f'train:{self.image_id}',
            draft_id=self.draft.pk,
            annotation_id=self.annotation.pk,
            result=linked,
        )
        self.assertEqual(inserted.produced_receipt_ids, ())
        self.assertEqual(inserted.inserted_receipt_ids, (self.receipt_id,))

        kind, proof = self.receipts.dispositions[self.receipt_id]
        self.receipts.dispositions[self.receipt_id] = ('abandoned', proof)
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'abandoned'):
            self.finalizer.preflight_draft_result(
                user=self.user,
                project_id=self.project.pk,
                task_key=f'train:{self.image_id}',
                draft_id=self.draft.pk,
                annotation_id=self.annotation.pk,
                result=linked,
            )
        self.receipts.dispositions[self.receipt_id] = (kind, proof)

    def test_preflight_rejects_unknown_partial_and_server_target_mismatch(self) -> None:
        pristine = _result(self.image_id) + [_inference_result(self)]
        cases = []
        unknown = copy.deepcopy(pristine)
        unknown[-1]['meta']['coordexp_inference_receipt_id'] = 'roi-receipt:unknown'
        cases.append(('unknown', unknown, {}))
        partial = copy.deepcopy(pristine)
        del partial[-1]['meta']['coordexp_inference_result_id']
        cases.append(('partial', partial, {}))
        cases.append(('task', pristine, {'task_key': 'train:999'}))
        cases.append(('user', pristine, {'user': _user('preflight-other@example.test')}))
        for label, result, overrides in cases:
            with self.subTest(label=label), self.assertRaises(DjangoRoiFinalizationError):
                self.finalizer.preflight_draft_result(
                    user=overrides.get('user', self.user),
                    project_id=self.project.pk,
                    task_key=overrides.get('task_key', f'train:{self.image_id}'),
                    draft_id=self.draft.pk,
                    annotation_id=self.annotation.pk,
                    result=result,
                )

        pristine_record = copy.deepcopy(self.receipts.records[self.receipt_id])
        self.receipts.records[self.receipt_id]['attempt']['request']['image_id'] = '999'
        self.receipts.records[self.receipt_id]['response']['insertion_payload']['target']['image_id'] = '999'
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'immutable target'):
            self.finalizer.preflight_draft_result(
                user=self.user,
                project_id=self.project.pk,
                task_key=f'train:{self.image_id}',
                draft_id=self.draft.pk,
                annotation_id=self.annotation.pk,
                result=pristine,
            )
        self.receipts.records[self.receipt_id] = pristine_record

    def test_managed_patch_finalizes_and_retry_after_append_failure(self) -> None:
        binding = project_mutation_bindings.register(
            project_id=self.project.pk,
            fence=self.finalizer.fence,
            finalizer=self.finalizer,
        )
        result = _result(self.image_id) + [_inference_result(self)]
        before_result = copy.deepcopy(self.draft.result)
        before_revision = self.draft.updated_at
        annotation_result = copy.deepcopy(self.annotation.result)
        annotation_revision = self.annotation.updated_at
        self.receipts.fail_next_inserted = True
        failed = self.client.patch(f'/api/drafts/{self.draft.pk}/', {'result': result}, format='json')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(
            failed.json(),
            {
                'error': {
                    'code': 'coordexp_draft_finalization_unavailable',
                    'detail': 'Managed Draft finalization is temporarily unavailable.',
                }
            },
        )
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, before_result)
        self.assertEqual(self.draft.updated_at, before_revision)
        self.annotation.refresh_from_db()
        self.assertEqual(self.annotation.result, annotation_result)
        self.assertEqual(self.annotation.updated_at, annotation_revision)
        self.assertNotIn(self.receipt_id, self.receipts.dispositions)

        retried = self.client.patch(f'/api/drafts/{self.draft.pk}/', {'result': result}, format='json')
        self.assertEqual(retried.status_code, 200)
        self.assertEqual(self.receipts.dispositions[self.receipt_id][0], 'inserted')
        self.assertEqual(self.finalizer.fence.active_key_count, 0)
        project_mutation_bindings.unregister(self.project.pk, expected=binding)

    def test_post_append_exception_is_confirmed_durable_and_commits_once(self) -> None:
        project_mutation_bindings.register(
            project_id=self.project.pk,
            fence=self.finalizer.fence,
            finalizer=self.finalizer,
        )
        result = _result(self.image_id) + [_inference_result(self)]
        self.receipts.fail_after_inserted = True

        response = self.client.patch(f'/api/drafts/{self.draft.pk}/', {'result': result}, format='json')

        self.assertEqual(response.status_code, 200)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, result)
        self.assertEqual(self.receipts.dispositions[self.receipt_id][0], 'inserted')

    def test_managed_preflight_409_preserves_result_and_revision(self) -> None:
        project_mutation_bindings.register(
            project_id=self.project.pk,
            fence=self.finalizer.fence,
            finalizer=self.finalizer,
        )
        result = _result(self.image_id) + [_inference_result(self)]
        result[-1]['meta']['coordexp_inference_receipt_id'] = 'roi-receipt:unknown'
        before_result = copy.deepcopy(self.draft.result)
        before_revision = self.draft.updated_at

        response = self.client.patch(f'/api/drafts/{self.draft.pk}/', {'result': result}, format='json')

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                'error': {
                    'code': 'coordexp_draft_transition_conflict',
                    'detail': 'Managed Draft transition rejected.',
                }
            },
        )
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.result, before_result)
        self.assertEqual(self.draft.updated_at, before_revision)

    def test_managed_create_and_inserted_delete_use_native_status_shapes(self) -> None:
        project_mutation_bindings.register(
            project_id=self.project.pk,
            fence=self.finalizer.fence,
            finalizer=self.finalizer,
        )
        result = _result(self.image_id) + [_inference_result(self)]
        patched = self.client.patch(f'/api/drafts/{self.draft.pk}/', {'result': result}, format='json')
        self.assertEqual(patched.status_code, 200)
        deleted = self.client.delete(f'/api/drafts/{self.draft.pk}/')
        self.assertEqual(deleted.status_code, 204)
        self.assertFalse(AnnotationDraft.objects.filter(pk=self.draft.pk).exists())

        created = self.client.post(
            f'/api/tasks/{self.task.pk}/drafts',
            {'result': _result(self.image_id)},
            format='json',
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()['task'], self.task.pk)
        self.assertEqual(created.json()['user'], self.user.email)

    def test_unregistered_draft_create_patch_delete_responses_remain_native(self) -> None:
        created = self.client.post(
            f'/api/tasks/{self.task.pk}/drafts',
            {'result': _result(self.image_id)},
            format='json',
        )
        self.assertEqual(created.status_code, 201)
        created_draft = AnnotationDraft.objects.get(pk=created.json()['id'])
        self.assertEqual(created.json(), dict(AnnotationDraftSerializer(created_draft).data))

        changed = _result(self.image_id) + [_human_result('human:ordinary')]
        response = self.client.patch(f'/api/drafts/{created_draft.pk}/', {'result': changed}, format='json')

        self.assertEqual(response.status_code, 200)
        created_draft.refresh_from_db()
        self.assertEqual(response.json(), dict(AnnotationDraftSerializer(created_draft).data))
        self.assertEqual(created_draft.result, changed)

        deleted = self.client.delete(f'/api/drafts/{created_draft.pk}/')
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(deleted.content, b'')
        self.assertFalse(AnnotationDraft.objects.filter(pk=created_draft.pk).exists())

    def test_same_revision_and_changed_annotation_revision_fail_closed(self) -> None:
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'strictly advance'):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )

        self._persist_inserted()
        Annotation.objects.filter(pk=self.annotation.pk).update(
            updated_at=self.annotation.updated_at + timedelta(seconds=1)
        )
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'annotation revision'):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )

    def test_missing_duplicate_and_wrong_linkage_each_fail_closed(self) -> None:
        cases = ('missing', 'duplicate', 'wrong_link')
        for case in cases:
            with self.subTest(case=case):
                base = _result(self.image_id)
                inserted = _inference_result(self)
                if case == 'missing':
                    result = base
                elif case == 'duplicate':
                    result = base + [inserted, copy.deepcopy(inserted)]
                else:
                    inserted['meta']['coordexp_inference_result_id'] = 'wrong'
                    result = base + [inserted]
                self._persist_inserted(result=result)
                with self.assertRaises(DjangoRoiFinalizationError):
                    self.finalizer.finalize_inserted(
                        user=self.user,
                        receipt_id_or_request_id=self.receipt_id,
                    )

    def test_duplicate_or_missing_planned_mapping_fails_before_database_mutation(self) -> None:
        original = copy.deepcopy(self.receipts.records[self.receipt_id])
        regions = original['response']['insertion_payload']['regions']
        duplicate = copy.deepcopy(regions[0])
        duplicate['result_id'] = f'{self.target.request_id}:result-1'
        regions.append(duplicate)
        self.receipts.records[self.receipt_id] = original
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'not unique'):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )
        self.assertEqual(self.draft.result, _result(self.image_id))

        self.receipts.records[self.receipt_id]['response']['insertion_payload']['regions'] = []
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'no planned'):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )

    def test_wrong_principal_task_annotation_or_draft_identity_fails_closed(self) -> None:
        other = _user('roi-finalizer-other@example.test')
        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'principal'):
            self.finalizer.finalize_inserted(
                user=other,
                receipt_id_or_request_id=self.receipt_id,
            )

        pristine = copy.deepcopy(self.receipts.records[self.receipt_id])
        for field, value in (
            ('project_id', str(self.project.pk + 999)),
            ('task_id', 'train:999'),
            ('annotation_id', str(self.annotation.pk + 999)),
            ('draft_id', str(self.draft.pk + 999)),
        ):
            with self.subTest(field=field):
                record = copy.deepcopy(pristine)
                record['attempt']['request'][field] = value
                record['response']['insertion_payload']['target'][field] = value
                self.receipts.records[self.receipt_id] = record
                with self.assertRaises(DjangoRoiFinalizationError):
                    self.finalizer.finalize_inserted(
                        user=self.user,
                        receipt_id_or_request_id=self.receipt_id,
                    )
                self.receipts.records[self.receipt_id] = copy.deepcopy(pristine)

    def test_noncanonical_equivalent_source_timestamp_is_rejected(self) -> None:
        record = self.receipts.records[self.receipt_id]
        noncanonical = self.target.draft_revision.replace('Z', '+00:00')
        record['attempt']['request']['draft_revision'] = noncanonical
        record['response']['insertion_payload']['target']['draft_revision'] = noncanonical
        self._persist_inserted()

        with self.assertRaisesRegex(DjangoRoiFinalizationError, 'canonical UTC'):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )

    def test_abandonment_needs_no_draft_advance_and_conflicting_disposition_fails(self) -> None:
        first = self.finalizer.finalize_abandoned(
            user=self.user,
            receipt_id_or_request_id=self.target.request_id,
            reason='target_changed',
        )
        second = self.finalizer.finalize_abandoned(
            user=self.user,
            receipt_id_or_request_id=self.receipt_id,
            reason='target_changed',
        )
        self.assertEqual(first, self.receipt_id)
        self.assertEqual(second, self.receipt_id)
        self.assertEqual(self.receipts.finalize_atomic, [True, True])
        kind, proof = self.receipts.dispositions[self.receipt_id]
        self.assertEqual(kind, 'abandoned')
        self.assertEqual(proof['source_draft_revision'], self.target.draft_revision)

        self._persist_inserted()
        with self.assertRaises(DjangoRoiFinalizationError):
            self.finalizer.finalize_inserted(
                user=self.user,
                receipt_id_or_request_id=self.receipt_id,
            )

    def test_abandonment_post_append_exception_is_confirmed_durable(self) -> None:
        self.receipts.fail_after_abandoned = True

        receipt_id = self.finalizer.finalize_abandoned(
            user=self.user,
            receipt_id_or_request_id=self.receipt_id,
            reason='target_changed',
        )

        self.assertEqual(receipt_id, self.receipt_id)
        self.assertEqual(self.receipts.dispositions[self.receipt_id][0], 'abandoned')
        self.assertEqual(self.receipts.finalize_atomic, [True])

    def test_abandonment_rejects_exact_or_duplicate_planned_insertion_linkage(self) -> None:
        exact = _inference_result(self)
        for label, result in (
            ('exact', _result(self.image_id) + [exact]),
            (
                'duplicate',
                _result(self.image_id) + [exact, copy.deepcopy(exact)],
            ),
        ):
            with self.subTest(label=label):
                self._persist_inserted(result=copy.deepcopy(result))
                with self.assertRaisesRegex(
                    DjangoRoiFinalizationError,
                    'zero planned insertion linkage',
                ):
                    self.finalizer.finalize_abandoned(
                        user=self.user,
                        receipt_id_or_request_id=self.receipt_id,
                        reason='target_changed',
                    )
                self.assertEqual(self.receipts.dispositions, {})

    def test_abandonment_rejects_partial_and_conflicting_planned_linkage(self) -> None:
        partial = _human_result('human:partial')
        partial['meta']['coordexp_inference_receipt_id'] = self.receipt_id
        conflicting = _inference_result(self)
        conflicting['meta'].update(
            {
                'coordexp_inference_receipt_id': 'roi-receipt:different',
                'coordexp_inference_request_id': 'different-request',
                'coordexp_inference_result_id': 'different-result',
                'coordexp_inference_source_draft_revision': 'different-revision',
            }
        )
        for label, result in (
            ('partial', _result(self.image_id) + [partial]),
            ('conflicting', _result(self.image_id) + [conflicting]),
        ):
            with self.subTest(label=label):
                self._persist_inserted(result=copy.deepcopy(result))
                with self.assertRaisesRegex(
                    DjangoRoiFinalizationError,
                    'zero planned insertion linkage',
                ):
                    self.finalizer.finalize_abandoned(
                        user=self.user,
                        receipt_id_or_request_id=self.receipt_id,
                        reason='target_changed',
                    )
                self.assertEqual(self.receipts.dispositions, {})


def _inference_result(case: RoiFinalizationTestCase) -> dict[str, Any]:
    x, y, width, height = norm1000_bbox_to_label_studio_xywh((400, 300, 600, 700))
    return {
        'id': case.region_key,
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
            'coordexp_region_key': case.region_key,
            'coordexp_inference_receipt_id': case.receipt_id,
            'coordexp_inference_request_id': case.target.request_id,
            'coordexp_inference_result_id': case.result_id,
            'coordexp_inference_source_draft_revision': (case.target.draft_revision),
        },
    }


def _human_result(region_key: str) -> dict[str, Any]:
    x, y, width, height = norm1000_bbox_to_label_studio_xywh((400, 300, 600, 700))
    return {
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
        'meta': {'coordexp_region_key': region_key},
    }

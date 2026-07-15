"""Authoritative receipt finalization from locked persisted Draft bytes."""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from django.db import transaction
from src.label_studio_coco_refinement.draft_adapter import (
    canonicalize_label_studio_draft,
)
from src.label_studio_coco_refinement.inference_results import (
    AuthoritativeAbandonmentProof,
    AuthoritativeInsertionProof,
    RequestTarget,
)

from .roi_targets import (
    DjangoRoiTargetCatalog,
    DjangoRoiTargetError,
    _lock_roi_state,
    canonical_db_revision,
    parse_canonical_revision,
    proof_json_sha256,
)
from .transition_fence import DraftTransitionFence, draft_transition_fence


class DjangoRoiFinalizationError(RuntimeError):
    """A browser insertion cannot be authoritatively linked to its receipt."""


@dataclass(frozen=True)
class _ProducedPlan:
    receipt_id: str
    request_id: str
    target: RequestTarget
    result_region_keys: Mapping[str, str]


@dataclass(frozen=True)
class DraftPersistencePlan:
    """Exact receipt work and optional external-first reconciliation revision."""

    produced_receipt_ids: tuple[str, ...]
    inserted_receipt_ids: tuple[str, ...]
    reconcile_draft_revision: str | None = None


@dataclass(frozen=True)
class _PreflightServerState:
    draft_revision: str
    full_result: list[dict[str, Any]]
    semantic_result: list[dict[str, Any]]


class DjangoRoiFinalizer:
    """Finalize only proofs recomputed from server-owned rows and receipt data."""

    def __init__(
        self,
        *,
        targets: DjangoRoiTargetCatalog,
        receipt_store: Any,
        fence: DraftTransitionFence | None = None,
    ) -> None:
        if not isinstance(targets, DjangoRoiTargetCatalog):
            raise DjangoRoiFinalizationError('targets must be a Django ROI catalog')
        for method in (
            'get',
            'by_request',
            'disposition',
            'replay',
            'finalize_inserted',
            'finalize_abandoned',
        ):
            if not callable(getattr(receipt_store, method, None)):
                raise DjangoRoiFinalizationError(f'receipt store must provide {method}()')
        self.targets = targets
        self.receipt_store = receipt_store
        self.fence = draft_transition_fence if fence is None else fence
        if not isinstance(self.fence, DraftTransitionFence):
            raise DjangoRoiFinalizationError('fence must be a DraftTransitionFence')

    def preflight_draft_result(
        self,
        *,
        user: Any,
        project_id: int,
        task_key: str,
        draft_id: int | None,
        annotation_id: int | None,
        result: Any,
    ) -> DraftPersistencePlan:
        """Resolve every browser linkage against durable server-owned authority."""

        user_pk = _principal_pk(user)
        project_pk = _canonical_pk(project_id, field='project id')
        task_key = _normalized_text(task_key, field='task key')
        draft_pk = None if draft_id is None else _canonical_pk(draft_id, field='draft id')
        annotation_pk = None if annotation_id is None else _canonical_pk(annotation_id, field='annotation id')
        full_result = _strict_result_copy(result)
        linked: dict[str, list[tuple[str, str]]] = {}
        plans: dict[str, _ProducedPlan] = {}
        linkage_fields = (
            'coordexp_inference_receipt_id',
            'coordexp_inference_request_id',
            'coordexp_inference_result_id',
            'coordexp_inference_source_draft_revision',
        )
        try:
            for ordinal, item in enumerate(full_result):
                meta = item.get('meta')
                if not isinstance(meta, Mapping):
                    continue
                values = {field: meta.get(field) for field in linkage_fields}
                if not any(field in meta for field in linkage_fields):
                    continue
                if any(field not in meta or value is None for field, value in values.items()):
                    raise DjangoRoiFinalizationError('inference linkage metadata is incomplete')
                normalized = {field: _normalized_text(value, field=field) for field, value in values.items()}
                receipt_id = normalized['coordexp_inference_receipt_id']
                plan = plans.setdefault(receipt_id, self._produced_plan(receipt_id))
                target = plan.target
                expected_target = {
                    'project_id': str(project_pk),
                    'task_id': task_key,
                    'current_user_id': str(user_pk),
                    'draft_id': None if draft_pk is None else str(draft_pk),
                    'annotation_id': None if annotation_pk is None else str(annotation_pk),
                }
                observed_target = {
                    'project_id': target.project_id,
                    'task_id': target.task_id,
                    'current_user_id': target.current_user_id,
                    'draft_id': target.draft_id,
                    'annotation_id': target.annotation_id,
                }
                if expected_target != observed_target:
                    raise DjangoRoiFinalizationError('inference receipt target differs from persisted Draft authority')
                result_id = normalized['coordexp_inference_result_id']
                expected_region_key = plan.result_region_keys.get(result_id)
                region_key = meta.get('coordexp_region_key')
                if (
                    expected_region_key is None
                    or item.get('id') != expected_region_key
                    or region_key != expected_region_key
                    or normalized['coordexp_inference_request_id'] != plan.request_id
                    or normalized['coordexp_inference_source_draft_revision'] != target.draft_revision
                ):
                    raise DjangoRoiFinalizationError(f'inference result linkage differs at result[{ordinal}]')
                linked.setdefault(receipt_id, []).append((result_id, expected_region_key))

            produced: list[str] = []
            inserted: list[str] = []
            reconcile_revisions: set[str] = set()
            for receipt_id, hits in sorted(linked.items()):
                plan = plans[receipt_id]
                if len(hits) != len(set(hits)) or dict(hits) != dict(plan.result_region_keys):
                    raise DjangoRoiFinalizationError('inference receipt linkage is partial or duplicated')
                server = self._preflight_server_authority(user_pk=user_pk, plan=plan)
                disposition = self.receipt_store.disposition(receipt_id)
                if disposition is None:
                    if server.draft_revision != plan.target.draft_revision:
                        _verify_exact_planned_regions(
                            full_result=server.full_result,
                            semantic_result=server.semantic_result,
                            plan=plan,
                        )
                    produced.append(receipt_id)
                    continue
                disposition_kind, proof = _strict_disposition(disposition, plan=plan)
                if disposition_kind == 'inserted':
                    inserted.append(receipt_id)
                    revision = _inserted_reconciliation_revision(
                        plan=plan,
                        proof=proof,
                        server=server,
                        incoming_full_result_sha256=proof_json_sha256(full_result),
                    )
                    if revision is not None:
                        reconcile_revisions.add(revision)
                    continue
                if disposition_kind == 'abandoned':
                    raise DjangoRoiFinalizationError('abandoned inference receipt cannot remain linked')
                raise DjangoRoiFinalizationError('durable receipt disposition is unsupported')

            if draft_pk is not None:
                self._reject_unlinked_external_first_insertions(
                    user_pk=user_pk,
                    project_pk=project_pk,
                    task_key=task_key,
                    draft_pk=draft_pk,
                    annotation_pk=annotation_pk,
                    incoming_full_result_sha256=proof_json_sha256(full_result),
                    linked_receipts=set(linked),
                )
            if len(reconcile_revisions) > 1:
                raise DjangoRoiFinalizationError('inserted receipts require conflicting Draft revisions')
            return DraftPersistencePlan(
                produced_receipt_ids=tuple(produced),
                inserted_receipt_ids=tuple(inserted),
                reconcile_draft_revision=next(iter(reconcile_revisions), None),
            )
        except DjangoRoiFinalizationError:
            raise
        except Exception as exc:
            raise DjangoRoiFinalizationError('Draft inference linkage preflight failed closed') from exc

    def _preflight_server_authority(self, *, user_pk: int, plan: _ProducedPlan) -> _PreflightServerState:
        target = plan.target
        binding = self.targets.binding_for_project_id(target.project_id)
        draft_pk = _canonical_text_pk(target.draft_id, field='draft_id')
        with transaction.atomic():
            state = _lock_roi_state(binding=binding, user_pk=user_pk, draft_pk=draft_pk)
            _verify_immutable_target(state, target=target)
            if canonical_db_revision(state.annotation.updated_at) != target.annotation_revision:
                raise DjangoRoiFinalizationError('receipt annotation revision differs from server authority')
            saved_full_result = _strict_result_copy(state.draft.result)
            canonical = canonicalize_label_studio_draft(
                saved_full_result,
                split=binding.split,
                image_id=state.image_id,
                image_width=state.width,
                image_height=state.height,
            )
            return _PreflightServerState(
                draft_revision=canonical_db_revision(state.draft.updated_at),
                full_result=saved_full_result,
                semantic_result=canonical.to_json_regions(),
            )

    def _reject_unlinked_external_first_insertions(
        self,
        *,
        user_pk: int,
        project_pk: int,
        task_key: str,
        draft_pk: int,
        annotation_pk: int | None,
        incoming_full_result_sha256: str,
        linked_receipts: set[str],
    ) -> None:
        expected = {
            'project_id': str(project_pk),
            'task_id': task_key,
            'current_user_id': str(user_pk),
            'draft_id': str(draft_pk),
            'annotation_id': None if annotation_pk is None else str(annotation_pk),
        }
        for record in self.receipt_store.replay():
            if not isinstance(record, Mapping) or record.get('record_kind') != 'disposition':
                continue
            proof = record.get('proof')
            if not isinstance(proof, Mapping) or proof.get('draft_id') != str(draft_pk):
                continue
            observed = {field: proof.get(field) for field in expected}
            if observed != expected:
                raise DjangoRoiFinalizationError('durable inserted proof differs from Draft authority')
            receipt_id = record.get('receipt_id')
            if record.get('disposition') != 'inserted' or receipt_id in linked_receipts:
                continue
            plan = self._produced_plan(receipt_id)
            server = self._preflight_server_authority(user_pk=user_pk, plan=plan)
            revision = _inserted_reconciliation_revision(
                plan=plan,
                proof=proof,
                server=server,
                incoming_full_result_sha256=incoming_full_result_sha256,
            )
            if revision is not None:
                raise DjangoRoiFinalizationError('external-first insertion requires exact linked retry payload')

    def finalize_inserted(
        self,
        *,
        user: Any,
        receipt_id_or_request_id: str,
    ) -> str:
        """Attest an exact persisted append without modifying the Draft."""

        plan = self._produced_plan(receipt_id_or_request_id)
        user_pk = _principal_pk(user)
        target = plan.target
        if str(user_pk) != target.current_user_id:
            raise DjangoRoiFinalizationError('receipt principal does not match caller')
        project_pk = _canonical_text_pk(target.project_id, field='project_id')
        with self.fence.hold(project_id=project_pk, user_id=user_pk, task_key=target.task_id):
            plan = self._produced_plan(receipt_id_or_request_id)
            target = plan.target
            if str(user_pk) != target.current_user_id or target.project_id != str(project_pk):
                raise DjangoRoiFinalizationError('receipt authority changed before finalization')
            return self._finalize_inserted_locked(user_pk=user_pk, plan=plan)

    def _finalize_inserted_locked(self, *, user_pk: int, plan: _ProducedPlan) -> str:
        target = plan.target
        try:
            binding = self.targets.binding_for_project_id(target.project_id)
            draft_pk = _canonical_text_pk(target.draft_id, field='draft_id')
            with transaction.atomic():
                state = _lock_roi_state(
                    binding=binding,
                    user_pk=user_pk,
                    draft_pk=draft_pk,
                )
                _verify_immutable_target(state, target=target)
                observed_annotation_revision = canonical_db_revision(state.annotation.updated_at)
                if observed_annotation_revision != target.annotation_revision:
                    raise DjangoRoiFinalizationError('authoritative annotation revision changed before insertion')
                source_draft_time = parse_canonical_revision(
                    target.draft_revision,
                    field='source Draft revision',
                )
                inserted_revision = canonical_db_revision(state.draft.updated_at)
                inserted_time = parse_canonical_revision(
                    inserted_revision,
                    field='inserted Draft revision',
                )
                if inserted_time <= source_draft_time:
                    raise DjangoRoiFinalizationError('inserted Draft revision must strictly advance')

                saved_full_result = _strict_result_copy(state.draft.result)
                canonical = canonicalize_label_studio_draft(
                    saved_full_result,
                    split=binding.split,
                    image_id=state.image_id,
                    image_width=state.width,
                    image_height=state.height,
                )
                saved_semantic_result = canonical.to_json_regions()
                _verify_exact_planned_regions(
                    full_result=saved_full_result,
                    semantic_result=saved_semantic_result,
                    plan=plan,
                )
                proof = AuthoritativeInsertionProof(
                    receipt_id=plan.receipt_id,
                    request_id=plan.request_id,
                    project_id=str(state.project.pk),
                    task_id=state.task_key,
                    task_epoch=state.task_epoch,
                    image_id=str(state.image_id),
                    annotation_id=str(state.annotation.pk),
                    source_annotation_revision=target.annotation_revision,
                    observed_annotation_revision=observed_annotation_revision,
                    current_user_id=str(state.user.pk),
                    draft_id=str(state.draft.pk),
                    source_draft_revision=target.draft_revision,
                    inserted_draft_revision=inserted_revision,
                    inserted_draft_updated_at=inserted_revision,
                    result_region_keys=plan.result_region_keys,
                    saved_full_result_sha256=proof_json_sha256(saved_full_result),
                    saved_semantic_result_sha256=proof_json_sha256(saved_semantic_result),
                    saved_full_result=tuple(saved_full_result),
                    saved_semantic_result=tuple(saved_semantic_result),
                )
                # The append-only disposition must become durable while every
                # vendor authority row above remains locked.
                return self._append_disposition_durably(disposition='inserted', proof=proof)
        except DjangoRoiFinalizationError:
            raise
        except DjangoRoiTargetError as exc:
            raise DjangoRoiFinalizationError(str(exc)) from exc
        except Exception as exc:
            if 'proof' in locals() and self._durable_disposition_matches(disposition='inserted', proof=proof):
                return plan.receipt_id
            raise DjangoRoiFinalizationError('authoritative inserted finalization failed closed') from exc

    def finalize_abandoned(
        self,
        *,
        user: Any,
        receipt_id_or_request_id: str,
        reason: str,
    ) -> str:
        """Permanently abandon a produced candidate; Draft advance is irrelevant."""

        plan = self._produced_plan(receipt_id_or_request_id)
        user_pk = _principal_pk(user)
        target = plan.target
        if str(user_pk) != target.current_user_id:
            raise DjangoRoiFinalizationError('receipt principal does not match caller')
        project_pk = _canonical_text_pk(target.project_id, field='project_id')
        with self.fence.hold(project_id=project_pk, user_id=user_pk, task_key=target.task_id):
            plan = self._produced_plan(receipt_id_or_request_id)
            target = plan.target
            if str(user_pk) != target.current_user_id or target.project_id != str(project_pk):
                raise DjangoRoiFinalizationError('receipt authority changed before finalization')
            return self._finalize_abandoned_locked(user_pk=user_pk, plan=plan, reason=reason)

    def _finalize_abandoned_locked(self, *, user_pk: int, plan: _ProducedPlan, reason: str) -> str:
        target = plan.target
        try:
            binding = self.targets.binding_for_project_id(target.project_id)
            draft_pk = _canonical_text_pk(target.draft_id, field='draft_id')
            with transaction.atomic():
                state = _lock_roi_state(
                    binding=binding,
                    user_pk=user_pk,
                    draft_pk=draft_pk,
                )
                _verify_immutable_target(state, target=target)
                saved_full_result = _strict_result_copy(state.draft.result)
                raw_linkage = _planned_linkage_hits(
                    full_result=saved_full_result,
                    semantic_result=(),
                    plan=plan,
                )
                try:
                    canonical = canonicalize_label_studio_draft(
                        saved_full_result,
                        split=binding.split,
                        image_id=state.image_id,
                        image_width=state.width,
                        image_height=state.height,
                    )
                except Exception as exc:
                    if raw_linkage:
                        raise DjangoRoiFinalizationError(
                            'abandonment cannot attest zero planned insertion linkage'
                        ) from exc
                    raise
                semantic_result = canonical.to_json_regions()
                if raw_linkage or _planned_linkage_hits(
                    full_result=(),
                    semantic_result=semantic_result,
                    plan=plan,
                ):
                    raise DjangoRoiFinalizationError('abandonment cannot attest zero planned insertion linkage')
                proof = AuthoritativeAbandonmentProof(
                    receipt_id=plan.receipt_id,
                    request_id=plan.request_id,
                    project_id=str(state.project.pk),
                    task_id=state.task_key,
                    task_epoch=state.task_epoch,
                    image_id=str(state.image_id),
                    annotation_id=str(state.annotation.pk),
                    current_user_id=str(state.user.pk),
                    draft_id=str(state.draft.pk),
                    source_draft_revision=target.draft_revision,
                    reason=reason,
                )
                return self._append_disposition_durably(disposition='abandoned', proof=proof)
        except DjangoRoiFinalizationError:
            raise
        except DjangoRoiTargetError as exc:
            raise DjangoRoiFinalizationError(str(exc)) from exc
        except Exception as exc:
            if 'proof' in locals() and self._durable_disposition_matches(disposition='abandoned', proof=proof):
                return plan.receipt_id
            raise DjangoRoiFinalizationError('authoritative abandonment failed closed') from exc

    def _append_disposition_durably(self, *, disposition: str, proof: Any) -> str:
        method = (
            self.receipt_store.finalize_inserted
            if disposition == 'inserted'
            else self.receipt_store.finalize_abandoned
        )
        try:
            result = method(proof)
        except Exception:
            if self._durable_disposition_matches(disposition=disposition, proof=proof):
                return proof.receipt_id
            raise
        if result == proof.receipt_id:
            return result
        if self._durable_disposition_matches(disposition=disposition, proof=proof):
            return proof.receipt_id
        raise DjangoRoiFinalizationError('receipt store returned a mismatched disposition identity')

    def _durable_disposition_matches(self, *, disposition: str, proof: Any) -> bool:
        try:
            record = self.receipt_store.disposition(proof.receipt_id)
            return (
                isinstance(record, Mapping)
                and record.get('record_kind') == 'disposition'
                and record.get('receipt_id') == proof.receipt_id
                and record.get('request_id') == proof.request_id
                and record.get('disposition') == disposition
                and isinstance(record.get('proof'), Mapping)
                and proof_json_sha256(record['proof']) == proof_json_sha256(proof.to_dict())
            )
        except Exception:
            return False

    def _produced_plan(self, identifier: str) -> _ProducedPlan:
        if not isinstance(identifier, str) or not identifier or identifier != identifier.strip():
            raise DjangoRoiFinalizationError('receipt/request identifier must be non-empty trimmed text')
        by_receipt = self.receipt_store.get(identifier)
        by_request = self.receipt_store.by_request(identifier)
        if by_receipt is not None and by_request is not None:
            if proof_json_sha256(by_receipt) != proof_json_sha256(by_request):
                raise DjangoRoiFinalizationError('receipt/request identifier is ambiguous')
        record = by_receipt if by_receipt is not None else by_request
        if not isinstance(record, Mapping):
            raise DjangoRoiFinalizationError('unknown durable produced receipt')
        try:
            if record.get('record_kind') != 'attempt' or record.get('attempt', {}).get('request_state') != 'produced':
                raise DjangoRoiFinalizationError('only a durable produced attempt can be finalized')
            raw_request = record['attempt']['request']
            target = RequestTarget(
                request_id=raw_request['request_id'],
                project_id=raw_request['project_id'],
                task_id=raw_request['task_id'],
                task_epoch=raw_request['task_epoch'],
                image_id=raw_request['image_id'],
                annotation_id=raw_request['annotation_id'],
                annotation_revision=raw_request['annotation_revision'],
                current_user_id=raw_request['current_user_id'],
                draft_id=raw_request['draft_id'],
                draft_revision=raw_request['draft_revision'],
                profile_fingerprint=raw_request['profile_fingerprint'],
                project_generation=raw_request['project_generation'],
                transform_fingerprint=raw_request['transform_fingerprint'],
                preexisting_draft_dirty=raw_request['preexisting_draft_dirty'],
            )
            receipt_id = record['receipt_id']
            request_id = record['request_id']
            if request_id != target.request_id:
                raise DjangoRoiFinalizationError('attempt request identity is corrupt')
            insertion = record['response']['insertion_payload']
            regions = insertion['regions']
            if not isinstance(regions, list) or not regions:
                raise DjangoRoiFinalizationError('produced attempt has no planned insertion regions')
            mapping: dict[str, str] = {}
            seen_regions: set[str] = set()
            for region in regions:
                if not isinstance(region, Mapping):
                    raise DjangoRoiFinalizationError('produced insertion region is invalid')
                result_id = region.get('result_id')
                region_key = region.get('region_key')
                if (
                    not isinstance(result_id, str)
                    or not result_id
                    or not isinstance(region_key, str)
                    or not region_key
                    or result_id in mapping
                    or region_key in seen_regions
                ):
                    raise DjangoRoiFinalizationError('produced planned result/region mapping is not unique')
                mapping[result_id] = region_key
                seen_regions.add(region_key)
            response_target = insertion.get('target')
            if not isinstance(response_target, Mapping) or proof_json_sha256(response_target) != proof_json_sha256(
                target.to_receipt_dict()
            ):
                raise DjangoRoiFinalizationError('produced insertion target differs from durable request')
            return _ProducedPlan(
                receipt_id=receipt_id,
                request_id=request_id,
                target=target,
                result_region_keys=MappingProxyType(dict(sorted(mapping.items()))),
            )
        except DjangoRoiFinalizationError:
            raise
        except Exception as exc:
            raise DjangoRoiFinalizationError('durable produced attempt is malformed') from exc


def _strict_disposition(disposition: Any, *, plan: _ProducedPlan) -> tuple[str, Mapping[str, Any]]:
    if (
        not isinstance(disposition, Mapping)
        or disposition.get('record_kind') != 'disposition'
        or disposition.get('receipt_id') != plan.receipt_id
        or disposition.get('request_id') != plan.request_id
        or disposition.get('disposition') not in {'inserted', 'abandoned'}
        or not isinstance(disposition.get('proof'), Mapping)
    ):
        raise DjangoRoiFinalizationError('durable receipt disposition is malformed')
    return disposition['disposition'], disposition['proof']


def _inserted_reconciliation_revision(
    *,
    plan: _ProducedPlan,
    proof: Mapping[str, Any],
    server: _PreflightServerState,
    incoming_full_result_sha256: str,
) -> str | None:
    target = plan.target
    expected = {
        'receipt_id': plan.receipt_id,
        'request_id': plan.request_id,
        'project_id': target.project_id,
        'task_id': target.task_id,
        'task_epoch': target.task_epoch,
        'image_id': target.image_id,
        'annotation_id': target.annotation_id,
        'source_annotation_revision': target.annotation_revision,
        'current_user_id': target.current_user_id,
        'draft_id': target.draft_id,
        'source_draft_revision': target.draft_revision,
        'result_region_keys': dict(plan.result_region_keys),
    }
    if any(proof.get(field) != value for field, value in expected.items()):
        raise DjangoRoiFinalizationError('inserted disposition proof differs from produced plan')
    inserted_revision = proof.get('inserted_draft_revision')
    if inserted_revision != proof.get('inserted_draft_updated_at'):
        raise DjangoRoiFinalizationError('inserted disposition Draft revisions differ')
    source_time = parse_canonical_revision(target.draft_revision, field='source Draft revision')
    inserted_time = parse_canonical_revision(inserted_revision, field='inserted Draft revision')
    current_time = parse_canonical_revision(server.draft_revision, field='current Draft revision')
    if inserted_time <= source_time:
        raise DjangoRoiFinalizationError('inserted disposition does not advance its source Draft')
    saved_hash = proof.get('saved_full_result_sha256')
    if not isinstance(saved_hash, str) or len(saved_hash) != 64:
        raise DjangoRoiFinalizationError('inserted disposition lacks a saved Draft hash')
    saved_full_result = proof.get('saved_full_result')
    if saved_full_result is not None and proof_json_sha256(saved_full_result) != saved_hash:
        raise DjangoRoiFinalizationError('inserted disposition saved Draft hash differs')
    current_hash = proof_json_sha256(server.full_result)
    if current_time == inserted_time:
        if current_hash != saved_hash:
            raise DjangoRoiFinalizationError('persisted Draft differs from its inserted disposition')
        return None
    if current_time > inserted_time:
        # The inserted linkage was durably established and was later edited or
        # removed through another fenced Draft transition.
        return None
    if current_time == source_time:
        if incoming_full_result_sha256 != saved_hash:
            raise DjangoRoiFinalizationError('external-first insertion requires exact payload replay')
        return inserted_revision
    raise DjangoRoiFinalizationError('Draft revision cannot reconcile inserted disposition')


def _verify_immutable_target(state: Any, *, target: RequestTarget) -> None:
    observed = {
        'project_id': str(state.project.pk),
        'task_id': state.task_key,
        'task_epoch': state.task_epoch,
        'image_id': str(state.image_id),
        'annotation_id': str(state.annotation.pk),
        'current_user_id': str(state.user.pk),
        'draft_id': str(state.draft.pk),
    }
    expected = target.binding_payload()
    mismatches = [field for field, value in observed.items() if expected[field] != value]
    if mismatches:
        raise DjangoRoiFinalizationError('receipt immutable target differs: ' + ','.join(mismatches))


def _verify_exact_planned_regions(
    *,
    full_result: list[dict[str, Any]],
    semantic_result: list[dict[str, Any]],
    plan: _ProducedPlan,
) -> None:
    full_ids = [item.get('id') for item in full_result]
    semantic_ids = [item.get('region_key') for item in semantic_result]
    if len(full_ids) != len(set(full_ids)) or len(semantic_ids) != len(set(semantic_ids)):
        raise DjangoRoiFinalizationError('persisted Draft contains duplicate regions')
    for result_id, region_key in plan.result_region_keys.items():
        if full_ids.count(region_key) != 1 or semantic_ids.count(region_key) != 1:
            raise DjangoRoiFinalizationError('persisted Draft is missing or duplicates a planned region')
        full = full_result[full_ids.index(region_key)]
        semantic = semantic_result[semantic_ids.index(region_key)]
        expected_full = {
            'coordexp_region_key': region_key,
            'coordexp_inference_receipt_id': plan.receipt_id,
            'coordexp_inference_request_id': plan.request_id,
            'coordexp_inference_result_id': result_id,
            'coordexp_inference_source_draft_revision': plan.target.draft_revision,
        }
        meta = full.get('meta')
        if not isinstance(meta, Mapping) or any(meta.get(field) != value for field, value in expected_full.items()):
            raise DjangoRoiFinalizationError('persisted Draft inference linkage differs from planned mapping')
        metadata = semantic.get('metadata')
        expected_semantic = {
            'inference_origin': True,
            'receipt_id': plan.receipt_id,
            'request_id': plan.request_id,
            'result_id': result_id,
            'draft_revision': plan.target.draft_revision,
        }
        if not isinstance(metadata, Mapping) or any(
            metadata.get(field) != value for field, value in expected_semantic.items()
        ):
            raise DjangoRoiFinalizationError('persisted Draft semantic linkage differs from planned mapping')


def _planned_linkage_hits(
    *,
    full_result: Sequence[Mapping[str, Any]],
    semantic_result: Sequence[Mapping[str, Any]],
    plan: _ProducedPlan,
) -> tuple[str, ...]:
    """Return every server-planned identifier still present in persisted state."""

    planned_result_ids = set(plan.result_region_keys)
    planned_region_keys = set(plan.result_region_keys.values())
    hits: list[str] = []
    for ordinal, item in enumerate(full_result):
        if item.get('id') in planned_region_keys:
            hits.append(f'full[{ordinal}].id')
        meta = item.get('meta')
        if not isinstance(meta, Mapping):
            continue
        if meta.get('coordexp_region_key') in planned_region_keys:
            hits.append(f'full[{ordinal}].meta.region_key')
        if meta.get('coordexp_inference_receipt_id') == plan.receipt_id:
            hits.append(f'full[{ordinal}].meta.receipt_id')
        if meta.get('coordexp_inference_request_id') == plan.request_id:
            hits.append(f'full[{ordinal}].meta.request_id')
        if meta.get('coordexp_inference_result_id') in planned_result_ids:
            hits.append(f'full[{ordinal}].meta.result_id')
    for ordinal, item in enumerate(semantic_result):
        if item.get('region_key') in planned_region_keys:
            hits.append(f'semantic[{ordinal}].region_key')
        metadata = item.get('metadata')
        if not isinstance(metadata, Mapping):
            continue
        if metadata.get('receipt_id') == plan.receipt_id:
            hits.append(f'semantic[{ordinal}].metadata.receipt_id')
        if metadata.get('request_id') == plan.request_id:
            hits.append(f'semantic[{ordinal}].metadata.request_id')
        if metadata.get('result_id') in planned_result_ids:
            hits.append(f'semantic[{ordinal}].metadata.result_id')
    return tuple(hits)


def _strict_result_copy(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise DjangoRoiFinalizationError('persisted Draft result must be a JSON array')
    copied = copy.deepcopy(value)
    proof_json_sha256(copied)
    return copied


def _principal_pk(user: Any) -> int:
    if getattr(user, 'is_authenticated', False) is not True:
        raise DjangoRoiFinalizationError('an authenticated principal is required')
    return _canonical_pk(getattr(user, 'pk', None), field='principal user id')


def _canonical_pk(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DjangoRoiFinalizationError(f'{field} must be a positive integer')
    return value


def _canonical_text_pk(value: Any, *, field: str) -> int:
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise DjangoRoiFinalizationError(f'{field} must be canonical decimal text')
    parsed = int(value)
    if parsed <= 0 or str(parsed) != value:
        raise DjangoRoiFinalizationError(f'{field} must be canonical decimal text')
    return parsed


def _normalized_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise DjangoRoiFinalizationError(f'{field} must be non-empty normalized text')
    return value


__all__ = ['DjangoRoiFinalizationError', 'DjangoRoiFinalizer', 'DraftPersistencePlan']

"""Authenticated, fail-closed Label Studio Draft capture.

This module is the only vendor-aware part of the Draft catalog boundary.  The
browser supplies neither Draft identities nor source-row positions: both are
resolved from locked Label Studio rows and the parent-owned working store.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from threading import RLock
from types import MappingProxyType
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from projects.models import Project
from src.label_studio_coco_refinement.draft_adapter import (
    DraftContractError,
    canonicalize_label_studio_draft,
)
from src.label_studio_coco_refinement.geometry import norm1000_bbox_to_label_studio_xywh
from src.label_studio_coco_refinement.runtime import (
    AuthenticatedPrincipal,
    AuthoritativeDraftSnapshot,
    DraftCatalogCapture,
    DraftCatalogError,
    DraftCatalogRequest,
)
from src.label_studio_coco_refinement.store import (
    AuthoritativeDraftIdentity,
    BatchMember,
    BatchRequest,
    BatchStatus,
    DraftRestore,
    WorkingDatasetStore,
    canonical_json,
    semantic_hash,
    sha256_json,
)
from tasks.models import Annotation, AnnotationDraft, Prediction, Task

_SUPPORTED_SPLITS = frozenset({'train', 'val'})


class DraftLifecycleConflict(DraftCatalogError):
    """A persisted Draft changed before an explicit reset could apply."""


@dataclass(frozen=True)
class _LockedDraft:
    draft: AnnotationDraft
    task: Task
    annotation: Annotation
    split: str
    image_id: int
    source_line: int


@dataclass(frozen=True)
class _StoreAuthority:
    split: str
    generation: int
    working_sha256: str
    working_line_count: int


class DjangoDraftCatalog:
    """Capture all changed authoritative Drafts for one current user."""

    def __init__(
        self,
        stores: Mapping[str, WorkingDatasetStore],
        project_ids: Mapping[str, int | str],
    ) -> None:
        self._project_ids = _normalize_project_map(project_ids)
        self._stores = _normalize_store_map(stores, expected=self._project_ids)
        self._project_state_cache_lock = RLock()
        self._project_state_baselines: dict[
            _StoreAuthority, dict[int, DraftRestore]
        ] = {}

    def capture_current_user_drafts(self, request: DraftCatalogRequest) -> DraftCatalogCapture:
        split, project_pk, user_pk = self._validate_request(request)
        store = self._stores[split]

        try:
            with transaction.atomic():
                user = get_user_model().objects.select_for_update().get(pk=user_pk, is_active=True)
                project = Project.objects.for_user(user).select_for_update().get(pk=project_pk)
                drafts = list(
                    AnnotationDraft.objects.select_for_update()
                    .filter(user_id=user_pk, task__project_id=project.pk)
                    .order_by('task_id', 'pk')
                )
                if not drafts:
                    raise DraftCatalogError('the current user has no durable Drafts in this project')

                locked = self._lock_and_validate_drafts(
                    drafts=drafts,
                    split=split,
                    project_pk=project.pk,
                    store=store,
                )
                locked.sort(key=lambda item: item.source_line)
                baselines = store.restore_drafts(tuple(item.image_id for item in locked))
                if len(baselines) != len(locked):
                    raise DraftCatalogError('working store returned an incomplete baseline capture')

                snapshots: list[AuthoritativeDraftSnapshot] = []
                base_generation: int | None = None
                for item, baseline in zip(locked, baselines, strict=True):
                    _validate_baseline(baseline, split=split, image_id=item.image_id)
                    if base_generation is None:
                        base_generation = baseline.generation
                    elif baseline.generation != base_generation:
                        raise DraftCatalogError('working store returned cross-generation baselines')
                    canonical = canonicalize_label_studio_draft(
                        item.draft.result,
                        split=split,
                        image_id=item.image_id,
                        image_width=_row_dimension(baseline, 'width'),
                        image_height=_row_dimension(baseline, 'height'),
                    )
                    if canonical.semantic_hash == _baseline_semantic_hash(baseline):
                        continue
                    snapshots.append(
                        AuthoritativeDraftSnapshot(
                            split=split,
                            project_id=str(project_pk),
                            image_id=item.image_id,
                            task_id=f'{split}:{item.image_id}',
                            annotation_id=str(item.annotation.pk),
                            draft_id=str(item.draft.pk),
                            annotation_revision=_timestamp(item.annotation.updated_at),
                            draft_updated_at=_timestamp(item.draft.updated_at),
                            semantic_hash=canonical.semantic_hash,
                            result_hash=canonical.result_hash,
                            base_row_hash=baseline.row_hash,
                            observed_generation=baseline.generation,
                            regions=canonical.to_json_regions(),
                            inference_receipts=canonical.inference_receipts,
                        )
                    )

                if not snapshots:
                    raise DraftCatalogError(
                        'the current user has no eligible Drafts differing from the committed baseline'
                    )
                assert base_generation is not None
                return DraftCatalogCapture(
                    split=split,
                    project_id=str(project_pk),
                    current_user_id=str(user_pk),
                    base_generation=base_generation,
                    snapshots=tuple(snapshots),
                )
        except DraftCatalogError:
            raise
        except Exception as exc:
            raise DraftCatalogError('authoritative Draft capture failed closed') from exc

    def project_state(
        self,
        *,
        split: str,
        principal: Any,
    ) -> dict[str, Any]:
        """Return a read-only authoritative Draft and active-batch projection."""

        request = DraftCatalogRequest(
            split=split,
            project_id=str(self._project_ids.get(split, '')),
            principal=principal,
        )
        split, project_pk, user_pk = self._validate_request(request)
        store = self._stores[split]
        try:
            store_state_before = _store_project_state(store)
            store_authority = _store_authority(split, store_state_before)
            active_semantic_hashes = store_state_before['active_member_semantic_hashes']
            terminal_semantic_hashes = store_state_before['last_terminal_member_semantic_hashes']
            with transaction.atomic():
                user = get_user_model().objects.get(pk=user_pk, is_active=True)
                project = Project.objects.for_user(user).get(pk=project_pk)
                drafts = list(
                    AnnotationDraft.objects.select_for_update()
                    .filter(
                        user_id=user_pk,
                        task__project_id=project.pk,
                    )
                    .order_by('task_id', 'pk')
                )
                locked = self._lock_and_validate_drafts(
                    drafts=drafts,
                    split=split,
                    project_pk=project.pk,
                    store=store,
                )
                locked.sort(key=lambda item: item.source_line)
                baselines = self._restore_project_state_baselines(
                    store=store,
                    authority=store_authority,
                    image_ids=tuple(item.image_id for item in locked),
                )
                members: list[dict[str, Any]] = []
                generation: int | None = None
                pending_count = 0
                for item, baseline in zip(locked, baselines, strict=True):
                    _validate_baseline(
                        baseline,
                        split=split,
                        image_id=item.image_id,
                    )
                    if generation is None:
                        generation = baseline.generation
                    elif generation != baseline.generation:
                        raise DraftCatalogError('working store returned cross-generation project state')
                    canonical = canonicalize_label_studio_draft(
                        item.draft.result,
                        split=split,
                        image_id=item.image_id,
                        image_width=_row_dimension(baseline, 'width'),
                        image_height=_row_dimension(baseline, 'height'),
                    )
                    committed_hash = _baseline_semantic_hash(baseline)
                    pending = canonical.semantic_hash != committed_hash
                    pending_count += int(pending)
                    task_key = f'{split}:{item.image_id}'
                    active_batch_semantic_hash = active_semantic_hashes.get(task_key)
                    terminal_batch_semantic_hash = terminal_semantic_hashes.get(task_key)
                    members.append(
                        {
                            'task_id': item.task.pk,
                            'task_key': task_key,
                            'draft_id': item.draft.pk,
                            'draft_updated_at': _timestamp(item.draft.updated_at),
                            'draft_semantic_hash': canonical.semantic_hash,
                            'committed_semantic_hash': committed_hash,
                            'pending': pending,
                            'draft_ahead_of_committed': pending,
                            'active_batch_member': active_batch_semantic_hash is not None,
                            'active_batch_semantic_hash': active_batch_semantic_hash,
                            'draft_ahead_of_active_batch': (
                                active_batch_semantic_hash is not None
                                and canonical.semantic_hash != active_batch_semantic_hash
                            ),
                            'last_terminal_batch_member': terminal_batch_semantic_hash is not None,
                            'last_terminal_batch_semantic_hash': terminal_batch_semantic_hash,
                            'draft_matches_last_terminal_batch': (
                                terminal_batch_semantic_hash is not None
                                and canonical.semantic_hash == terminal_batch_semantic_hash
                            ),
                        }
                    )

            store_state_after = _store_project_state(store)
            if store_state_before != store_state_after:
                raise DraftCatalogError('project store state changed during capture')
            store_generation = store_state_before['generation']
            if generation is not None and generation != store_generation:
                # A commit completed after the Draft snapshot.  Refuse a mixed
                # projection and let the browser retry its read-only poll.
                raise DraftCatalogError('project state changed during capture')
            return {
                'generation': store_generation,
                'pending_draft_count': pending_count,
                'members': members,
                'active_batch_id': store_state_before['active_batch_id'],
                'batch_state': store_state_before['batch_state'],
                'active_batch': store_state_before['active_batch'],
                'last_terminal_batch': store_state_before['last_terminal_batch'],
            }
        except DraftCatalogError:
            raise
        except Exception as exc:
            raise DraftCatalogError('authoritative project state lookup failed closed') from exc

    def current_task_lifecycle(
        self,
        *,
        split: str,
        principal: AuthenticatedPrincipal,
        task_pk: int,
        action: str,
        expected_draft: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Resolve or atomically reset one user-owned task against committed truth.

        The browser selects only the loaded task and an action. Annotation,
        Draft, source-row, committed-row, and identity authorities are all
        resolved under server locks. ``reconcile`` updates the durable Draft
        only for an exact persisted token whose semantic hash already equals
        committed truth; otherwise it returns metadata-only state. ``discard``
        requires the same exact token and replaces that Draft with the current
        committed Label Studio projection.
        """

        if split not in self._stores or split not in self._project_ids:
            raise DraftCatalogError('unknown refinement split')
        if principal.authenticated is not True:
            raise DraftCatalogError('an authenticated server principal is required')
        user_pk = _canonical_pk(principal.user_id, field='principal user id')
        project_pk = self._project_ids[split]
        task_pk = _canonical_pk(task_pk, field='task id')
        if action not in {'inspect', 'reconcile', 'discard'}:
            raise DraftCatalogError('unsupported Draft lifecycle action')
        normalized_expected = _expected_draft_token(expected_draft)
        store = self._stores[split]

        try:
            with transaction.atomic():
                user = get_user_model().objects.select_for_update().get(pk=user_pk, is_active=True)
                project = Project.objects.for_user(user).select_for_update().get(pk=project_pk)
                if hasattr(project, 'summary'):
                    from projects.models import ProjectSummary

                    ProjectSummary.objects.select_for_update().get(pk=project.summary.pk)
                task = Task.objects.select_for_update().get(pk=task_pk, project_id=project_pk)
                task_split, image_id, source_line = _task_identity(task, split=split)
                source_index = store.resolve_source_row_index(
                    split=task_split,
                    project_id=str(project_pk),
                    task_id=f'{task_split}:{image_id}',
                    image_id=image_id,
                )
                if source_index != source_line - 1:
                    raise DraftCatalogError('task source_line does not match store authority')
                annotations = list(
                    Annotation.objects.select_for_update().filter(task_id=task.pk).order_by('pk')
                )
                annotation = _sole_editable_annotation(annotations)
                if annotation.project_id != project_pk:
                    raise DraftCatalogError('authoritative annotation project binding is invalid')
                if Prediction.objects.select_for_update().filter(task_id=task.pk).exists():
                    raise DraftCatalogError('refinement tasks cannot contain predictions')
                drafts = list(
                    AnnotationDraft.objects.select_for_update()
                    .filter(task_id=task.pk, user_id=user_pk)
                    .order_by('pk')
                )
                if len(drafts) != 1 or drafts[0].annotation_id != annotation.pk:
                    raise DraftCatalogError('task must have exactly one current-user authoritative Draft')
                draft = drafts[0]
                store_state = _store_project_state(store)
                baseline = store.restore_draft(image_id)
                _validate_baseline(baseline, split=split, image_id=image_id)
                if baseline.generation != store_state['generation']:
                    raise DraftCatalogError('working store changed during task lifecycle capture')
                committed_result = _committed_label_studio_result(baseline)
                committed_hash = _baseline_semantic_hash(baseline)
                current = canonicalize_label_studio_draft(
                    draft.result,
                    split=split,
                    image_id=image_id,
                    image_width=_row_dimension(baseline, 'width'),
                    image_height=_row_dimension(baseline, 'height'),
                )
                token_matches = _draft_token_matches(
                    draft=draft,
                    semantic_hash=current.semantic_hash,
                    expected=normalized_expected,
                )
                terminal_matches = False
                if action == 'reconcile':
                    terminal = store_state['last_terminal_batch']
                    terminal_hash = store_state['last_terminal_member_semantic_hashes'].get(
                        f'{split}:{image_id}'
                    )
                    terminal_matches = (
                        terminal is not None
                        and terminal.get('state') == BatchStatus.SUCCEEDED.value
                        and terminal.get('generation') == baseline.generation
                        and terminal_hash == normalized_expected['draft_semantic_hash']
                    )
                disposition = 'metadata_only'
                if action == 'discard':
                    if not token_matches:
                        raise DraftLifecycleConflict('persisted Draft changed before reset')
                    draft.result = committed_result
                    draft.was_postponed = False
                    draft.save(update_fields=['result', 'was_postponed', 'updated_at'])
                    current_hash = committed_hash
                    disposition = 'reset'
                elif action == 'reconcile' and token_matches and terminal_matches:
                    draft.result = committed_result
                    draft.was_postponed = False
                    draft.save(update_fields=['result', 'was_postponed', 'updated_at'])
                    current_hash = committed_hash
                    disposition = 'rebased'
                else:
                    current_hash = current.semantic_hash

                if _store_project_state(store) != store_state:
                    raise DraftCatalogError('working store changed during task lifecycle capture')

                return {
                    'action': action,
                    'disposition': disposition,
                    'task_id': task.pk,
                    'annotation_id': annotation.pk,
                    'draft': {
                        'draft_id': draft.pk,
                        'draft_updated_at': _timestamp(draft.updated_at),
                        'draft_semantic_hash': current_hash,
                    },
                    'expected_draft_matches': token_matches,
                    'committed': {
                        'generation': baseline.generation,
                        'semantic_hash': committed_hash,
                        'result': committed_result,
                    },
                }
        except DraftLifecycleConflict:
            raise
        except (DraftCatalogError, DraftContractError):
            raise
        except Exception as exc:
            raise DraftCatalogError('authoritative task lifecycle lookup failed closed') from exc

    def _restore_project_state_baselines(
        self,
        *,
        store: WorkingDatasetStore,
        authority: _StoreAuthority,
        image_ids: tuple[int, ...],
    ) -> tuple[DraftRestore, ...]:
        """Reuse only baselines fully attested for one published store authority."""

        if not image_ids:
            return ()
        with self._project_state_cache_lock:
            cached = self._project_state_baselines.get(authority, {})
            if all(image_id in cached for image_id in image_ids):
                return tuple(cached[image_id] for image_id in image_ids)

            restored = store.restore_drafts(image_ids)
            if len(restored) != len(image_ids):
                raise DraftCatalogError('working store returned an incomplete project-state baseline')
            for image_id, baseline in zip(image_ids, restored, strict=True):
                _validate_baseline(
                    baseline,
                    split=authority.split,
                    image_id=image_id,
                )
                if baseline.generation != authority.generation:
                    raise DraftCatalogError('working store returned a cross-authority baseline')

            attested_state = _store_project_state(store)
            if _store_authority(authority.split, attested_state) != authority:
                raise DraftCatalogError('project store authority changed during baseline attestation')

            updated = dict(cached)
            updated.update(zip(image_ids, restored, strict=True))
            self._project_state_baselines = {
                key: value
                for key, value in self._project_state_baselines.items()
                if key.split != authority.split
            }
            self._project_state_baselines[authority] = updated
            return tuple(updated[image_id] for image_id in image_ids)

    def _validate_request(self, request: DraftCatalogRequest) -> tuple[str, int, int]:
        if not isinstance(request, DraftCatalogRequest):
            raise DraftCatalogError('invalid Draft catalog request')
        split = request.split
        if split not in self._stores:
            raise DraftCatalogError('unknown refinement split')
        project_pk = self._project_ids[split]
        if request.project_id != str(project_pk):
            raise DraftCatalogError('Draft project/split mapping mismatch')
        if request.principal.authenticated is not True:
            raise DraftCatalogError('an authenticated server principal is required')
        user_pk = _canonical_pk(request.principal.user_id, field='principal user id')
        return split, project_pk, user_pk

    @staticmethod
    def _lock_and_validate_drafts(
        *,
        drafts: Sequence[AnnotationDraft],
        split: str,
        project_pk: int,
        store: WorkingDatasetStore,
    ) -> list[_LockedDraft]:
        task_ids = [draft.task_id for draft in drafts]
        if any(task_id is None for task_id in task_ids):
            raise DraftCatalogError('authoritative Draft is missing its task')
        if len(set(task_ids)) != len(task_ids):
            raise DraftCatalogError('the current user has multiple Drafts for one task')

        tasks = {task.pk: task for task in Task.objects.select_for_update().filter(pk__in=task_ids)}
        annotations_by_task: dict[int, list[Annotation]] = defaultdict(list)
        for annotation in (
            Annotation.objects.select_for_update().filter(task_id__in=task_ids).order_by('task_id', 'pk')
        ):
            annotations_by_task[annotation.task_id].append(annotation)
        if Prediction.objects.select_for_update().filter(task_id__in=task_ids).exists():
            raise DraftCatalogError('refinement tasks cannot contain predictions')

        locked: list[_LockedDraft] = []
        for draft in drafts:
            task = tasks.get(draft.task_id)
            if task is None or task.project_id != project_pk:
                raise DraftCatalogError('Draft task/project binding is invalid')
            annotations = annotations_by_task.get(task.pk, [])
            annotation = _sole_editable_annotation(annotations)
            if annotation.project_id != project_pk:
                raise DraftCatalogError('authoritative annotation project binding is invalid')
            if draft.annotation_id != annotation.pk:
                raise DraftCatalogError('Draft is not bound to the sole authoritative annotation')
            task_split, image_id, source_line = _task_identity(task, split=split)
            source_index = store.resolve_source_row_index(
                split=task_split,
                project_id=str(project_pk),
                task_id=f'{task_split}:{image_id}',
                image_id=image_id,
            )
            if source_index != source_line - 1:
                raise DraftCatalogError('task source_line does not match store authority')
            locked.append(
                _LockedDraft(
                    draft=draft,
                    task=task,
                    annotation=annotation,
                    split=task_split,
                    image_id=image_id,
                    source_line=source_line,
                )
            )
        return locked


class DjangoAnnotationVerifier:
    """Fail-closed, batch-only attestation of frozen current-user Drafts."""

    def __init__(
        self,
        project_ids: Mapping[str, int | str],
    ) -> None:
        self._project_ids = _normalize_project_map(project_ids)

    def verify(self, identity: AuthoritativeDraftIdentity) -> bool:
        """Legacy per-member verification is deliberately unsupported."""

        del identity
        return False

    def verify_batch(self, request: BatchRequest) -> bool:
        try:
            if not isinstance(request, BatchRequest):
                return False
            split = request.split
            project_pk = self._project_ids.get(split)
            if project_pk is None:
                return False
            user_pk = _canonical_text_pk(request.current_user_id, field='current user id')
            members = tuple(request.members)
            if not members or not all(isinstance(member, BatchMember) for member in members):
                return False

            expected: list[tuple[BatchMember, int, int]] = []
            seen_tasks: set[str] = set()
            seen_drafts: set[int] = set()
            seen_annotations: set[int] = set()
            seen_indexes: set[int] = set()
            for member in members:
                if (
                    isinstance(member.source_row_index, bool)
                    or not isinstance(member.source_row_index, int)
                    or member.source_row_index < 0
                ):
                    return False
                commit = member.request
                if (
                    commit.split != split
                    or commit.project_id != str(project_pk)
                    or commit.task_id != f'{split}:{commit.image_id}'
                ):
                    return False
                draft_pk = _canonical_text_pk(commit.draft_id, field='draft id')
                annotation_pk = _canonical_text_pk(commit.annotation_id, field='annotation id')
                if (
                    commit.task_id in seen_tasks
                    or draft_pk in seen_drafts
                    or annotation_pk in seen_annotations
                    or member.source_row_index in seen_indexes
                ):
                    return False
                seen_tasks.add(commit.task_id)
                seen_drafts.add(draft_pk)
                seen_annotations.add(annotation_pk)
                seen_indexes.add(member.source_row_index)
                expected.append((member, draft_pk, annotation_pk))

            with transaction.atomic():
                user = get_user_model().objects.select_for_update().get(pk=user_pk, is_active=True)
                Project.objects.for_user(user).select_for_update().get(pk=project_pk)

                drafts = {
                    draft.pk: draft for draft in AnnotationDraft.objects.select_for_update().filter(pk__in=seen_drafts)
                }
                if set(drafts) != seen_drafts or any(draft.task_id is None for draft in drafts.values()):
                    return False
                task_pks = {draft.task_id for draft in drafts.values()}
                tasks = {task.pk: task for task in Task.objects.select_for_update().filter(pk__in=task_pks)}
                if set(tasks) != task_pks:
                    return False
                annotations_by_task: dict[int, list[Annotation]] = defaultdict(list)
                for annotation in (
                    Annotation.objects.select_for_update().filter(task_id__in=task_pks).order_by('task_id', 'pk')
                ):
                    annotations_by_task[annotation.task_id].append(annotation)
                if Prediction.objects.select_for_update().filter(task_id__in=task_pks).exists():
                    return False

                current_user_drafts: dict[int, list[AnnotationDraft]] = defaultdict(list)
                for draft in (
                    AnnotationDraft.objects.select_for_update()
                    .filter(task_id__in=task_pks, user_id=user_pk)
                    .order_by('task_id', 'pk')
                ):
                    current_user_drafts[draft.task_id].append(draft)
                if any(len(current_user_drafts.get(task_pk, ())) != 1 for task_pk in task_pks):
                    return False

                for member, draft_pk, annotation_pk in expected:
                    commit = member.request
                    draft = drafts[draft_pk]
                    task = tasks.get(draft.task_id)
                    if task is None or draft.user_id != user_pk:
                        return False
                    if current_user_drafts[draft.task_id][0].pk != draft.pk:
                        return False
                    annotation = _sole_editable_annotation(annotations_by_task.get(task.pk, ()))
                    if (
                        annotation.pk != annotation_pk
                        or annotation.project_id != project_pk
                        or draft.annotation_id != annotation.pk
                        or draft.task_id != task.pk
                        or task.project_id != project_pk
                    ):
                        return False
                    task_split, image_id, source_line = _task_identity(task, split=split)
                    if (
                        image_id != commit.image_id
                        or commit.task_id != f'{task_split}:{image_id}'
                        or source_line != member.source_row_index + 1
                        or _timestamp(annotation.updated_at) != commit.annotation_revision
                        or _timestamp(draft.updated_at) != commit.draft_updated_at
                    ):
                        return False
                    width, height = _annotation_dimensions(annotation.result)
                    canonicalize_label_studio_draft(
                        annotation.result,
                        split=split,
                        image_id=image_id,
                        image_width=width,
                        image_height=height,
                    )
                    canonical = canonicalize_label_studio_draft(
                        draft.result,
                        split=split,
                        image_id=image_id,
                        image_width=width,
                        image_height=height,
                    )
                    expected_regions = canonical.to_json_regions()
                    submitted_regions = list(commit.regions)
                    if (
                        canonical.result_hash != commit.result_hash
                        or canonical.semantic_hash != commit.semantic_hash
                        or semantic_hash(submitted_regions) != canonical.semantic_hash
                        or canonical_json(submitted_regions) != canonical_json(expected_regions)
                        or sha256_json(submitted_regions) != sha256_json(expected_regions)
                        or tuple(commit.inference_receipts) != canonical.inference_receipts
                    ):
                        return False
                return True
        except Exception:
            return False


def _normalize_project_map(
    project_ids: Mapping[str, int | str],
) -> Mapping[str, int]:
    if not isinstance(project_ids, Mapping) or not project_ids:
        raise ValueError('project_ids must be a non-empty split mapping')
    keys = set(project_ids)
    if not keys <= _SUPPORTED_SPLITS:
        raise ValueError('project_ids contains an unsupported split')
    normalized = {split: _canonical_pk(value, field=f'{split} project id') for split, value in project_ids.items()}
    if len(set(normalized.values())) != len(normalized):
        raise ValueError('train and val must use distinct Label Studio projects')
    return MappingProxyType(normalized)


def _store_project_state(store: WorkingDatasetStore) -> dict[str, Any]:
    """Read one queue/journal/manifest projection under store barriers."""

    try:
        with store._shared_lock():
            with store._shared_queue_lock():
                queue_records = store._read_queue_records()
            reconciliation_reason = store._batch_reconciliation_reason(queue_records)
            manifest = store._read_manifest()
            generation = int(manifest['generation'])
            journal_records = tuple(store._records)
            active = store._active_queue_enqueue(queue_records)

            active_batch = None
            active_semantic_hashes: dict[str, str] = {}
            if active is not None:
                batch_id = active.get('batch_id')
                if not isinstance(batch_id, str) or not batch_id:
                    raise DraftCatalogError('working store active batch identity is invalid')
                state, _, _ = store._queue_batch_state(active, queue_records)
                state_value = BatchStatus.RECONCILING.value if reconciliation_reason is not None else state.value
                active_semantic_hashes = _queued_member_semantic_hashes(
                    active,
                    field='active batch',
                )
                active_batch = {
                    'batch_id': batch_id,
                    'state': state_value,
                    'member_count': int(active['member_count']),
                    'base_generation': int(active['base_generation']),
                    'payload_hash': active['payload_hash'],
                }

            last_terminal = None
            last_terminal_semantic_hashes: dict[str, str] = {}
            if reconciliation_reason is None:
                last_terminal, last_terminal_semantic_hashes = _last_terminal_batch(
                    queue_records=queue_records,
                    journal_records=journal_records,
                )
        return {
            'generation': generation,
            'working_sha256': manifest.get('working_sha256'),
            'working_line_count': manifest.get('working_line_count'),
            'active_batch_id': None if active_batch is None else active_batch['batch_id'],
            'batch_state': None if active_batch is None else active_batch['state'],
            'active_batch': active_batch,
            'active_member_semantic_hashes': dict(sorted(active_semantic_hashes.items())),
            'last_terminal_batch': last_terminal,
            'last_terminal_member_semantic_hashes': dict(sorted(last_terminal_semantic_hashes.items())),
        }
    except DraftCatalogError:
        raise
    except Exception as exc:
        raise DraftCatalogError('working store project status is unavailable') from exc


def _store_authority(split: str, state: Mapping[str, Any]) -> _StoreAuthority:
    generation = state.get('generation')
    working_sha256 = state.get('working_sha256')
    working_line_count = state.get('working_line_count')
    if (
        split not in _SUPPORTED_SPLITS
        or isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 0
        or not _is_sha256(working_sha256)
        or isinstance(working_line_count, bool)
        or not isinstance(working_line_count, int)
        or working_line_count < 0
    ):
        raise DraftCatalogError('working store publication authority is invalid')
    return _StoreAuthority(
        split=split,
        generation=generation,
        working_sha256=working_sha256,
        working_line_count=working_line_count,
    )


def _last_terminal_batch(
    *,
    queue_records: Sequence[Mapping[str, Any]],
    journal_records: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, str]]:
    terminals = [record for record in queue_records if record.get('kind') == 'queue_terminal']
    for terminal in reversed(terminals):
        matching = [
            record
            for record in journal_records
            if record.get('kind') == 'batch_terminal'
            and all(
                record.get(field) == terminal.get(field)
                for field in (
                    'batch_id',
                    'payload_hash',
                    'status',
                    'generation',
                    'working_sha256',
                    'error',
                )
            )
        ]
        if len(matching) != 1:
            raise DraftCatalogError('working store terminal batch projection is ambiguous')
        enqueue = [
            record
            for record in queue_records
            if record.get('kind') == 'enqueue' and record.get('batch_id') == terminal.get('batch_id')
        ]
        if len(enqueue) != 1:
            raise DraftCatalogError('working store terminal batch enqueue is ambiguous')
        source = enqueue[0]
        state = terminal.get('status')
        if state not in {BatchStatus.SUCCEEDED.value, BatchStatus.FAILED.value}:
            raise DraftCatalogError('working store terminal batch state is invalid')
        semantic_hashes = _queued_member_semantic_hashes(
            source,
            field='terminal batch',
        )
        return {
            'batch_id': terminal['batch_id'],
            'state': state,
            'member_count': int(source['member_count']),
            'base_generation': int(source['base_generation']),
            'generation': int(terminal['generation']),
            'error': 'Batch processing failed.' if state == BatchStatus.FAILED.value else None,
            'payload_hash': terminal['payload_hash'],
            'member_task_keys': sorted(semantic_hashes),
        }, semantic_hashes
    return None, {}


def _queued_member_semantic_hashes(
    enqueue: Mapping[str, Any],
    *,
    field: str,
) -> dict[str, str]:
    payload = enqueue.get('payload')
    if not isinstance(payload, Mapping):
        raise DraftCatalogError(f'working store {field} payload is invalid')
    members = payload.get('members')
    if not isinstance(members, list) or len(members) != enqueue.get('member_count'):
        raise DraftCatalogError(f'working store {field} members are invalid')
    semantic_hashes: dict[str, str] = {}
    for member in members:
        if not isinstance(member, Mapping) or not isinstance(member.get('request'), Mapping):
            raise DraftCatalogError(f'working store {field} member is invalid')
        member_request = member['request']
        task_key = member_request.get('task_id')
        semantic = member_request.get('semantic_hash')
        if not isinstance(task_key, str) or not task_key or not _is_sha256(semantic) or task_key in semantic_hashes:
            raise DraftCatalogError(f'working store {field} member identity is invalid')
        semantic_hashes[task_key] = semantic
    return semantic_hashes


def _normalize_store_map(
    stores: Mapping[str, WorkingDatasetStore], *, expected: Mapping[str, int]
) -> Mapping[str, WorkingDatasetStore]:
    if not isinstance(stores, Mapping) or set(stores) != set(expected):
        raise ValueError('stores and project_ids must cover the same splits')
    copied = dict(stores)
    if any(store is None for store in copied.values()):
        raise ValueError('stores cannot contain null values')
    return MappingProxyType(copied)


def _canonical_pk(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise DraftCatalogError(f'{field} must be a canonical positive integer')
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        result = int(value)
        if value != str(result):
            raise DraftCatalogError(f'{field} must use canonical decimal text')
    else:
        raise DraftCatalogError(f'{field} must be a canonical positive integer')
    if result <= 0:
        raise DraftCatalogError(f'{field} must be a canonical positive integer')
    return result


def _canonical_text_pk(value: Any, *, field: str) -> int:
    if not isinstance(value, str):
        raise DraftCatalogError(f'{field} must be canonical decimal text')
    return _canonical_pk(value, field=field)


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in '0123456789abcdef' for character in value)


def _task_identity(task: Task, *, split: str) -> tuple[str, int, int]:
    data = task.data
    if not isinstance(data, Mapping):
        raise DraftCatalogError('task data must be a JSON object')
    required = {'coordexp_task_key', 'split', 'image_id', 'source_line'}
    if not required <= set(data):
        raise DraftCatalogError('task data is missing refinement identity fields')
    task_split = data['split']
    if task_split != split:
        raise DraftCatalogError('task split does not match project mapping')
    image_id = data['image_id']
    source_line = data['source_line']
    if (
        isinstance(image_id, bool)
        or not isinstance(image_id, int)
        or image_id < 0
        or isinstance(source_line, bool)
        or not isinstance(source_line, int)
        or source_line <= 0
    ):
        raise DraftCatalogError('task image_id/source_line is invalid')
    if data['coordexp_task_key'] != f'{split}:{image_id}':
        raise DraftCatalogError('task key does not match split/image_id')
    return task_split, image_id, source_line


def _sole_editable_annotation(
    annotations: Sequence[Annotation],
) -> Annotation:
    if len(annotations) != 1:
        raise DraftCatalogError('task must have exactly one authoritative annotation and no alternates')
    annotation = annotations[0]
    if annotation.ground_truth or annotation.was_cancelled:
        raise DraftCatalogError('authoritative annotation is not ordinarily editable')
    return annotation


def _annotation_dimensions(results: Any) -> tuple[int, int]:
    if not isinstance(results, Sequence) or isinstance(results, (str, bytes, bytearray)) or not results:
        raise DraftCatalogError('authoritative annotation result must be non-empty')
    dimensions: set[tuple[int, int]] = set()
    for result in results:
        if not isinstance(result, Mapping):
            raise DraftCatalogError('authoritative annotation result must contain JSON objects')
        width = result.get('original_width')
        height = result.get('original_height')
        if (
            isinstance(width, bool)
            or not isinstance(width, int)
            or width <= 0
            or isinstance(height, bool)
            or not isinstance(height, int)
            or height <= 0
        ):
            raise DraftCatalogError('authoritative annotation dimensions must be positive integers')
        dimensions.add((width, height))
    if len(dimensions) != 1:
        raise DraftCatalogError('authoritative annotation dimensions are inconsistent')
    return next(iter(dimensions))


def _validate_baseline(baseline: DraftRestore, *, split: str, image_id: int) -> None:
    if not isinstance(baseline, DraftRestore) or baseline.split != split or baseline.image_id != image_id:
        raise DraftCatalogError('working store returned the wrong baseline identity')


def _row_dimension(baseline: DraftRestore, field: str) -> int:
    value = baseline.row.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DraftCatalogError(f'working baseline {field} is invalid')
    return value


def _baseline_semantic_hash(baseline: DraftRestore) -> str:
    objects = baseline.row.get('objects')
    if not isinstance(objects, list):
        raise DraftCatalogError('working baseline objects are invalid')
    inverse = {value: key for key, value in baseline.region_id_mapping.items()}
    if len(inverse) != len(baseline.region_id_mapping):
        raise DraftCatalogError('working baseline region mapping is ambiguous')
    regions: list[dict[str, Any]] = []
    for obj in objects:
        if not isinstance(obj, Mapping):
            raise DraftCatalogError('working baseline object is invalid')
        object_id = obj.get('coco_ann_id')
        region_key = inverse.get(object_id)
        if region_key is None:
            raise DraftCatalogError('working baseline object identity is unmapped')
        region = dict(obj)
        region['region_key'] = region_key
        regions.append(region)
    return semantic_hash(regions)


def _expected_draft_token(value: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {
        'draft_id',
        'draft_updated_at',
        'draft_semantic_hash',
    }:
        raise DraftCatalogError('expected Draft token has an unsupported shape')
    draft_id = _canonical_pk(value['draft_id'], field='expected Draft id')
    updated_at = value['draft_updated_at']
    semantic = value['draft_semantic_hash']
    if not isinstance(updated_at, str) or not updated_at:
        raise DraftCatalogError('expected Draft revision must be non-empty text')
    if not _is_sha256(semantic):
        raise DraftCatalogError('expected Draft semantic hash must be sha256')
    return {
        'draft_id': draft_id,
        'draft_updated_at': updated_at,
        'draft_semantic_hash': semantic,
    }


def _draft_token_matches(
    *,
    draft: AnnotationDraft,
    semantic_hash: str,
    expected: Mapping[str, Any],
) -> bool:
    return (
        draft.pk == expected['draft_id']
        and _timestamp(draft.updated_at) == expected['draft_updated_at']
        and semantic_hash == expected['draft_semantic_hash']
    )


def _committed_label_studio_result(baseline: DraftRestore) -> list[dict[str, Any]]:
    row = baseline.row
    objects = row.get('objects') if isinstance(row, Mapping) else None
    width = _row_dimension(baseline, 'width')
    height = _row_dimension(baseline, 'height')
    if not isinstance(objects, list):
        raise DraftCatalogError('working baseline objects are invalid')
    inverse = {object_id: key for key, object_id in baseline.region_id_mapping.items()}
    if len(inverse) != len(baseline.region_id_mapping):
        raise DraftCatalogError('working baseline region mapping is ambiguous')

    result: list[dict[str, Any]] = []
    for ordinal, obj in enumerate(objects):
        if not isinstance(obj, Mapping):
            raise DraftCatalogError('working baseline object is invalid')
        object_id = obj.get('coco_ann_id')
        region_key = inverse.get(object_id)
        bbox = obj.get('bbox_2d')
        category_name = obj.get('category_name')
        if region_key is None or not isinstance(category_name, str) or not category_name:
            raise DraftCatalogError('working baseline object identity/class is invalid')
        try:
            x, y, rectangle_width, rectangle_height = norm1000_bbox_to_label_studio_xywh(bbox)
        except Exception as exc:
            raise DraftCatalogError('working baseline object geometry is invalid') from exc
        meta: dict[str, Any] = {
            'coordexp_region_key': region_key,
            'last_committed_bbox': list(bbox),
            'coco_ann_id': object_id,
            'coordexp_creation_ordinal': ordinal,
        }
        raw_metadata = obj.get('metadata')
        if raw_metadata is not None:
            if not isinstance(raw_metadata, Mapping):
                raise DraftCatalogError('working baseline object metadata is invalid')
            metadata = dict(raw_metadata)
            inference_origin = metadata.pop('inference_origin', None)
            inference_fields = {
                'coordexp_inference_receipt_id': metadata.pop('receipt_id', None),
                'coordexp_inference_request_id': metadata.pop('request_id', None),
                'coordexp_inference_result_id': metadata.pop('result_id', None),
                'coordexp_inference_source_draft_revision': metadata.pop('draft_revision', None),
            }
            if inference_origin is True:
                if any(not isinstance(value, str) or not value for value in inference_fields.values()):
                    raise DraftCatalogError('working baseline inference provenance is incomplete')
                meta.update(inference_fields)
            elif inference_origin is not None or any(value is not None for value in inference_fields.values()):
                raise DraftCatalogError('working baseline inference provenance is inconsistent')
            if metadata:
                meta['coordexp_training_metadata'] = metadata
        result.append(
            {
                'id': region_key,
                'type': 'rectanglelabels',
                'from_name': 'bbox',
                'to_name': 'image',
                'original_width': width,
                'original_height': height,
                'image_rotation': 0,
                'value': {
                    'x': x,
                    'y': y,
                    'width': rectangle_width,
                    'height': rectangle_height,
                    'rotation': 0,
                    'rectanglelabels': [category_name],
                },
                'meta': meta,
            }
        )
    canonicalize_label_studio_draft(
        result,
        split=baseline.split,
        image_id=baseline.image_id,
        image_width=width,
        image_height=height,
    )
    return result


def _timestamp(value: Any) -> str:
    if value is None or not hasattr(value, 'isoformat'):
        raise DraftCatalogError('database revision timestamp is invalid')
    result = value.isoformat()
    # DRF's DateTimeField renders aware UTC values with a trailing ``Z``.
    # Project-state tokens must be byte-identical to the ordinary Draft-save
    # response or a real browser can never satisfy the exact-token CAS.
    if result.endswith('+00:00'):
        result = f'{result[:-6]}Z'
    if not isinstance(result, str) or not result:
        raise DraftCatalogError('database revision timestamp is invalid')
    return result


__all__ = ['DjangoAnnotationVerifier', 'DjangoDraftCatalog', 'DraftLifecycleConflict']

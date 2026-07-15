"""Authenticated, fail-closed Label Studio Draft capture.

This module is the only vendor-aware part of the Draft catalog boundary.  The
browser supplies neither Draft identities nor source-row positions: both are
resolved from locked Label Studio rows and the parent-owned working store.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from projects.models import Project
from src.label_studio_coco_refinement.draft_adapter import (
    canonicalize_label_studio_draft,
)
from src.label_studio_coco_refinement.runtime import (
    AuthoritativeDraftSnapshot,
    DraftCatalogCapture,
    DraftCatalogError,
    DraftCatalogRequest,
)
from src.label_studio_coco_refinement.store import (
    AuthoritativeDraftIdentity,
    BatchMember,
    BatchRequest,
    DraftRestore,
    WorkingDatasetStore,
    canonical_json,
    semantic_hash,
    sha256_json,
)
from tasks.models import Annotation, AnnotationDraft, Prediction, Task

_SUPPORTED_SPLITS = frozenset({'train', 'val'})


@dataclass(frozen=True)
class _LockedDraft:
    draft: AnnotationDraft
    task: Task
    annotation: Annotation
    split: str
    image_id: int
    source_line: int


class DjangoDraftCatalog:
    """Capture all changed authoritative Drafts for one current user."""

    def __init__(
        self,
        stores: Mapping[str, WorkingDatasetStore],
        project_ids: Mapping[str, int | str],
    ) -> None:
        self._project_ids = _normalize_project_map(project_ids)
        self._stores = _normalize_store_map(stores, expected=self._project_ids)

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


def _timestamp(value: Any) -> str:
    if value is None or not hasattr(value, 'isoformat'):
        raise DraftCatalogError('database revision timestamp is invalid')
    result = value.isoformat()
    if not isinstance(result, str) or not result:
        raise DraftCatalogError('database revision timestamp is invalid')
    return result


__all__ = ['DjangoAnnotationVerifier', 'DjangoDraftCatalog']

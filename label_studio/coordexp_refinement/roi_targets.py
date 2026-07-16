"""Server-owned Django target capture for one managed ROI request.

The browser supplies only a project/task selection, one temporary ROI, one
canvas size, and an allowlisted profile selector.  Dataset identity, Draft and
annotation identity, generation, image path, and every revision are derived
again while the corresponding Label Studio rows are locked.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any, Protocol
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from PIL import Image, UnidentifiedImageError
from projects.models import Project
from src.label_studio_coco_refinement.draft_adapter import (
    canonicalize_label_studio_draft,
)
from src.label_studio_coco_refinement.inference_results import CurrentTarget, RequestTarget
from src.label_studio_coco_refinement.project import local_files_image_locator
from src.label_studio_coco_refinement.roi_transform import RoiLetterboxTransform
from src.label_studio_coco_refinement.store import (
    DraftRestore,
    WorkingDatasetStore,
    semantic_hash,
)
from tasks.models import Annotation, AnnotationDraft, Prediction, Task

_SUPPORTED_SPLITS = frozenset({'train', 'val'})
_TASK_DATA_FIELDS = frozenset({'image', 'coordexp_task_key', 'split', 'image_id', 'source_line'})
_O_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
_O_DIRECTORY = getattr(os, 'O_DIRECTORY', 0)
_O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
_O_NONBLOCK = getattr(os, 'O_NONBLOCK', 0)


class DjangoRoiTargetError(RuntimeError):
    """The live vendor state cannot prove one managed ROI target."""


@dataclass(frozen=True)
class ResolvedRoiProfile:
    """Credential-free profile identity needed at the Django trust boundary."""

    fingerprint: str
    processor_factor: int
    default_width: int
    default_height: int
    min_axis_pixels: int
    max_axis_pixels: int
    max_total_pixels: int
    deadline_seconds: float

    def __post_init__(self) -> None:
        _sha256(self.fingerprint, field='profile fingerprint')
        for attribute in (
            'processor_factor',
            'default_width',
            'default_height',
            'min_axis_pixels',
            'max_axis_pixels',
        ):
            _positive_int(getattr(self, attribute), field=attribute)
        _positive_int(self.max_total_pixels, field='max_total_pixels')
        if self.min_axis_pixels > self.max_axis_pixels:
            raise DjangoRoiTargetError('profile axis bounds are inverted')
        if (
            isinstance(self.deadline_seconds, bool)
            or not isinstance(self.deadline_seconds, (int, float))
            or not math.isfinite(self.deadline_seconds)
            or self.deadline_seconds <= 0
        ):
            raise DjangoRoiTargetError('profile deadline must be finite and positive')
        self.validate_canvas(self.default_width, self.default_height)

    def validate_canvas(self, width: int, height: int) -> None:
        width = _positive_int(width, field='resolution width')
        height = _positive_int(height, field='resolution height')
        if width % self.processor_factor or height % self.processor_factor:
            raise DjangoRoiTargetError('resolution must be divisible by the active profile factor')
        if not (
            self.min_axis_pixels <= width <= self.max_axis_pixels
            and self.min_axis_pixels <= height <= self.max_axis_pixels
        ):
            raise DjangoRoiTargetError('resolution is outside active profile axis bounds')
        if width * height > self.max_total_pixels:
            raise DjangoRoiTargetError('resolution exceeds active profile total pixels')


class RoiProfileResolver(Protocol):
    """Server-owned profile activation/current-profile seam."""

    def resolve_selected(self, *, project_id: str, selector: str) -> ResolvedRoiProfile: ...

    def current(self, *, project_id: str) -> ResolvedRoiProfile: ...


@dataclass(frozen=True)
class DjangoRoiProjectBinding:
    project_pk: int
    split: str
    store: WorkingDatasetStore
    image_root: Path
    profiles: RoiProfileResolver
    _image_root_device: int = field(init=False, repr=False)
    _image_root_inode: int = field(init=False, repr=False)

    def __post_init__(self) -> None:
        _positive_int(self.project_pk, field='project_pk')
        if self.split not in _SUPPORTED_SPLITS:
            raise DjangoRoiTargetError('split must be train or val')
        for method in ('restore_draft', 'resolve_source_row_index'):
            if not callable(getattr(self.store, method, None)):
                raise DjangoRoiTargetError(f'working store must provide {method}()')
        for method in ('resolve_selected', 'current'):
            if not callable(getattr(self.profiles, method, None)):
                raise DjangoRoiTargetError(f'profile resolver must provide {method}()')
        root, device, inode = _strict_image_root(self.image_root)
        object.__setattr__(self, 'image_root', root)
        object.__setattr__(self, '_image_root_device', device)
        object.__setattr__(self, '_image_root_inode', inode)

    @property
    def image_root_identity(self) -> tuple[int, int]:
        return self._image_root_device, self._image_root_inode


@dataclass(frozen=True)
class CapturedRoiTarget:
    """Exact source image plus the transform and immutable request target."""

    target: RequestTarget
    transform: RoiLetterboxTransform
    image: Image.Image

    def close(self) -> None:
        self.image.close()

    def __enter__(self) -> 'CapturedRoiTarget':
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


@dataclass(frozen=True)
class _LockedRoiState:
    binding: DjangoRoiProjectBinding
    user: Any
    project: Project
    draft: AnnotationDraft
    task: Task
    annotation: Annotation
    baseline: DraftRestore
    task_key: str
    task_epoch: str
    image_id: int
    source_line: int
    image_relative: PurePosixPath
    width: int
    height: int


class DjangoRoiTargetCatalog:
    """Capture and re-read one target without trusting browser identities."""

    def __init__(
        self,
        bindings: Mapping[int | str, DjangoRoiProjectBinding],
    ) -> None:
        if not isinstance(bindings, Mapping) or not bindings:
            raise DjangoRoiTargetError('ROI project bindings must be non-empty')
        normalized: dict[int, DjangoRoiProjectBinding] = {}
        for raw_pk, binding in bindings.items():
            project_pk = _canonical_pk(raw_pk, field='project binding key')
            if not isinstance(binding, DjangoRoiProjectBinding):
                raise DjangoRoiTargetError('ROI project binding has an invalid type')
            if binding.project_pk != project_pk:
                raise DjangoRoiTargetError('ROI project binding key/payload mismatch')
            if project_pk in normalized:
                raise DjangoRoiTargetError('duplicate ROI project binding')
            normalized[project_pk] = binding
        object.__setattr__(self, '_bindings', MappingProxyType(normalized))

    def capture(
        self,
        *,
        user: Any,
        project_pk: int,
        task_pk: int,
        request_id: str,
        roi: Mapping[str, Any] | Sequence[float],
        resolution: Mapping[str, Any] | Sequence[int],
        profile_selector: str,
    ) -> CapturedRoiTarget:
        """Freeze a target from Label Studio percent xywh and decode its image."""

        user_pk = _principal_pk(user)
        project_pk = _canonical_pk(project_pk, field='project_pk')
        task_pk = _canonical_pk(task_pk, field='task_pk')
        request_id = _canonical_uuid(request_id)
        selector = _normalized_text(profile_selector, field='profile selector')
        binding = self._binding_for_pk(project_pk)
        roi_xywh = _roi_xywh(roi)
        canvas_width, canvas_height = _resolution(resolution)

        # Profile activation may load a resident engine and always verifies
        # immutable artifacts.  Keep that work outside Django transactions and
        # row locks; the launch manager serializes activation through infer().
        try:
            profile = binding.profiles.resolve_selected(
                project_id=str(project_pk),
                selector=selector,
            )
            _require_profile(profile)
            profile.validate_canvas(canvas_width, canvas_height)
        except DjangoRoiTargetError:
            raise
        except Exception as exc:
            raise DjangoRoiTargetError('ROI profile activation failed closed') from exc

        try:
            with transaction.atomic():
                state = _lock_roi_state(
                    binding=binding,
                    user_pk=user_pk,
                    task_pk=task_pk,
                )
                transform = RoiLetterboxTransform.from_label_studio_roi(
                    source_width=state.width,
                    source_height=state.height,
                    roi=roi_xywh,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
                draft_revision = canonical_db_revision(state.draft.updated_at)
                annotation_revision = canonical_db_revision(state.annotation.updated_at)
                canonical = canonicalize_label_studio_draft(
                    state.draft.result,
                    split=binding.split,
                    image_id=state.image_id,
                    image_width=state.width,
                    image_height=state.height,
                )
                target = RequestTarget(
                    request_id=request_id,
                    project_id=str(project_pk),
                    task_id=state.task_key,
                    task_epoch=state.task_epoch,
                    image_id=str(state.image_id),
                    annotation_id=str(state.annotation.pk),
                    annotation_revision=annotation_revision,
                    current_user_id=str(state.user.pk),
                    draft_id=str(state.draft.pk),
                    draft_revision=draft_revision,
                    profile_fingerprint=profile.fingerprint,
                    project_generation=state.baseline.generation,
                    transform_fingerprint=transform.fingerprint,
                    preexisting_draft_dirty=(canonical.semantic_hash != _baseline_semantic_hash(state.baseline)),
                )
                image_relative = state.image_relative
                expected_size = (state.width, state.height)
        except DjangoRoiTargetError:
            raise
        except Exception as exc:
            raise DjangoRoiTargetError('ROI target capture failed closed') from exc

        image = _load_managed_rgb_image(
            binding.image_root,
            image_relative,
            expected_size=expected_size,
            expected_root_identity=binding.image_root_identity,
        )
        return CapturedRoiTarget(target=target, transform=transform, image=image)

    def current_target(self, frozen: RequestTarget) -> CurrentTarget:
        """Re-lock and derive every mutable binding immediately before insert."""

        if not isinstance(frozen, RequestTarget):
            raise DjangoRoiTargetError('frozen target has an invalid type')
        project_pk = _canonical_text_pk(frozen.project_id, field='project_id')
        user_pk = _canonical_text_pk(frozen.current_user_id, field='current_user_id')
        draft_pk = _canonical_text_pk(frozen.draft_id, field='draft_id')
        binding = self._binding_for_pk(project_pk)
        try:
            profile = binding.profiles.current(project_id=str(project_pk))
            _require_profile(profile)
        except DjangoRoiTargetError:
            raise
        except Exception as exc:
            raise DjangoRoiTargetError('current ROI profile lookup failed closed') from exc
        try:
            with transaction.atomic():
                state = _lock_roi_state(
                    binding=binding,
                    user_pk=user_pk,
                    draft_pk=draft_pk,
                )
                return CurrentTarget(
                    project_id=str(state.project.pk),
                    task_id=state.task_key,
                    task_epoch=state.task_epoch,
                    image_id=str(state.image_id),
                    annotation_id=str(state.annotation.pk),
                    annotation_revision=canonical_db_revision(state.annotation.updated_at),
                    current_user_id=str(state.user.pk),
                    draft_id=str(state.draft.pk),
                    draft_revision=canonical_db_revision(state.draft.updated_at),
                    profile_fingerprint=profile.fingerprint,
                    project_generation=state.baseline.generation,
                )
        except DjangoRoiTargetError:
            raise
        except Exception as exc:
            raise DjangoRoiTargetError('current ROI target lookup failed closed') from exc

    def _binding_for_pk(self, project_pk: int) -> DjangoRoiProjectBinding:
        binding = self._bindings.get(project_pk)
        if binding is None:
            raise DjangoRoiTargetError('project has no server-owned ROI binding')
        return binding

    def binding_for_project_id(self, project_id: str) -> DjangoRoiProjectBinding:
        """Resolve a frozen project lookup only through the allowlisted map."""

        return self._binding_for_pk(_canonical_text_pk(project_id, field='project_id'))


def _lock_roi_state(
    *,
    binding: DjangoRoiProjectBinding,
    user_pk: int,
    task_pk: int | None = None,
    draft_pk: int | None = None,
) -> _LockedRoiState:
    """Lock user -> project -> Draft -> Task -> Annotation/Prediction."""

    if (task_pk is None) == (draft_pk is None):
        raise DjangoRoiTargetError('exactly one task or Draft lookup is required')
    try:
        user = get_user_model().objects.select_for_update().get(pk=user_pk, is_active=True)
        project = Project.objects.for_user(user).select_for_update().get(pk=binding.project_pk)
    except Exception as exc:
        raise DjangoRoiTargetError('active principal cannot access ROI project') from exc

    drafts_query = AnnotationDraft.objects.select_for_update().filter(
        user_id=user.pk,
        task__project_id=project.pk,
    )
    if task_pk is not None:
        drafts_query = drafts_query.filter(task_id=task_pk)
    else:
        drafts_query = drafts_query.filter(pk=draft_pk)
    drafts = list(drafts_query.order_by('task_id', 'pk'))
    if len(drafts) != 1:
        raise DjangoRoiTargetError('task must have exactly one current-user authoritative Draft')
    draft = drafts[0]
    if draft.task_id is None or draft.annotation_id is None:
        raise DjangoRoiTargetError('authoritative Draft is missing its binding')

    try:
        task = Task.objects.select_for_update().get(pk=draft.task_id)
    except Exception as exc:
        raise DjangoRoiTargetError('authoritative Draft task is missing') from exc
    if task_pk is not None and task.pk != task_pk:
        raise DjangoRoiTargetError('Draft task lookup changed under lock')
    if task.project_id != project.pk:
        raise DjangoRoiTargetError('Draft task/project binding is invalid')

    all_current_user_drafts = list(
        AnnotationDraft.objects.select_for_update().filter(user_id=user.pk, task_id=task.pk).order_by('pk')
    )
    if len(all_current_user_drafts) != 1 or all_current_user_drafts[0].pk != draft.pk:
        raise DjangoRoiTargetError('task has duplicate current-user authoritative Drafts')

    annotations = list(Annotation.objects.select_for_update().filter(task_id=task.pk).order_by('pk'))
    if Prediction.objects.select_for_update().filter(task_id=task.pk).exists():
        raise DjangoRoiTargetError('managed ROI task cannot contain predictions')
    if len(annotations) != 1:
        raise DjangoRoiTargetError('managed ROI task must have exactly one authoritative annotation')
    annotation = annotations[0]
    if annotation.ground_truth or annotation.was_cancelled:
        raise DjangoRoiTargetError('authoritative annotation is not ordinarily editable')
    if annotation.project_id != project.pk or draft.annotation_id != annotation.pk or draft.task_id != task.pk:
        raise DjangoRoiTargetError('Draft/annotation/task binding is invalid')

    task_key, image_id, source_line = _managed_task_identity(
        task,
        binding=binding,
    )
    baseline = binding.store.restore_draft(image_id)
    if not isinstance(baseline, DraftRestore) or baseline.split != binding.split or baseline.image_id != image_id:
        raise DjangoRoiTargetError('working store returned the wrong ROI baseline')
    source_index = binding.store.resolve_source_row_index(
        split=binding.split,
        project_id=str(project.pk),
        task_id=task_key,
        image_id=image_id,
    )
    if source_index != source_line - 1:
        raise DjangoRoiTargetError('task source line does not match working authority')
    row = baseline.row
    if not isinstance(row, Mapping) or row.get('image_id') != image_id:
        raise DjangoRoiTargetError('working baseline image identity is invalid')
    width = _positive_int(row.get('width'), field='working image width')
    height = _positive_int(row.get('height'), field='working image height')
    image_relative = _managed_image_relative(row.get('file_name'), split=binding.split, image_id=image_id)
    expected_locator = local_files_image_locator(str(PurePosixPath('images') / image_relative), split=binding.split)
    if task.data['image'] != expected_locator:
        raise DjangoRoiTargetError('task image locator differs from working authority')
    _validate_annotation_dimensions(annotation.result, width=width, height=height)
    task_epoch = _task_epoch(
        project_pk=project.pk,
        task_pk=task.pk,
        task_data=task.data,
    )
    return _LockedRoiState(
        binding=binding,
        user=user,
        project=project,
        draft=draft,
        task=task,
        annotation=annotation,
        baseline=baseline,
        task_key=task_key,
        task_epoch=task_epoch,
        image_id=image_id,
        source_line=source_line,
        image_relative=image_relative,
        width=width,
        height=height,
    )


def canonical_db_revision(value: Any) -> str:
    """Return one canonical UTC microsecond timestamp with a ``Z`` suffix."""

    if not isinstance(value, datetime) or value.tzinfo is None:
        raise DjangoRoiTargetError('database revision must be timezone-aware')
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def parse_canonical_revision(value: Any, *, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith('Z'):
        raise DjangoRoiTargetError(f'{field} must be a canonical UTC revision')
    try:
        parsed = datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as exc:
        raise DjangoRoiTargetError(f'{field} must be a canonical UTC revision') from exc
    if canonical_db_revision(parsed) != value:
        raise DjangoRoiTargetError(f'{field} must be a canonical UTC revision')
    return parsed


def _managed_task_identity(task: Task, *, binding: DjangoRoiProjectBinding) -> tuple[str, int, int]:
    data = task.data
    if not isinstance(data, Mapping) or set(data) != _TASK_DATA_FIELDS:
        raise DjangoRoiTargetError('managed task data has an unsupported shape')
    split = data.get('split')
    image_id = data.get('image_id')
    source_line = data.get('source_line')
    if split != binding.split:
        raise DjangoRoiTargetError('task split differs from project binding')
    image_id = _positive_int(image_id, field='task image_id')
    source_line = _positive_int(source_line, field='task source_line')
    task_key = f'{binding.split}:{image_id}'
    if data.get('coordexp_task_key') != task_key:
        raise DjangoRoiTargetError('task key differs from split/image identity')
    return task_key, image_id, source_line


def _managed_image_relative(value: Any, *, split: str, image_id: int) -> PurePosixPath:
    if not isinstance(value, str) or not value or '\\' in value:
        raise DjangoRoiTargetError('working image locator must be canonical text')
    relative = PurePosixPath(value)
    expected = PurePosixPath('images', f'{split}2017', f'{image_id:012d}.jpg')
    if relative != expected or relative.is_absolute() or '..' in relative.parts:
        raise DjangoRoiTargetError('working image locator is outside managed identity')
    return PurePosixPath(*relative.parts[1:])


def _task_epoch(*, project_pk: int, task_pk: int, task_data: Mapping[str, Any]) -> str:
    return proof_json_sha256(
        {
            'schema_version': 'coordexp-roi-task-epoch-v1',
            'project_pk': project_pk,
            'task_pk': task_pk,
            'task_data': copy.deepcopy(dict(task_data)),
        }
    )


def proof_json_sha256(value: Any) -> str:
    """Proof-compatible strict SHA-256 without model-runtime imports."""

    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(',', ':'),
            sort_keys=True,
        ).encode('utf-8')
    except (TypeError, ValueError) as exc:
        raise DjangoRoiTargetError('proof payload must be finite strict JSON') from exc
    return hashlib.sha256(encoded).hexdigest()


def _validate_annotation_dimensions(results: Any, *, width: int, height: int) -> None:
    if not isinstance(results, Sequence) or isinstance(results, (str, bytes, bytearray)) or not results:
        raise DjangoRoiTargetError('authoritative annotation result is invalid')
    for result in results:
        if not isinstance(result, Mapping):
            raise DjangoRoiTargetError('authoritative annotation result is invalid')
        if result.get('original_width') != width or result.get('original_height') != height:
            raise DjangoRoiTargetError('authoritative annotation dimensions differ from working authority')


def _baseline_semantic_hash(baseline: DraftRestore) -> str:
    objects = baseline.row.get('objects')
    if not isinstance(objects, list):
        raise DjangoRoiTargetError('working baseline objects are invalid')
    inverse = {value: key for key, value in baseline.region_id_mapping.items()}
    if len(inverse) != len(baseline.region_id_mapping):
        raise DjangoRoiTargetError('working baseline region mapping is ambiguous')
    regions: list[dict[str, Any]] = []
    for obj in objects:
        if not isinstance(obj, Mapping):
            raise DjangoRoiTargetError('working baseline object is invalid')
        region_key = inverse.get(obj.get('coco_ann_id'))
        if region_key is None:
            raise DjangoRoiTargetError('working baseline object identity is unmapped')
        region = copy.deepcopy(dict(obj))
        region['region_key'] = region_key
        regions.append(region)
    return semantic_hash(regions)


def _strict_image_root(value: Any) -> tuple[Path, int, int]:
    if not isinstance(value, Path):
        value = Path(value)
    lexical = Path(os.path.abspath(os.fspath(value.expanduser())))
    root_fd: int | None = None
    try:
        resolved = lexical.resolve(strict=True)
        before = os.stat(lexical, follow_symlinks=False)
        root_fd = os.open(
            lexical,
            os.O_RDONLY | _O_CLOEXEC | _O_DIRECTORY | _O_NOFOLLOW,
        )
        opened = os.fstat(root_fd)
        after = os.stat(lexical, follow_symlinks=False)
    except OSError as exc:
        raise DjangoRoiTargetError('managed image root is unavailable') from exc
    finally:
        if root_fd is not None:
            os.close(root_fd)
    identities = {
        (before.st_dev, before.st_ino),
        (opened.st_dev, opened.st_ino),
        (after.st_dev, after.st_ino),
    }
    if (
        resolved != lexical
        or len(identities) != 1
        or not all(stat.S_ISDIR(item.st_mode) for item in (before, opened, after))
    ):
        raise DjangoRoiTargetError('managed image root cannot contain symlink indirection')
    return lexical, opened.st_dev, opened.st_ino


def _load_managed_rgb_image(
    root: Path,
    relative: PurePosixPath,
    *,
    expected_size: tuple[int, int],
    expected_root_identity: tuple[int, int],
) -> Image.Image:
    if relative.is_absolute() or not relative.parts or '..' in relative.parts:
        raise DjangoRoiTargetError('managed image path escapes the image root')
    descriptors: list[int] = []
    try:
        directory_fd = os.open(
            root,
            os.O_RDONLY | _O_CLOEXEC | _O_DIRECTORY | _O_NOFOLLOW,
        )
        descriptors.append(directory_fd)
        root_metadata = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(root_metadata.st_mode)
            or (root_metadata.st_dev, root_metadata.st_ino) != expected_root_identity
        ):
            raise DjangoRoiTargetError('managed image root identity changed after binding')
        for component in relative.parts[:-1]:
            directory_fd = os.open(
                component,
                os.O_RDONLY | _O_CLOEXEC | _O_DIRECTORY | _O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            descriptors.append(directory_fd)
        image_fd = os.open(
            relative.parts[-1],
            os.O_RDONLY | _O_CLOEXEC | _O_NOFOLLOW | _O_NONBLOCK,
            dir_fd=directory_fd,
        )
        descriptors.append(image_fd)
        before = os.fstat(image_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
            raise DjangoRoiTargetError('managed image must be a non-empty regular file')
        with os.fdopen(os.dup(image_fd), 'rb', closefd=True) as handle:
            with Image.open(handle) as decoded:
                decoded.load()
                rgb = decoded.convert('RGB')
                rgb.load()
        after = os.fstat(image_fd)
        identity_before = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        )
        identity_after = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        )
        if identity_before != identity_after:
            rgb.close()
            raise DjangoRoiTargetError('managed image changed while it was decoded')
        if rgb.size != expected_size:
            rgb.close()
            raise DjangoRoiTargetError('decoded image dimensions differ from working authority')
        return rgb
    except DjangoRoiTargetError:
        raise
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        raise DjangoRoiTargetError('managed image load failed closed') from exc
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _require_profile(value: Any) -> ResolvedRoiProfile:
    if not isinstance(value, ResolvedRoiProfile):
        raise DjangoRoiTargetError('profile resolver returned an invalid identity')
    value.__post_init__()
    return value


def _roi_xywh(value: Mapping[str, Any] | Sequence[float]) -> tuple[float, ...]:
    if isinstance(value, Mapping):
        if set(value) != {'x', 'y', 'width', 'height'}:
            raise DjangoRoiTargetError('ROI must contain x, y, width, and height')
        return tuple(value[field] for field in ('x', 'y', 'width', 'height'))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        if len(value) == 4:
            return tuple(value)
    raise DjangoRoiTargetError('ROI must be one four-value percentage rectangle')


def _resolution(value: Mapping[str, Any] | Sequence[int]) -> tuple[int, int]:
    if isinstance(value, Mapping):
        if set(value) != {'width', 'height'}:
            raise DjangoRoiTargetError('resolution must contain width and height')
        raw = (value['width'], value['height'])
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)) and len(value) == 2:
        raw = tuple(value)
    else:
        raise DjangoRoiTargetError('resolution must contain two dimensions')
    return (
        _positive_int(raw[0], field='resolution width'),
        _positive_int(raw[1], field='resolution height'),
    )


def _principal_pk(user: Any) -> int:
    if getattr(user, 'is_authenticated', False) is not True:
        raise DjangoRoiTargetError('an authenticated principal is required')
    return _canonical_pk(getattr(user, 'pk', None), field='principal user id')


def _canonical_uuid(value: Any) -> str:
    if not isinstance(value, str):
        raise DjangoRoiTargetError('request_id must be a canonical UUID')
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise DjangoRoiTargetError('request_id must be a canonical UUID') from exc
    if str(parsed) != value:
        raise DjangoRoiTargetError('request_id must be a canonical UUID')
    return value


def _canonical_pk(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise DjangoRoiTargetError(f'{field} must be a canonical positive integer')
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        result = int(value)
        if str(result) != value:
            raise DjangoRoiTargetError(f'{field} must be a canonical positive integer')
    else:
        raise DjangoRoiTargetError(f'{field} must be a canonical positive integer')
    if result <= 0:
        raise DjangoRoiTargetError(f'{field} must be a canonical positive integer')
    return result


def _canonical_text_pk(value: Any, *, field: str) -> int:
    if not isinstance(value, str):
        raise DjangoRoiTargetError(f'{field} must be canonical decimal text')
    return _canonical_pk(value, field=field)


def _positive_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DjangoRoiTargetError(f'{field} must be a positive integer')
    return value


def _normalized_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise DjangoRoiTargetError(f'{field} must be non-empty trimmed text')
    return value


def _sha256(value: Any, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in '0123456789abcdef' for character in value)
    ):
        raise DjangoRoiTargetError(f'{field} must be a lowercase SHA-256')
    return value


__all__ = [
    'CapturedRoiTarget',
    'DjangoRoiProjectBinding',
    'DjangoRoiTargetCatalog',
    'DjangoRoiTargetError',
    'ResolvedRoiProfile',
    'RoiProfileResolver',
    'canonical_db_revision',
    'parse_canonical_revision',
    'proof_json_sha256',
]

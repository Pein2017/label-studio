from __future__ import annotations

from functools import lru_cache
import logging
import os
import posixpath
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict, Iterable, Optional
from urllib.parse import parse_qs, urlencode, unquote, urlparse, urlunparse

from django.conf import settings
from django.utils._os import safe_join
from PIL import Image
from rest_framework.exceptions import ValidationError
from tasks.result_normalization import calibrate_result_item, get_result_item_rotation

logger = logging.getLogger(__name__)

LOCAL_FILES_ROUTE = '/data/local-files'
SUPPORTED_ROTATIONS = {0, 90, 180, 270}
EXIF_ORIENTATION_TAG = 274
EXIF_ORIENTATION_TO_DISPLAY_ROTATION = {
    3: 180,
    6: 90,
    8: 270,
}
TRANSPOSE_BY_ROTATION = {
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}


def calibrate_annotation_result_for_local_files(task, result):
    """Persist image rotation for Local Files tasks and normalize the annotation payload."""
    result = result or []
    rotations_by_item = _collect_item_rotations(result)

    if not rotations_by_item:
        return result

    calibrated_result = _calibrate_result_to_final_rotations(result, rotations_by_item)

    for item_index, rotation in rotations_by_item.items():
        image_path = _resolve_task_local_image_path(task, item_index)

        if image_path is None:
            raise ValidationError(
                f'Image calibration can only overwrite Local Files images with a resolvable source path. '
                f'Unable to resolve image for item_index={item_index}.'
            )

        _rotate_image_file_in_place(image_path, rotation)
        _refresh_task_image_url(task, item_index, image_path)

    return calibrated_result


def calibrate_exported_annotation_result_for_local_files(task, result):
    """Normalize exported annotations back into the raw local-file pixel space.

    Label Studio's frontend renders JPEG EXIF orientation automatically. When the
    underlying file keeps its original pixel matrix plus EXIF metadata, exported
    coordinates can otherwise remain in the display-oriented coordinate system.
    """
    result = result or []
    rotations_by_item = _collect_export_rotations_by_item(task, result)

    if not rotations_by_item:
        return result

    calibrated_result = []

    for item in result:
        if not isinstance(item, dict) or item.get('type') == 'relation':
            calibrated_result.append(item)
            continue

        item_index = int(item.get('item_index') or 0)
        target_rotation = rotations_by_item.get(item_index, 0)

        if not _is_spatial_result_item(item):
            calibrated_item = dict(item)
            calibrated_item['image_rotation'] = 0
            calibrated_result.append(calibrated_item)
            continue

        if target_rotation == 0:
            calibrated_item = dict(item)
            calibrated_item['image_rotation'] = 0
            calibrated_result.append(calibrated_item)
            continue

        rotated_item = dict(item)
        existing_rotation = get_result_item_rotation(rotated_item)
        rotated_item['image_rotation'] = (existing_rotation + target_rotation) % 360
        calibrated_result.append(calibrate_result_item(rotated_item, strict=True))

    return calibrated_result


def _is_spatial_result_item(item: Dict[str, Any]) -> bool:
    if not isinstance(item, dict) or item.get('type') == 'relation':
        return False

    value = item.get('value')

    if not isinstance(value, dict):
        return False

    return (
        isinstance(value.get('vertices'), list)
        or isinstance(value.get('points'), list)
        or ('width' in value and 'height' in value)
        or ('x' in value and 'y' in value)
    )


def _collect_export_rotations_by_item(task, result: Iterable[Dict[str, Any]]) -> Dict[int, int]:
    item_indexes = set()

    for item in result:
        if not _is_spatial_result_item(item):
            continue
        item_indexes.add(int(item.get('item_index') or 0))

    rotations_by_item: Dict[int, int] = {}

    for item_index in item_indexes:
        image_path = _resolve_task_local_image_path(task, item_index)
        if image_path is None:
            continue

        rotation = _get_export_rotation_from_exif(image_path)
        if rotation:
            rotations_by_item[item_index] = rotation

    return rotations_by_item


def _collect_item_rotations(result: Iterable[Dict[str, Any]]) -> Dict[int, int]:
    rotations_by_item: Dict[int, set[int]] = {}

    for item in result:
        if not _is_spatial_result_item(item):
            continue

        item_index = int(item.get('item_index') or 0)
        rotation = get_result_item_rotation(item)

        if rotation not in SUPPORTED_ROTATIONS:
            raise ValidationError(
                f'Image calibration supports only 90° steps. Found image_rotation={rotation} for item_index={item_index}.'
            )

        rotations_by_item.setdefault(item_index, set()).add(rotation)

    normalized_rotations: Dict[int, int] = {}

    for item_index, rotations in rotations_by_item.items():
        non_zero_rotations = {rotation for rotation in rotations if rotation}

        if len(non_zero_rotations) > 1:
            raise ValidationError(
                'Please rotate the image to its final orientation before annotating. '
                f'Found mixed image_rotation values for item_index={item_index}: {sorted(rotations)}.'
            )

        rotation = next(iter(non_zero_rotations), 0)
        if rotation:
            normalized_rotations[item_index] = rotation

    return normalized_rotations


def _calibrate_result_to_final_rotations(result: Iterable[Dict[str, Any]], rotations_by_item: Dict[int, int]):
    calibrated_result = []

    for item in result:
        if not isinstance(item, dict) or item.get('type') == 'relation':
            calibrated_result.append(item)
            continue

        item_index = int(item.get('item_index') or 0)
        target_rotation = rotations_by_item.get(item_index, 0)

        if not _is_spatial_result_item(item):
            calibrated_item = dict(item)
            calibrated_item['image_rotation'] = 0
            calibrated_result.append(calibrated_item)
            continue

        if target_rotation == 0:
            calibrated_item = dict(item)
            calibrated_item['image_rotation'] = 0
            calibrated_result.append(calibrated_item)
            continue

        rotated_item = dict(item)
        rotated_item['image_rotation'] = target_rotation
        calibrated_result.append(calibrate_result_item(rotated_item, strict=True))

    return calibrated_result


def _resolve_task_local_image_path(task, item_index: int) -> Optional[Path]:
    from io_storages.localfiles.models import LocalFilesImportStorage

    source_path = _resolve_task_source_path(task, item_index)
    if source_path is not None:
        return source_path

    relative_path = _resolve_task_local_relative_path(task, item_index)

    if not relative_path:
        return None

    full_path = Path(safe_join(settings.LOCAL_FILES_DOCUMENT_ROOT, relative_path)).resolve()

    if not full_path.is_file():
        return None

    storages = LocalFilesImportStorage.objects.filter(project_id=task.project_id)

    for storage in storages:
        if not storage.path:
            continue

        storage_root = Path(storage.path).resolve()

        if full_path == storage_root or storage_root in full_path.parents:
            return full_path

    return None


def _resolve_task_source_path(task, item_index: int) -> Optional[Path]:
    if item_index != 0:
        return None

    source_path = (task.data or {}).get('source_path')

    if not isinstance(source_path, str) or not source_path:
        return None

    resolved = Path(source_path).expanduser().resolve()
    if resolved.is_file():
        return resolved

    source_relpath = (task.data or {}).get('source_relpath')

    if not isinstance(source_relpath, str) or not source_relpath:
        return None

    root = _resolve_pigtail_root()

    if root is None:
        return None

    relative_candidate = (root / source_relpath).resolve()
    return relative_candidate if relative_candidate.is_file() else None


def _resolve_pigtail_root() -> Optional[Path]:
    env_root = os.environ.get('PIGTAIL_ROOT')

    if env_root:
        resolved = Path(env_root).expanduser().resolve()
        if resolved.exists():
            return resolved

    doc_root = getattr(settings, 'LOCAL_FILES_DOCUMENT_ROOT', None)

    if not doc_root:
        return None

    try:
        return Path(doc_root).resolve().parents[1]
    except IndexError:
        return None


def _resolve_task_local_relative_path(task, item_index: int) -> Optional[str]:
    urls = list(_iter_task_local_image_urls(task.data or {}))

    if not urls:
        return None

    if len(urls) == 1 and urls[0]['kind'] == 'single':
        if item_index != 0:
            return None
        return urls[0]['relative_path']

    list_candidates = [candidate for candidate in urls if candidate['kind'] == 'list']

    if len(list_candidates) != 1 or len(urls) != 1:
        return None

    relative_paths = list_candidates[0]['relative_paths']

    if item_index < 0 or item_index >= len(relative_paths):
        return None

    return relative_paths[item_index]


def _iter_task_local_image_urls(task_data: Dict[str, Any]):
    for value in task_data.values():
        if isinstance(value, str):
            relative_path = _extract_local_files_relative_path(value)
            if relative_path:
                yield {'kind': 'single', 'relative_path': relative_path}
        elif isinstance(value, list) and value:
            relative_paths = []

            for item in value:
                if not isinstance(item, str):
                    relative_paths = []
                    break

                relative_path = _extract_local_files_relative_path(item)
                if not relative_path:
                    relative_paths = []
                    break

                relative_paths.append(relative_path)

            if relative_paths:
                yield {'kind': 'list', 'relative_paths': relative_paths}


def _extract_local_files_relative_path(url: str) -> Optional[str]:
    parsed = urlparse(url)
    request_path = parsed.path.rstrip('/')

    if request_path != LOCAL_FILES_ROUTE:
        return None

    relative_path = parse_qs(parsed.query).get('d', [None])[0]
    if not relative_path:
        return None

    return posixpath.normpath(unquote(relative_path)).lstrip('/')


def _get_export_rotation_from_exif(path: Path) -> int:
    try:
        orientation = _read_exif_orientation(str(path), path.stat().st_mtime_ns)
    except OSError:
        logger.warning('Failed to read EXIF orientation for %s', path)
        return 0

    display_rotation = EXIF_ORIENTATION_TO_DISPLAY_ROTATION.get(orientation, 0)
    return (-display_rotation) % 360 if display_rotation else 0


@lru_cache(maxsize=2048)
def _read_exif_orientation(path_str: str, mtime_ns: int) -> Optional[int]:
    del mtime_ns

    with Image.open(path_str) as image:
        return image.getexif().get(EXIF_ORIENTATION_TAG)


def _refresh_task_image_url(task, item_index: int, image_path: Path) -> None:
    task_data = dict(task.data or {})
    image_value = task_data.get('image')
    version = str(image_path.stat().st_mtime_ns)
    updated = False

    if isinstance(image_value, str) and item_index == 0 and _extract_local_files_relative_path(image_value):
        task_data['image'] = _with_query_param(image_value, 'v', version)
        updated = True
    elif (
        isinstance(image_value, list)
        and 0 <= item_index < len(image_value)
        and isinstance(image_value[item_index], str)
        and _extract_local_files_relative_path(image_value[item_index])
    ):
        image_list = list(image_value)
        image_list[item_index] = _with_query_param(image_list[item_index], 'v', version)
        task_data['image'] = image_list
        updated = True

    if updated and task_data != (task.data or {}):
        task.data = task_data
        task.save(update_fields=['data', 'updated_at'])


def _with_query_param(url: str, key: str, value: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    query[key] = [value]
    return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))


def _rotate_image_file_in_place(path: Path, rotation: int) -> None:
    transpose = TRANSPOSE_BY_ROTATION.get(rotation)
    if transpose is None:
        return

    temp_path = None

    try:
        with Image.open(path) as image:
            rotated = image.transpose(transpose)
            image_format = image.format
            save_kwargs = {}

            if image_format:
                save_kwargs['format'] = image_format

            if image_format == 'JPEG' and rotated.mode not in {'RGB', 'L', 'CMYK'}:
                rotated = rotated.convert('RGB')

            with NamedTemporaryFile(delete=False, dir=path.parent, suffix=path.suffix) as temp_file:
                temp_path = Path(temp_file.name)

            rotated.save(temp_path, **save_kwargs)

        os.replace(temp_path, path)
    except Exception as exc:
        logger.exception('Failed to rotate local image %s by %s degrees', path, rotation)
        raise ValidationError(f'Failed to overwrite rotated image "{path.name}": {exc}') from exc
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                logger.warning('Failed to remove temporary rotated image %s', temp_path)

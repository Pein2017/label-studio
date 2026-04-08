from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

PAIR_LABELS = {"pair", "配对"}
SUPPORTED_CALIBRATED_TYPES = {
    'choices',
    'rectangle',
    'rectanglelabels',
    'ellipse',
    'ellipselabels',
    'polygon',
    'polygonlabels',
    'keypoint',
    'keypointlabels',
    'vector',
    'vectorlabels',
}


def _is_pair_relation(item: Dict[str, Any]) -> bool:
    if not isinstance(item, dict):
        return False

    if item.get("type") != "relation":
        return False

    labels = item.get("labels") or []
    return any(label in PAIR_LABELS for label in labels)


def _is_relation(item: Dict[str, Any]) -> bool:
    return isinstance(item, dict) and item.get("type") == "relation"


def _normalize_rotation(rotation: Any) -> int:
    try:
        return int(rotation or 0) % 360
    except (TypeError, ValueError):
        return 0


def get_result_item_rotation(item: Dict[str, Any]) -> int:
    if not isinstance(item, dict):
        return 0

    return _normalize_rotation(item.get('image_rotation'))


def _get_rotated_dimensions(width: Any, height: Any, rotation: int) -> Tuple[Optional[float], Optional[float]]:
    if width in (None, 0) or height in (None, 0):
        return None, None

    width = float(width)
    height = float(height)

    if rotation in {90, 270}:
        return height, width

    return width, height


def _to_percent(value: Optional[float], size: Any) -> Optional[float]:
    if value is None or size in (None, 0):
        return None

    return float(value) * 100.0 / float(size)


def _rotate_point_pixels(x: float, y: float, width: float, height: float, rotation: int) -> Tuple[float, float]:
    if rotation == 90:
        return height - y, x
    if rotation == 180:
        return width - x, height - y
    if rotation == 270:
        return y, width - x
    return x, y


def _rotate_percent_point(x: Any, y: Any, width: Any, height: Any, rotation: int) -> Tuple[Optional[float], Optional[float]]:
    pixel_x = _to_pixels(x, width)
    pixel_y = _to_pixels(y, height)

    if pixel_x is None or pixel_y is None:
        return None, None

    rotated_width, rotated_height = _get_rotated_dimensions(width, height, rotation)
    if rotated_width in (None, 0) or rotated_height in (None, 0):
        return None, None

    next_x, next_y = _rotate_point_pixels(pixel_x, pixel_y, float(width), float(height), rotation)

    return _to_percent(next_x, rotated_width), _to_percent(next_y, rotated_height)


def _rotate_point_dict(point: Dict[str, Any], width: Any, height: Any, rotation: int) -> Dict[str, Any]:
    rotated = dict(point)

    if 'x' in rotated or 'y' in rotated:
        next_x, next_y = _rotate_percent_point(rotated.get('x'), rotated.get('y'), width, height, rotation)
        if next_x is not None:
            rotated['x'] = next_x
        if next_y is not None:
            rotated['y'] = next_y

    if isinstance(rotated.get('controlPoint1'), dict):
        rotated['controlPoint1'] = _rotate_point_dict(rotated['controlPoint1'], width, height, rotation)
    if isinstance(rotated.get('controlPoint2'), dict):
        rotated['controlPoint2'] = _rotate_point_dict(rotated['controlPoint2'], width, height, rotation)

    return rotated


def _rotate_points_list(points: List[Any], width: Any, height: Any, rotation: int) -> List[Any]:
    rotated_points = []

    for point in points:
        if not isinstance(point, list) or len(point) < 2:
            rotated_points.append(point)
            continue

        next_x, next_y = _rotate_percent_point(point[0], point[1], width, height, rotation)
        if next_x is None or next_y is None:
            rotated_points.append(point)
            continue

        rotated_points.append([next_x, next_y])

    return rotated_points


def _rotate_box_like_value(value: Dict[str, Any], width: Any, height: Any, rotation: int) -> Dict[str, Any]:
    pixel_x = _to_pixels(value.get('x'), width)
    pixel_y = _to_pixels(value.get('y'), height)
    pixel_width = _to_pixels(value.get('width'), width)
    pixel_height = _to_pixels(value.get('height'), height)

    if None in (pixel_x, pixel_y, pixel_width, pixel_height):
        return value

    rotated_width, rotated_height = _get_rotated_dimensions(width, height, rotation)
    if rotated_width in (None, 0) or rotated_height in (None, 0):
        return value

    corners = [
        (pixel_x, pixel_y),
        (pixel_x + pixel_width, pixel_y),
        (pixel_x + pixel_width, pixel_y + pixel_height),
        (pixel_x, pixel_y + pixel_height),
    ]
    rotated_corners = [_rotate_point_pixels(x, y, float(width), float(height), rotation) for x, y in corners]
    xs = [point[0] for point in rotated_corners]
    ys = [point[1] for point in rotated_corners]

    value['x'] = _to_percent(min(xs), rotated_width)
    value['y'] = _to_percent(min(ys), rotated_height)
    value['width'] = _to_percent(max(xs) - min(xs), rotated_width)
    value['height'] = _to_percent(max(ys) - min(ys), rotated_height)

    if 'rotation' in value:
        value['rotation'] = _normalize_rotation(value.get('rotation'))

    return value


def _rotate_simple_xy_value(value: Dict[str, Any], width: Any, height: Any, rotation: int) -> Dict[str, Any]:
    next_x, next_y = _rotate_percent_point(value.get('x'), value.get('y'), width, height, rotation)
    if next_x is not None:
        value['x'] = next_x
    if next_y is not None:
        value['y'] = next_y
    return value

def calibrate_result_item(item: Dict[str, Any], strict: bool = False) -> Dict[str, Any]:
    if not isinstance(item, dict):
        return item

    if _is_relation(item):
        return deepcopy(item)

    rotation = get_result_item_rotation(item)
    calibrated = deepcopy(item)

    if rotation == 0:
        return calibrated

    item_type = calibrated.get('type')
    if strict and item_type not in SUPPORTED_CALIBRATED_TYPES:
        raise ValueError(
            f'Image calibration does not support result type "{item_type}". '
            'Only rectangle, ellipse, polygon, keypoint, and vector annotations can be calibrated automatically.'
        )

    original_width = calibrated.get('original_width')
    original_height = calibrated.get('original_height')
    calibrated_width, calibrated_height = _get_rotated_dimensions(original_width, original_height, rotation)

    if calibrated_width in (None, 0) or calibrated_height in (None, 0):
        if strict:
            raise ValueError('Image calibration requires original_width and original_height on every rotated result item.')
        return calibrated

    value = calibrated.get('value')
    if isinstance(value, dict):
        if isinstance(value.get('vertices'), list):
            value['vertices'] = [_rotate_point_dict(vertex, original_width, original_height, rotation) for vertex in value['vertices']]
        elif isinstance(value.get('points'), list):
            value['points'] = _rotate_points_list(value['points'], original_width, original_height, rotation)
        elif 'width' in value and 'height' in value:
            value = _rotate_box_like_value(value, original_width, original_height, rotation)
            calibrated['value'] = value
        elif 'x' in value or 'y' in value:
            value = _rotate_simple_xy_value(value, original_width, original_height, rotation)
            calibrated['value'] = value

    calibrated['original_width'] = calibrated_width
    calibrated['original_height'] = calibrated_height
    calibrated['image_rotation'] = 0

    return calibrated


def calibrate_result_payload(result: Optional[List[Dict[str, Any]]], strict: bool = False) -> List[Dict[str, Any]]:
    result = result or []
    return [calibrate_result_item(item, strict=strict) for item in result]


def _to_pixels(value: Any, size: Any) -> Optional[float]:
    if value is None or size in (None, 0):
        return None
    return float(value) * float(size) / 100.0


def _normalize_rectangle(item: Dict[str, Any]) -> Optional[List[float]]:
    value = item.get('value') or {}
    width = item.get('original_width')
    height = item.get('original_height')

    x = _to_pixels(value.get('x'), width)
    y = _to_pixels(value.get('y'), height)
    w = _to_pixels(value.get('width'), width)
    h = _to_pixels(value.get('height'), height)

    if None in (x, y, w, h):
        return None

    return [x, y, x + w, y + h]


def _normalize_vector(item: Dict[str, Any]) -> Tuple[Optional[str], Optional[List[float]]]:
    value = item.get('value') or {}
    vertices = value.get('vertices') or []
    width = item.get('original_width')
    height = item.get('original_height')

    if not vertices or width in (None, 0) or height in (None, 0):
        return None, None

    points: List[float] = []
    for vertex in vertices:
        x = _to_pixels(vertex.get('x'), width)
        y = _to_pixels(vertex.get('y'), height)

        if None in (x, y):
            return None, None

        points.extend([x, y])

    if value.get('closed') is True:
        if len(vertices) != 4:
            return None, None
        return 'quad', points

    return 'line', points


def build_normalized_annotation_payload(
    result: Optional[List[Dict[str, Any]]],
) -> Tuple[List[Dict[str, Any]], List[List[int]], List[Dict[str, Any]]]:
    result = calibrate_result_payload(result, strict=False)
    filtered_result = [item for item in result if not _is_relation(item)]

    normalized_regions: List[Dict[str, Any]] = []
    id_to_region: Dict[str, Dict[str, Any]] = {}
    seen_ids = set()

    for item in filtered_result:
        if not isinstance(item, dict):
            continue

        region_id = item.get('id')
        item_type = item.get('type')

        if not region_id or region_id in seen_ids:
            continue

        kind: Optional[str] = None
        points: Optional[List[float]] = None

        if item_type in {'rectangle', 'rectanglelabels'}:
            kind = 'rect'
            points = _normalize_rectangle(item)
        elif item_type in {'vector', 'vectorlabels'}:
            kind, points = _normalize_vector(item)

        if not kind or not points:
            continue

        region = {
            'index': len(normalized_regions) + 1,
            'id': region_id,
            'kind': kind,
            'points': points,
        }
        normalized_regions.append(region)
        id_to_region[region_id] = region
        seen_ids.add(region_id)

    groups: List[List[int]] = []
    seen_groups = set()

    for item in result:
        if not isinstance(item, dict):
            continue

        if not _is_pair_relation(item):
            continue

        from_region = id_to_region.get(item.get('from_id'))
        to_region = id_to_region.get(item.get('to_id'))

        if not from_region or not to_region:
            continue

        if {from_region['kind'], to_region['kind']} != {'rect', 'line'} and {from_region['kind'], to_region['kind']} != {
            'quad',
            'line',
        }:
            continue

        box_region = from_region if from_region['kind'] in {'rect', 'quad'} else to_region
        line_region = to_region if box_region is from_region else from_region

        group = [box_region['index'], line_region['index']]
        group_key = tuple(group)

        if group_key in seen_groups:
            continue

        seen_groups.add(group_key)
        groups.append(group)

    return normalized_regions, groups, filtered_result

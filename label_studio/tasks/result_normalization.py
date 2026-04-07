from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

PAIR_LABELS = {"pair", "配对"}


def _is_pair_relation(item: Dict[str, Any]) -> bool:
    if not isinstance(item, dict):
        return False

    if item.get("type") != "relation":
        return False

    labels = item.get("labels") or []
    return any(label in PAIR_LABELS for label in labels)


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
    result = result or []
    filtered_result = [item for item in result if not _is_pair_relation(item)]

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

"""Editing-view conversions for the inclusive norm1000 ``xyxy`` lattice."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from .contract_errors import DataContractError
from .geometry_helpers import validate_bbox_bins

NormBBox = tuple[int, int, int, int]
FloatBBox = tuple[float, float, float, float]
LabelStudioXYWH = tuple[float, float, float, float]

NORM1000_MAX = 999
OUTWARD_BIN_TOLERANCE = 1e-9
UNCHANGED_PERCENT_TOLERANCE = 1e-12


def norm1000_edge_to_percent(value: Any) -> float:
    """Map one inclusive ``0..999`` edge bin directly to percentage space."""

    return 100.0 * _validate_edge_bin(value) / NORM1000_MAX


def norm1000_bbox_to_label_studio_xywh(value: Any) -> LabelStudioXYWH:
    """Convert strict norm1000 ``xyxy`` to Label Studio percentage ``xywh``."""

    x1, y1, x2, y2 = validate_bbox_bins(value, field="bbox_2d")
    left = norm1000_edge_to_percent(x1)
    top = norm1000_edge_to_percent(y1)
    right = norm1000_edge_to_percent(x2)
    bottom = norm1000_edge_to_percent(y2)
    return left, top, right - left, bottom - top


def outward_quantize_norm1000_xyxy(value: Any) -> NormBBox:
    """Outward-quantize percentage ``xyxy`` with the approved float tolerance."""

    left, top, right, bottom = _finite_four(value, field="percent_xyxy")
    quantized = (
        math.floor(left * NORM1000_MAX / 100.0 + OUTWARD_BIN_TOLERANCE),
        math.floor(top * NORM1000_MAX / 100.0 + OUTWARD_BIN_TOLERANCE),
        math.ceil(right * NORM1000_MAX / 100.0 - OUTWARD_BIN_TOLERANCE),
        math.ceil(bottom * NORM1000_MAX / 100.0 - OUTWARD_BIN_TOLERANCE),
    )
    clipped = tuple(min(NORM1000_MAX, max(0, edge)) for edge in quantized)
    return validate_bbox_bins(clipped, field="quantized_bbox_2d")


def label_studio_xywh_to_norm1000(
    x: Any,
    y: Any,
    width: Any,
    height: Any,
    *,
    previous_bbox: Any | None = None,
) -> NormBBox:
    """Convert Label Studio percentage ``xywh`` to strict norm1000 ``xyxy``.

    When the serialized percentage geometry still represents ``previous_bbox``,
    those exact committed integers are reused. Otherwise the edited rectangle is
    tolerance-aware outward-quantized.
    """

    values = _finite_four((x, y, width, height), field="label_studio_xywh")
    if previous_bbox is not None:
        previous = validate_bbox_bins(previous_bbox, field="previous_bbox_2d")
        expected = norm1000_bbox_to_label_studio_xywh(previous)
        if all(
            math.isclose(actual, prior, rel_tol=0.0, abs_tol=UNCHANGED_PERCENT_TOLERANCE)
            for actual, prior in zip(values, expected, strict=True)
        ):
            return previous
    left, top, rectangle_width, rectangle_height = values
    if rectangle_width <= 0.0 or rectangle_height <= 0.0:
        raise DataContractError(
            "Label Studio rectangle must have positive width and height",
            code="label_studio.rectangle_order",
            context={"width": rectangle_width, "height": rectangle_height},
        )
    return outward_quantize_norm1000_xyxy(
        (left, top, left + rectangle_width, top + rectangle_height)
    )


def _validate_edge_bin(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DataContractError(
            "norm1000 edge must be an integer",
            code="label_studio.norm_edge_type",
            context={"value": value, "value_type": type(value).__name__},
        )
    if value < 0 or value > NORM1000_MAX:
        raise DataContractError(
            "norm1000 edge is outside the inclusive lattice",
            code="label_studio.norm_edge_range",
            context={"value": value, "min": 0, "max": NORM1000_MAX},
        )
    return value


def _finite_four(value: Any, *, field: str) -> FloatBBox:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 4:
        raise DataContractError(
            "geometry must contain exactly four numeric values",
            code="label_studio.geometry_shape",
            context={"field": field},
        )
    parsed: list[float] = []
    for index, item in enumerate(value):
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise DataContractError(
                "geometry values must be numeric",
                code="label_studio.geometry_type",
                context={"field": f"{field}[{index}]", "value_type": type(item).__name__},
            )
        number = float(item)
        if not math.isfinite(number):
            raise DataContractError(
                "geometry values must be finite",
                code="label_studio.geometry_finite",
                context={"field": f"{field}[{index}]", "value": repr(number)},
            )
        parsed.append(number)
    return parsed[0], parsed[1], parsed[2], parsed[3]


__all__ = [
    "FloatBBox",
    "LabelStudioXYWH",
    "NORM1000_MAX",
    "NormBBox",
    "OUTWARD_BIN_TOLERANCE",
    "UNCHANGED_PERCENT_TOLERANCE",
    "label_studio_xywh_to_norm1000",
    "norm1000_bbox_to_label_studio_xywh",
    "norm1000_edge_to_percent",
    "outward_quantize_norm1000_xyxy",
]

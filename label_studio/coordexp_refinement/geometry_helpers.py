"""Strict V1 coordinate-bin geometry helpers."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .contract_errors import DataContractError

COORD_BIN_MIN = 0
COORD_BIN_MAX = 999
def validate_bbox_bins(value: Any, *, field: str) -> tuple[int, int, int, int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise DataContractError(
            "bbox must be a four-integer sequence",
            code="data.bbox_shape",
            context={"field": field, "value_type": type(value).__name__},
        )
    if len(value) != 4:
        raise DataContractError(
            "bbox must have four values",
            code="data.bbox_shape",
            context={"field": field, "length": len(value)},
        )

    parsed: list[int] = []
    for index, item in enumerate(value):
        if isinstance(item, bool) or not isinstance(item, int):
            raise DataContractError(
                "bbox values must be integer coordinate bins",
                code="data.bbox_value_type",
                context={
                    "field": f"{field}[{index}]",
                    "value": item,
                    "value_type": type(item).__name__,
                },
            )
        if item < COORD_BIN_MIN or item > COORD_BIN_MAX:
            raise DataContractError(
                "bbox value is out of coordinate-bin range",
                code="data.bbox_value_range",
                context={
                    "field": f"{field}[{index}]",
                    "value": item,
                    "min": COORD_BIN_MIN,
                    "max": COORD_BIN_MAX,
                },
            )
        parsed.append(item)

    x1, y1, x2, y2 = parsed
    if x1 >= x2 or y1 >= y2:
        raise DataContractError(
            "bbox must be non-degenerate x1,y1,x2,y2 coordinate bins",
            code="data.bbox_order",
            context={"field": field, "bbox": parsed},
        )
    return x1, y1, x2, y2


def coord_bins_to_pixel_xyxy(
    value: Any,
    *,
    image_width: int,
    image_height: int,
    field: str,
) -> tuple[int, int, int, int]:
    """Convert validated norm1000 xyxy coordinate bins to pixel xyxy."""

    x1, y1, x2, y2 = validate_bbox_bins(value, field=field)
    if isinstance(image_width, bool) or not isinstance(image_width, int) or image_width <= 0:
        raise DataContractError(
            "image width must be a positive integer",
            code="data.image_width",
            context={"field": field, "image_width": image_width},
        )
    if isinstance(image_height, bool) or not isinstance(image_height, int) or image_height <= 0:
        raise DataContractError(
            "image height must be a positive integer",
            code="data.image_height",
            context={"field": field, "image_height": image_height},
        )
    return (
        _coord_bin_to_pixel(x1, extent=image_width),
        _coord_bin_to_pixel(y1, extent=image_height),
        _coord_bin_to_pixel(x2, extent=image_width),
        _coord_bin_to_pixel(y2, extent=image_height),
    )


def _coord_bin_to_pixel(value: int, *, extent: int) -> int:
    return round(value * extent / 1000)


__all__ = [
    "COORD_BIN_MAX",
    "COORD_BIN_MIN",
    "coord_bins_to_pixel_xyxy",
    "validate_bbox_bins",
]

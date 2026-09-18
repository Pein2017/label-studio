"""Frozen official sparse COCO-80 category registry."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType

from .contract_errors import DataContractError


@dataclass(frozen=True, order=True)
class CocoCategory:
    """One canonical COCO category using its official sparse annotation ID."""

    id: int
    name: str


COCO80_CATEGORIES: tuple[CocoCategory, ...] = tuple(
    CocoCategory(category_id, name)
    for category_id, name in (
        (1, "person"),
        (2, "bicycle"),
        (3, "car"),
        (4, "motorcycle"),
        (5, "airplane"),
        (6, "bus"),
        (7, "train"),
        (8, "truck"),
        (9, "boat"),
        (10, "traffic light"),
        (11, "fire hydrant"),
        (13, "stop sign"),
        (14, "parking meter"),
        (15, "bench"),
        (16, "bird"),
        (17, "cat"),
        (18, "dog"),
        (19, "horse"),
        (20, "sheep"),
        (21, "cow"),
        (22, "elephant"),
        (23, "bear"),
        (24, "zebra"),
        (25, "giraffe"),
        (27, "backpack"),
        (28, "umbrella"),
        (31, "handbag"),
        (32, "tie"),
        (33, "suitcase"),
        (34, "frisbee"),
        (35, "skis"),
        (36, "snowboard"),
        (37, "sports ball"),
        (38, "kite"),
        (39, "baseball bat"),
        (40, "baseball glove"),
        (41, "skateboard"),
        (42, "surfboard"),
        (43, "tennis racket"),
        (44, "bottle"),
        (46, "wine glass"),
        (47, "cup"),
        (48, "fork"),
        (49, "knife"),
        (50, "spoon"),
        (51, "bowl"),
        (52, "banana"),
        (53, "apple"),
        (54, "sandwich"),
        (55, "orange"),
        (56, "broccoli"),
        (57, "carrot"),
        (58, "hot dog"),
        (59, "pizza"),
        (60, "donut"),
        (61, "cake"),
        (62, "chair"),
        (63, "couch"),
        (64, "potted plant"),
        (65, "bed"),
        (67, "dining table"),
        (70, "toilet"),
        (72, "tv"),
        (73, "laptop"),
        (74, "mouse"),
        (75, "remote"),
        (76, "keyboard"),
        (77, "cell phone"),
        (78, "microwave"),
        (79, "oven"),
        (80, "toaster"),
        (81, "sink"),
        (82, "refrigerator"),
        (84, "book"),
        (85, "clock"),
        (86, "vase"),
        (87, "scissors"),
        (88, "teddy bear"),
        (89, "hair drier"),
        (90, "toothbrush"),
    )
)


class Coco80Registry:
    """Closed exact-name registry that never exposes contiguous evaluator IDs."""

    def __init__(self, categories: tuple[CocoCategory, ...] = COCO80_CATEGORIES) -> None:
        categories = tuple(categories)
        if len(categories) != 80:
            raise DataContractError(
                "COCO-80 registry must contain exactly 80 categories",
                code="label_studio.category_count",
                context={"count": len(categories)},
            )
        by_name = {category.name: category for category in categories}
        by_id = {category.id: category for category in categories}
        if len(by_name) != len(categories) or len(by_id) != len(categories):
            raise DataContractError(
                "COCO-80 category names and IDs must be unique",
                code="label_studio.category_duplicate",
            )
        self._categories = categories
        self._by_name = MappingProxyType(by_name)
        self._by_id = MappingProxyType(by_id)

    @property
    def categories(self) -> tuple[CocoCategory, ...]:
        return self._categories

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(category.name for category in self._categories)

    @property
    def ids(self) -> tuple[int, ...]:
        return tuple(category.id for category in self._categories)

    @property
    def fingerprint(self) -> str:
        payload = [{"id": category.id, "name": category.name} for category in self._categories]
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    def by_name(self, name: object) -> CocoCategory:
        if not isinstance(name, str) or name not in self._by_name:
            raise DataContractError(
                "category name is not an exact canonical COCO-80 name",
                code="label_studio.category_name",
                context={"name": name},
            )
        return self._by_name[name]

    def by_id(self, category_id: object) -> CocoCategory:
        if isinstance(category_id, bool) or not isinstance(category_id, int):
            raise DataContractError(
                "category ID must be an integer",
                code="label_studio.category_id_type",
                context={"category_id": category_id},
            )
        try:
            return self._by_id[category_id]
        except KeyError as exc:
            raise DataContractError(
                "category ID is not an official sparse COCO-80 ID",
                code="label_studio.category_id",
                context={"category_id": category_id},
                cause=exc,
            ) from exc

    def validate(self, name: object, category_id: object) -> CocoCategory:
        category = self.by_name(name)
        if isinstance(category_id, bool) or category_id != category.id:
            raise DataContractError(
                "category name and official sparse ID do not match",
                code="label_studio.category_mismatch",
                context={
                    "name": name,
                    "category_id": category_id,
                    "expected_category_id": category.id,
                },
            )
        return category


COCO80_REGISTRY = Coco80Registry()


__all__ = [
    "COCO80_CATEGORIES",
    "COCO80_REGISTRY",
    "Coco80Registry",
    "CocoCategory",
]

"""Small JSON/hash helpers shared by the local COCO refinement adapter.

This is the pure subset of the source working-store hashing contract.  It is
intentionally independent of the managed runtime and filesystem store.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any


def canonical_json(value: Any) -> str:
    """Serialize ordinary JSON with the store's canonical byte ordering."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_json(value: Any) -> str:
    """Return the SHA-256 digest of canonical JSON bytes."""

    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def canonical_semantic_projection(
    regions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Project annotation semantics while excluding UI order and view metadata."""

    projected: list[dict[str, Any]] = []
    for region in regions:
        key = _region_key(region)
        projected.append(
            {
                "region_key": key,
                "bbox_2d": list(region.get("bbox_2d", ())),
                "category_name": region.get("category_name", region.get("desc")),
                "category_id": region.get("category_id"),
                "coco_ann_id": region.get("coco_ann_id"),
            }
        )
    projected.sort(key=lambda item: item["region_key"])
    return projected


def semantic_hash(regions: Sequence[Mapping[str, Any]]) -> str:
    """Hash the canonical semantic projection of Draft regions."""

    return sha256_json(canonical_semantic_projection(regions))


def _region_key(region: Mapping[str, Any]) -> str:
    value = region.get("region_key", region.get("stable_region_key"))
    if not isinstance(value, str) or not value.strip():
        raise ValueError("every Draft region requires a hidden stable region key")
    return value


__all__ = [
    "canonical_json",
    "canonical_semantic_projection",
    "semantic_hash",
    "sha256_json",
]

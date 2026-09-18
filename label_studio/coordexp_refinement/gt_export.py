"""Publish the five-image COCO refinement project as the current GT snapshot."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]

from projects.models import Project
from tasks.models import Task

from .draft_adapter import (
    DraftContractError,
    canonicalize_label_studio_draft,
    strip_legacy_relation_results,
)

EXPORT_ROOT = (
    REPO_ROOT
    / "public_data/coco/rescale_32_1024_bbox/label_studio_refinement_4"
).resolve()
EXPECTED_IMAGE_IDS = frozenset({7116, 309264, 351017, 417044, 477415})


class GTExportError(RuntimeError):
    """The live annotation state could not be published as a GT snapshot."""


def sanitize_refinement_annotation_result(
    project_id: int | None,
    result: Any,
) -> tuple[Any, int]:
    """Remove legacy relation records before an opt-in annotation is saved.

    The API calls this after serializer validation and before the database
    write.  Projects without the exact refinement manifest are returned
    unchanged.  JSONL export repeats the filter defensively because database
    state may have been written by an older server or another code path.
    """

    if result is None or project_id is None or _manifest_for_project(project_id) is None:
        return result, 0
    try:
        return strip_legacy_relation_results(result)
    except DraftContractError as exc:
        raise GTExportError(
            f"refinement annotation result for project {project_id} is invalid"
        ) from exc


def export_project_gt(project_id: int) -> dict[str, Any] | None:
    """Atomically publish the current annotations for the configured project.

    Projects without the five-image manifest are ignored so this local adapter
    does not change ordinary Label Studio projects.  The caller's database
    update is not rolled back if filesystem publication fails.
    """

    manifest = _manifest_for_project(project_id)
    if manifest is None:
        return None
    image_ids = {int(value) for value in manifest.get("image_ids", [])}

    source_by_image = _load_source_rows(EXPORT_ROOT / "source.norm.jsonl", image_ids)
    try:
        project = Project.objects.get(pk=int(project_id))
    except Project.DoesNotExist as exc:
        raise GTExportError(f"refinement project {project_id} does not exist") from exc

    tasks = list(
        Task.objects.filter(project_id=project.pk).order_by("data__image_id", "pk")
    )
    if len(tasks) != len(image_ids) or {
        task.data.get("image_id") for task in tasks
    } != image_ids:
        raise GTExportError("refinement project task scope drifted")

    output_rows: list[dict[str, Any]] = []
    changed_images: list[int] = []
    annotation_counts: dict[str, int] = {}
    stripped_relation_counts: dict[str, int] = {}
    used_ids: set[int] = set()
    for task in tasks:
        image_id = task.data.get("image_id")
        if not isinstance(image_id, int) or image_id not in image_ids:
            raise GTExportError("refinement task has an invalid image_id")
        source_row = source_by_image[image_id]
        annotations = list(task.annotations.order_by("pk"))
        if len(annotations) != 1:
            raise GTExportError(f"image {image_id} must have exactly one annotation")
        try:
            filtered_results, stripped_relations = strip_legacy_relation_results(
                annotations[0].result or []
            )
            canonical = canonicalize_label_studio_draft(
                filtered_results,
                split="train",
                image_id=image_id,
                image_width=source_row["width"],
                image_height=source_row["height"],
            )
        except DraftContractError as exc:
            raise GTExportError(
                f"image {image_id} annotation is outside the rectangle-label contract: {exc}"
            ) from exc

        objects: list[dict[str, Any]] = []
        row_ids: set[int] = set()
        for region in canonical.regions:
            object_id = region.get("coco_ann_id")
            if object_id is None:
                object_id = _stable_new_object_id(image_id, region["region_key"])
            if not isinstance(object_id, int) or object_id == 0:
                raise GTExportError(f"image {image_id} contains an invalid object ID")
            if object_id in row_ids:
                raise GTExportError(f"image {image_id} contains duplicate object ID {object_id}")
            if object_id in used_ids:
                raise GTExportError(f"duplicate object ID across refinement images: {object_id}")
            row_ids.add(object_id)
            used_ids.add(object_id)
            objects.append(
                {
                    "bbox_2d": list(region["bbox_2d"]),
                    "desc": region["category_name"],
                    "category_id": region["category_id"],
                    "category_name": region["category_name"],
                    "coco_ann_id": object_id,
                }
            )

        edited_row = copy.deepcopy(source_row)
        edited_row["objects"] = objects
        output_rows.append(edited_row)
        annotation_counts[str(image_id)] = len(objects)
        stripped_relation_counts[str(image_id)] = stripped_relations
        if objects != source_row["objects"]:
            changed_images.append(image_id)

    output_rows.sort(key=lambda row: row["image_id"])
    output_path = EXPORT_ROOT / "working.norm.jsonl"
    payload = b"".join(_canonical_line(row) for row in output_rows)
    backup_path = EXPORT_ROOT / "working.norm.jsonl.before-export"
    if output_path.exists():
        backup_path.write_bytes(output_path.read_bytes())
    fd, temporary = tempfile.mkstemp(prefix=".working.norm.jsonl.", dir=EXPORT_ROOT)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output_path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    receipt = {
        "project_id": int(project_id),
        "image_ids": sorted(image_ids),
        "annotation_counts": annotation_counts,
        "stripped_relation_counts": stripped_relation_counts,
        "stripped_relation_total": sum(stripped_relation_counts.values()),
        "output_path": str(output_path),
        "output_sha256": _sha256(output_path),
        "changed_images": sorted(changed_images),
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    (EXPORT_ROOT / "last_export.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return receipt


def _manifest_for_project(project_id: int) -> dict[str, Any] | None:
    manifest_path = EXPORT_ROOT / "project_manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GTExportError(f"cannot read refinement manifest: {manifest_path}") from exc
    if not isinstance(manifest, dict):
        raise GTExportError("refinement manifest must be a JSON object")
    if manifest.get("project_id") != int(project_id):
        return None
    try:
        image_ids = {int(value) for value in manifest.get("image_ids", [])}
    except (TypeError, ValueError) as exc:
        raise GTExportError("refinement manifest image_ids are invalid") from exc
    if image_ids != EXPECTED_IMAGE_IDS:
        raise GTExportError("refinement manifest image scope drifted")
    return manifest


def _load_source_rows(path: Path, image_ids: set[int]) -> dict[int, dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GTExportError(f"cannot read refinement source: {path}") from exc
    rows: dict[int, dict[str, Any]] = {}
    for line_number, raw_line in enumerate(lines, 1):
        try:
            row = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise GTExportError(f"invalid source JSON at line {line_number}") from exc
        if not isinstance(row, dict):
            raise GTExportError(f"source row at line {line_number} must be an object")
        image_id = row.get("image_id")
        if not isinstance(image_id, int) or image_id in rows:
            raise GTExportError(f"invalid or duplicate source image_id at line {line_number}")
        rows[image_id] = row
    if set(rows) != image_ids:
        raise GTExportError("source file does not contain exactly the five manifest images")
    return rows


def _stable_new_object_id(image_id: int, region_key: str) -> int:
    """Derive a stable negative ID from the Label Studio result identity."""

    digest = hashlib.sha256(f"coordexp:new:{image_id}:{region_key}".encode()).digest()
    # Keep the value exactly representable by JSON/JavaScript consumers while
    # remaining outside the positive COCO ID namespace.
    object_id = -(int.from_bytes(digest[:8], "big") & ((1 << 53) - 1))
    return object_id or -1


def _canonical_line(payload: object) -> bytes:
    return (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


__all__ = [
    "GTExportError",
    "export_project_gt",
    "sanitize_refinement_annotation_result",
]

"""Focused tests for the self-contained project GT adapter."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings.label_studio")

import django
from django.apps import apps

if not apps.ready:
    django.setup()

from coordexp_refinement import gt_export
from coordexp_refinement.draft_adapter import (
    DraftContractError,
    canonicalize_label_studio_draft,
    strip_legacy_relation_results,
)
from coordexp_refinement.geometry import label_studio_xywh_to_norm1000


def _rectangle(
    region_id: str,
    label: str,
    *,
    x: float = 10.0,
    y: float = 20.0,
    width: float = 30.0,
    height: float = 40.0,
    meta: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "original_width": 100,
        "original_height": 100,
        "image_rotation": 0,
        "value": {
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "rotation": 0,
            "rectanglelabels": [label],
        },
        "meta": dict(meta or {}),
        "id": region_id,
        "from_name": "bbox",
        "to_name": "image",
        "type": "rectanglelabels",
        "origin": "manual",
    }


class LocalGTAdapterTests(unittest.TestCase):
    def test_non_opt_in_project_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            (export_root / "project_manifest.json").write_text(
                json.dumps({"project_id": 99, "image_ids": [1]}),
                encoding="utf-8",
            )
            with patch.object(gt_export, "EXPORT_ROOT", export_root):
                self.assertIsNone(gt_export.export_project_gt(100))

    def test_relation_fixture_keeps_rectangles_and_strips_only_relation(self) -> None:
        results = [
            _rectangle("train:coco:1", "person"),
            {
                "type": "relation",
                "from_id": "train:coco:1",
                "to_id": "train:coco:2",
                "direction": "bi",
                "labels": ["配对"],
            },
            _rectangle("train:coco:2", "bird", x=50.0),
        ]
        original = copy.deepcopy(results)

        filtered, stripped = strip_legacy_relation_results(results)

        self.assertEqual(stripped, 1)
        self.assertEqual(len(filtered), 2)
        self.assertTrue(all(item["type"] == "rectanglelabels" for item in filtered))
        self.assertEqual(results, original)

    def test_update_boundary_sanitizes_only_opt_in_project(self) -> None:
        results = [
            _rectangle("train:coco:1", "person"),
            {
                "type": "relation",
                "from_id": "train:coco:1",
                "to_id": "train:coco:2",
            },
        ]
        original = copy.deepcopy(results)

        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            (export_root / "project_manifest.json").write_text(
                json.dumps(
                    {
                        "project_id": 99,
                        "image_ids": sorted(gt_export.EXPECTED_IMAGE_IDS),
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(gt_export, "EXPORT_ROOT", export_root):
                sanitized, stripped = gt_export.sanitize_refinement_annotation_result(
                    99, results
                )
                ordinary, ordinary_stripped = (
                    gt_export.sanitize_refinement_annotation_result(100, results)
                )

        self.assertEqual(stripped, 1)
        self.assertEqual(len(sanitized), 1)
        self.assertEqual(ordinary_stripped, 0)
        self.assertIs(ordinary, results)
        self.assertEqual(results, original)

    def test_hidden_rectangle_remains_exportable(self) -> None:
        result = _rectangle(
            "train:coco:7",
            "bird",
            meta={"hidden": True, "last_committed_bbox": [100, 200, 400, 600]},
        )

        canonical = canonicalize_label_studio_draft(
            [result],
            split="train",
            image_id=309264,
            image_width=100,
            image_height=100,
        )

        self.assertEqual(len(canonical.regions), 1)
        self.assertEqual(canonical.regions[0]["category_name"], "bird")
        self.assertTrue(canonical.regions[0]["draft_meta"]["hidden"])

    def test_invalid_geometry_is_rejected(self) -> None:
        result = _rectangle("train:coco:1", "person", width=0.0)

        with self.assertRaises(DraftContractError):
            canonicalize_label_studio_draft(
                [result],
                split="train",
                image_id=1,
                image_width=100,
                image_height=100,
            )

    def test_new_object_id_is_stable_and_outside_positive_coco_ids(self) -> None:
        first = gt_export._stable_new_object_id(309264, "new-region")
        second = gt_export._stable_new_object_id(309264, "new-region")

        self.assertEqual(first, second)
        self.assertLess(first, 0)

    def test_unchanged_geometry_reuses_committed_norm1000_bbox(self) -> None:
        previous = [100, 200, 400, 600]
        x, y, width, height = (
            100 * previous[0] / 999,
            100 * previous[1] / 999,
            100 * (previous[2] - previous[0]) / 999,
            100 * (previous[3] - previous[1]) / 999,
        )

        self.assertEqual(
            label_studio_xywh_to_norm1000(
                x,
                y,
                width,
                height,
                previous_bbox=previous,
            ),
            tuple(previous),
        )

    def test_export_preserves_source_and_reports_relation_stripping(self) -> None:
        source_row = {
            "file_name": "images/train2017/000000000001.jpg",
            "height": 100,
            "image_id": 1,
            "images": ["images/train2017/000000000001.jpg"],
            "metadata": {"split": "train"},
            "objects": [
                {
                    "bbox_2d": [100, 200, 400, 600],
                    "desc": "person",
                    "category_id": 1,
                    "category_name": "person",
                    "coco_ann_id": 1,
                }
            ],
            "width": 100,
        }
        result = _rectangle(
            "train:coco:1",
            "person",
            x=100 * 100 / 999,
            y=100 * 200 / 999,
            width=100 * 300 / 999,
            height=100 * 400 / 999,
            meta={
                "coordexp_region_key": "train:coco:1",
                "coco_ann_id": 1,
                "hidden": True,
                "last_committed_bbox": [100, 200, 400, 600],
            },
        )
        relation = {
            "type": "relation",
            "from_id": "train:coco:1",
            "to_id": "train:coco:2",
            "labels": ["配对"],
        }

        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            source_path = export_root / "source.norm.jsonl"
            source_bytes = (
                json.dumps(source_row, ensure_ascii=False, sort_keys=True) + "\n"
            ).encode()
            source_path.write_bytes(source_bytes)
            previous_working = b"{\"previous\":true}\n"
            (export_root / "working.norm.jsonl").write_bytes(previous_working)
            (export_root / "project_manifest.json").write_text(
                json.dumps({"project_id": 99, "image_ids": [1]}),
                encoding="utf-8",
            )

            annotation = SimpleNamespace(result=[result, relation])
            task = SimpleNamespace(
                data={"image_id": 1},
                annotations=SimpleNamespace(
                    order_by=lambda _field: [annotation],
                ),
            )
            project_model = SimpleNamespace(
                objects=SimpleNamespace(
                    get=lambda **kwargs: SimpleNamespace(pk=99),
                ),
                DoesNotExist=LookupError,
            )
            task_model = SimpleNamespace(
                objects=SimpleNamespace(
                    filter=lambda **kwargs: SimpleNamespace(
                        order_by=lambda *_fields: [task],
                    ),
                ),
            )

            with (
                patch.object(gt_export, "EXPORT_ROOT", export_root),
                patch.object(gt_export, "EXPECTED_IMAGE_IDS", frozenset({1})),
                patch.object(gt_export, "Project", project_model),
                patch.object(gt_export, "Task", task_model),
            ):
                receipt = gt_export.export_project_gt(99)

            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(receipt["stripped_relation_counts"], {"1": 1})
            self.assertEqual(receipt["stripped_relation_total"], 1)
            self.assertEqual(source_path.read_bytes(), source_bytes)
            self.assertEqual(
                (export_root / "working.norm.jsonl.before-export").read_bytes(),
                previous_working,
            )
            working = [
                json.loads(line)
                for line in (export_root / "working.norm.jsonl").read_text().splitlines()
            ]
            self.assertEqual(len(working), 1)
            self.assertEqual(working[0]["objects"][0]["bbox_2d"], [100, 200, 400, 600])


if __name__ == "__main__":
    unittest.main()

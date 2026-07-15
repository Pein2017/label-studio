"""Focused Django adapter tests.

Run with the vendor settings and the requested refinement environment::

    cd /data/CoordExp/label-studio/label_studio
    PYTHONPATH=/data/CoordExp:/data/CoordExp/label-studio/label_studio \
      DJANGO_DB=sqlite DJANGO_SETTINGS_MODULE=core.settings.label_studio \
      /data/CoordExp/outputs/label_studio_coco_refinement/.venv/bin/python \
      manage.py test coordexp_refinement.tests.test_bootstrap -v 2
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from unittest import mock

import src.label_studio_coco_refinement.project as project_contract
from coordexp_refinement.bootstrap import (
    BootstrapStateDriftError,
    DjangoRefinementProjectAdapter,
    _canonical_json_bytes,
)
from core.current_request import CurrentContext
from django.conf import settings
from django.test import TransactionTestCase
from django.utils import timezone
from io_storages.localfiles.models import LocalFilesImportStorage
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from src.label_studio_coco_refinement.label_config import (
    build_label_config,
    label_config_fingerprint,
)
from src.label_studio_coco_refinement.project import BootstrapAction, Split
from tasks.models import Annotation, Prediction, Task
from users.models import User

VENDOR_REVISION = "fixture-vendor-revision"


def _source_row(split: Split, image_id: int) -> dict:
    subdirectory = "train2017" if split is Split.TRAIN else "val2017"
    file_name = f"images/{subdirectory}/{image_id:012d}.jpg"
    return {
        "images": [f"../rescale_32_1024_bbox/{file_name}"],
        "objects": [
            {
                "bbox_2d": [0, 10, 500, 999],
                "desc": "person",
                "category_id": 1,
                "category_name": "person",
                "coco_ann_id": 100_000 + image_id,
            }
        ],
        "width": 1152,
        "height": 864,
        "image_id": image_id,
        "file_name": file_name,
        "metadata": {"source": "coco2017", "split": split.value},
    }


class BootstrapAdapterTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        super().setUp()
        self._temporary = tempfile.TemporaryDirectory()
        self.repo_root = Path(self._temporary.name)
        self._source_contracts = project_contract.SOURCE_CONTRACTS
        self._local_files_root = settings.LOCAL_FILES_DOCUMENT_ROOT
        self._local_files_enabled = settings.LOCAL_FILES_SERVING_ENABLED

    def tearDown(self):
        CurrentContext.clear()
        project_contract.SOURCE_CONTRACTS = self._source_contracts
        settings.LOCAL_FILES_DOCUMENT_ROOT = self._local_files_root
        settings.LOCAL_FILES_SERVING_ENABLED = self._local_files_enabled
        self._temporary.cleanup()
        super().tearDown()

    def _install_source_rows(self, split: Split, rows: list[dict]) -> Path:
        contract = project_contract.SOURCE_CONTRACTS[split]
        source_path = self.repo_root / Path(contract.relative_path)
        source_path.parent.mkdir(parents=True, exist_ok=True)
        encoded = b"".join(
            (json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode()
            for row in rows
        )
        source_path.write_bytes(encoded)
        for row in rows:
            image_path = (
                self.repo_root
                / "public_data/coco/rescale_32_1024_bbox"
                / row["file_name"]
            )
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.write_bytes(b"fixture-image")
        contracts = dict(project_contract.SOURCE_CONTRACTS)
        contracts[split] = replace(
            contract,
            sha256=hashlib.sha256(encoded).hexdigest(),
            row_count=len(rows),
            box_count=sum(len(row["objects"]) for row in rows),
        )
        project_contract.SOURCE_CONTRACTS = MappingProxyType(contracts)
        return source_path

    def _desired_projects(
        self, *, train_count: int = 1, val_count: int = 1
    ) -> dict[Split, object]:
        config = build_label_config()
        desired = {}
        for split, count, base in (
            (Split.TRAIN, train_count, 10),
            (Split.VAL, val_count, 20),
        ):
            rows = [_source_row(split, base + index) for index in range(count)]
            source_path = self._install_source_rows(split, rows)
            desired[split] = project_contract.build_split_project_plan(
                source_path,
                repo_root=self.repo_root,
                split=split,
                vendor_revision=VENDOR_REVISION,
                label_config=config,
                label_config_fingerprint=label_config_fingerprint(config),
            )
        return desired

    def _context(self, *, train_count: int = 1, val_count: int = 1):
        desired = self._desired_projects(
            train_count=train_count,
            val_count=val_count,
        )
        image_root = project_contract.RuntimeLayout.for_repo(self.repo_root).image_root
        settings.LOCAL_FILES_DOCUMENT_ROOT = str(image_root)
        settings.LOCAL_FILES_SERVING_ENABLED = True
        user = User.objects.create(
            email="operator@example.com",
            username="operator",
            is_active=True,
        )
        organization = Organization.objects.create(title="test", created_by=user)
        OrganizationMember.objects.create(user=user, organization=organization)
        user.active_organization = organization
        user.save(update_fields=["active_organization"])
        adapter = DjangoRefinementProjectAdapter(
            repo_root=self.repo_root,
            operator_user=user,
            organization=organization,
            chunk_size=1,
            contract_module=project_contract,
            vendor_revision_getter=lambda: VENDOR_REVISION,
        )
        return desired, adapter

    def _plan_and_apply(self, desired, adapter):
        plan = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertEqual(
            [action.action for action in plan.projects],
            [BootstrapAction.CREATE, BootstrapAction.CREATE],
        )
        adapter.apply(plan)
        return plan

    def test_create_then_reuse_has_exact_projects_tasks_annotations_and_storage(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)

        restarted = DjangoRefinementProjectAdapter(
            repo_root=self.repo_root,
            operator_user=adapter.operator_user,
            organization=adapter.organization,
            chunk_size=1,
            contract_module=project_contract,
            vendor_revision_getter=lambda: VENDOR_REVISION,
        )
        reuse = project_contract.plan_instance_bootstrap(desired, restarted)
        self.assertEqual(
            [action.action for action in reuse.projects],
            [BootstrapAction.REUSE, BootstrapAction.REUSE],
        )
        self.assertEqual(
            Project.objects.filter(
                description__startswith="coordexp-refinement-"
            ).count(),
            2,
        )
        self.assertEqual(Task.objects.count(), 2)
        self.assertEqual(Annotation.objects.count(), 2)
        self.assertEqual(Prediction.objects.count(), 0)
        self.assertEqual(LocalFilesImportStorage.objects.count(), 2)
        for task in Task.objects.prefetch_related("annotations", "predictions"):
            self.assertEqual(task.annotations.count(), 1)
            self.assertEqual(task.predictions.count(), 0)
            self.assertIs(task.annotations.get().ground_truth, False)
            self.assertIs(task.allow_skip, False)
            self.assertIs(task.is_labeled, True)

    def test_chunk_bound_and_arbitrary_middle_row_reconcile(self):
        desired, adapter = self._context(train_count=5, val_count=2)
        adapter.chunk_size = 2
        create = project_contract.plan_instance_bootstrap(desired, adapter)
        original_import_chunk = adapter._import_chunk
        observed_chunk_sizes = []

        def record_chunk(**kwargs):
            observed_chunk_sizes.append(len(kwargs["payloads"]))
            return original_import_chunk(**kwargs)

        with mock.patch.object(adapter, "_import_chunk", record_chunk):
            adapter.apply(create)
        self.assertTrue(observed_chunk_sizes)
        self.assertLessEqual(max(observed_chunk_sizes), 2)

        runtime = json.loads(adapter.runtime_manifest_path.read_text())
        Task.objects.get(
            project_id=runtime["projects"]["train"]["project_id"],
            data__source_line=3,
        ).delete()
        reconcile = project_contract.plan_instance_bootstrap(desired, adapter)
        train_action = next(
            action
            for action in reconcile.projects
            if action.project.split is Split.TRAIN
        )
        self.assertIs(train_action.action, BootstrapAction.RECONCILE)
        self.assertEqual(train_action.observed_task_count, 4)
        self.assertEqual(train_action.missing_task_count, 1)

        adapter.apply(reconcile)
        reuse = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertEqual(
            {action.action for action in reuse.projects},
            {BootstrapAction.REUSE},
        )
        self.assertEqual(Task.objects.count(), 7)
        self.assertEqual(Annotation.objects.count(), 7)

    def test_partial_reconcile_after_committed_chunk_and_lost_response(self):
        desired, adapter = self._context(train_count=2, val_count=1)
        create = project_contract.plan_instance_bootstrap(desired, adapter)
        original_import_chunk = adapter._import_chunk
        calls = 0

        def commit_then_lose_response(**kwargs):
            nonlocal calls
            original_import_chunk(**kwargs)
            calls += 1
            if calls == 1:
                raise RuntimeError("simulated lost response")

        with mock.patch.object(adapter, "_import_chunk", commit_then_lose_response):
            with self.assertRaisesRegex(RuntimeError, "lost response"):
                adapter.apply(create)
        self.assertEqual(Task.objects.count(), 1)
        self.assertTrue(adapter.runtime_manifest_path.is_file())

        reconcile = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertEqual(
            [action.action for action in reconcile.projects],
            [BootstrapAction.RECONCILE, BootstrapAction.RECONCILE],
        )
        adapter.apply(reconcile)
        reuse = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertEqual(
            {action.action for action in reuse.projects},
            {BootstrapAction.REUSE},
        )
        self.assertEqual(Task.objects.count(), 3)
        self.assertEqual(Annotation.objects.count(), 3)
        keys = list(Task.objects.values_list("data__coordexp_task_key", flat=True))
        self.assertEqual(len(keys), len(set(keys)))

    def test_live_project_manifest_drift_fails_closed(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        train_id = json.loads(adapter.runtime_manifest_path.read_text())["projects"][
            "train"
        ]["project_id"]
        Project.objects.filter(pk=train_id).update(label_config="<View></View>")

        with self.assertRaisesRegex(
            project_contract.ManifestDriftError, "label_config"
        ):
            project_contract.plan_instance_bootstrap(desired, adapter)

    def test_stale_reconcile_receipt_fails_before_import(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        runtime = json.loads(adapter.runtime_manifest_path.read_text())
        Task.objects.filter(
            project_id=runtime["projects"]["val"]["project_id"]
        ).delete()
        reconcile = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertIn(
            BootstrapAction.RECONCILE,
            {action.action for action in reconcile.projects},
        )
        Annotation.objects.filter(
            project_id=runtime["projects"]["train"]["project_id"]
        ).update(result=[])
        before = (Task.objects.count(), Annotation.objects.count())

        with self.assertRaisesRegex(BootstrapStateDriftError, "attestation changed"):
            adapter.apply(reconcile)
        self.assertEqual((Task.objects.count(), Annotation.objects.count()), before)

    def test_soft_deleted_manifest_bound_project_fails_closed(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        runtime = json.loads(adapter.runtime_manifest_path.read_text())
        Project.all_objects.filter(
            pk=runtime["projects"]["train"]["project_id"]
        ).update(deleted_at=timezone.now())

        with self.assertRaisesRegex(BootstrapStateDriftError, "soft-deleted"):
            adapter.attest_project(desired[Split.TRAIN])

    def test_missing_manifest_with_live_projects_fails_closed(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        adapter.runtime_manifest_path.unlink()

        with self.assertRaisesRegex(BootstrapStateDriftError, "without the runtime"):
            adapter.attest_bootstrap_manifest()

    def test_storage_mismatch_fails_closed(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        runtime = json.loads(adapter.runtime_manifest_path.read_text())
        train = runtime["projects"]["train"]
        LocalFilesImportStorage.objects.filter(pk=train["storage_id"]).update(
            regex_filter=r".*\.png$"
        )
        with self.assertRaisesRegex(BootstrapStateDriftError, "storage"):
            adapter.attest_project(desired[Split.TRAIN])

    def test_managed_link_mismatch_fails_closed(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        runtime = json.loads(adapter.runtime_manifest_path.read_text())
        train = runtime["projects"]["train"]
        link = Path(train["storage_manifest"]["managed_link"])
        link.unlink()
        wrong = adapter.runtime_layout.image_root.parent
        os.symlink(str(wrong), str(link), target_is_directory=True)
        with self.assertRaisesRegex(BootstrapStateDriftError, "link"):
            adapter.attest_project(desired[Split.TRAIN])

    def test_adapter_detaches_source_payload_before_vendor_import(self):
        desired, adapter = self._context()
        create = project_contract.plan_instance_bootstrap(desired, adapter)
        sent = {
            action.project.split: [
                payload
                for chunk in action.iter_task_import_chunks(adapter.chunk_size)
                for payload in chunk
            ]
            for action in create.projects
        }

        def shared_send(action, chunk_size):
            del chunk_size
            yield tuple(sent[action.project.split])

        original_import_chunk = adapter._import_chunk

        def mutate_source_then_import(**kwargs):
            split = Split(kwargs["split_value"])
            sent[split][0]["annotations"][0]["ground_truth"] = True
            sent[split][0]["data"]["image"] = "mutated-after-detach"
            original_import_chunk(**kwargs)

        with (
            mock.patch.object(
                project_contract.PlannedProjectBootstrap,
                "iter_task_import_chunks",
                shared_send,
            ),
            mock.patch.object(adapter, "_import_chunk", mutate_source_then_import),
        ):
            adapter.apply(create)

        self.assertEqual(Annotation.objects.filter(ground_truth=False).count(), 2)
        self.assertFalse(
            Task.objects.filter(data__image="mutated-after-detach").exists()
        )
        reuse = project_contract.plan_instance_bootstrap(desired, adapter)
        self.assertEqual(
            {action.action for action in reuse.projects},
            {BootstrapAction.REUSE},
        )

    def test_cross_split_project_id_reuse_in_manifest_is_rejected(self):
        desired, adapter = self._context()
        self._plan_and_apply(desired, adapter)
        payload = json.loads(adapter.runtime_manifest_path.read_text())
        payload["projects"]["train"]["project_id"] = payload["projects"]["val"][
            "project_id"
        ]
        body = {key: value for key, value in payload.items() if key != "fingerprint"}
        payload["fingerprint"] = project_contract.fingerprint_json(body)
        adapter.runtime_manifest_path.write_bytes(_canonical_json_bytes(payload))

        with self.assertRaisesRegex(BootstrapStateDriftError, "cross-split"):
            adapter.attest_bootstrap_manifest()

    def test_operator_context_is_restored_when_apply_raises(self):
        desired, adapter = self._context()
        create = project_contract.plan_instance_bootstrap(desired, adapter)
        CurrentContext.set("sentinel", "outer")
        CurrentContext.set("user", "outer-user")

        with mock.patch.object(
            adapter,
            "_create_projects_and_storages",
            side_effect=RuntimeError("injected apply failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "injected apply failure"):
                adapter.apply(create)
        self.assertEqual(CurrentContext.get("sentinel"), "outer")
        self.assertEqual(CurrentContext.get_user(), "outer-user")

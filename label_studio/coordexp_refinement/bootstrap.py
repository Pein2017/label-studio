"""Django-backed, fail-closed bootstrap adapter for CoordExp refinement.

The pure bootstrap planner lives in the parent CoordExp checkout.  This module is
the deliberately small vendor boundary that applies its detached task payloads
to Label Studio and attests the resulting live database/filesystem state.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from contextlib import contextmanager
from itertools import islice
from pathlib import Path
from types import ModuleType
from typing import Any

from core.current_request import CurrentContext
from data_import.serializers import ImportApiSerializer
from django.conf import settings
from django.db import transaction
from django.db.models import Count
from io_storages.localfiles.models import LocalFilesImportStorage
from io_storages.localfiles.serializers import LocalFilesImportStorageSerializer
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from projects.serializers import ProjectSerializer
from tasks.models import Annotation, Prediction, Task

RUNTIME_MANIFEST_NAME = "bootstrap-manifest.json"
RUNTIME_MANIFEST_SCHEMA_VERSION = 1
PROJECT_MARKER_PREFIX = "coordexp-refinement-project-identity:"
STORAGE_MARKER_PREFIX = "coordexp-refinement-storage-identity:"
LOCAL_IMAGE_REGEX = r"^[0-9]{12}\.jpg$"


class BootstrapAdapterError(RuntimeError):
    """The requested bootstrap cannot be applied or attested safely."""


class BootstrapStateDriftError(BootstrapAdapterError):
    """Live Label Studio/runtime state differs from the persisted contract."""


class DjangoRefinementProjectAdapter:
    """Apply and attest parent-owned ``InstanceBootstrapPlan`` objects.

    Project titles are presentation only.  Reuse is authorized exclusively by
    the canonical runtime manifest's numeric IDs plus exact identity markers.
    """

    def __init__(
        self,
        *,
        repo_root: Path,
        operator_user: Any,
        organization: Organization,
        chunk_size: int = 500,
        contract_module: ModuleType | None = None,
        vendor_revision_getter: Callable[[], str] | None = None,
    ) -> None:
        self.repo_root = Path(repo_root).expanduser().resolve(strict=False)
        self.operator_user = operator_user
        self.organization = organization
        if (
            isinstance(chunk_size, bool)
            or not isinstance(chunk_size, int)
            or chunk_size < 1
        ):
            raise BootstrapAdapterError("chunk_size must be a positive integer")
        self.chunk_size = chunk_size
        self.contract = contract_module or _load_contract_module(self.repo_root)
        self.vendor_root = Path(__file__).resolve().parents[2]
        self._vendor_revision_getter = (
            vendor_revision_getter or self._read_vendor_revision
        )
        self.runtime_layout = self.contract.RuntimeLayout.for_repo(self.repo_root)
        self.runtime_manifest_path = (
            self.runtime_layout.root / "label-studio" / RUNTIME_MANIFEST_NAME
        )
        self._assert_operator_scope()

    @property
    def vendor_revision(self) -> str:
        revision = self._vendor_revision_getter()
        if not isinstance(revision, str) or not revision.strip():
            raise BootstrapAdapterError(
                "vendor revision attestation returned an empty value"
            )
        return revision.strip()

    def attest_bootstrap_manifest(self) -> Mapping[str, Any] | None:
        """Return the saved parent manifest after checking all ID bindings."""

        runtime_manifest = self._load_runtime_manifest()
        if runtime_manifest is None:
            return None
        self._validate_live_bindings(runtime_manifest)
        return _json_copy(runtime_manifest["desired_manifest"])

    def attest_project(self, desired: Any) -> Any | None:
        """Build a parent ``LiveProjectAttestation`` from live Django rows."""

        if not isinstance(desired, self.contract.SplitProjectPlan):
            raise BootstrapAdapterError("attestation requires a SplitProjectPlan")
        split_value = self._split_value(desired.split)
        runtime_manifest = self._load_runtime_manifest()
        if runtime_manifest is None:
            return None
        self._validate_live_bindings(runtime_manifest)
        entry = runtime_manifest["projects"][split_value]
        self.contract.assert_manifest_matches(
            desired.manifest,
            entry["project_manifest"],
        )
        project = Project.all_objects.get(pk=entry["project_id"])
        storage_manifest = self._storage_manifest_from_dict(entry["storage_manifest"])
        controls = self._controls_from_dict(entry["controls"])

        self._assert_project_fields(
            project,
            split_value=split_value,
            project_identity=entry["project_identity"],
            controls=controls,
        )
        self._assert_storage_fields(
            project=project,
            storage_id=entry["storage_id"],
            storage_manifest=storage_manifest,
        )
        link_path = Path(storage_manifest.managed_link)
        link_is_symlink, link_target = self._attest_managed_link(
            link_path,
            Path(storage_manifest.managed_link_target),
        )
        task_set = self._attest_tasks(project=project, desired=desired)
        return self.contract.LiveProjectAttestation(
            split=self.contract.Split(split_value),
            project_id=project.pk,
            project_identity=entry["project_identity"],
            saved_manifest=_json_copy(entry["project_manifest"]),
            vendor_revision=self.vendor_revision,
            label_config=project.label_config,
            controls=controls,
            storage_manifest=storage_manifest,
            managed_link_is_symlink=link_is_symlink,
            managed_link_resolved_target=link_target,
            task_set=task_set,
        )

    def apply(self, plan: Any) -> tuple[Any, ...]:
        """Apply a previously computed plan without deletion or implicit cleanup."""

        self._assert_operator_scope()
        actions = self._validate_plan(plan)
        with _current_operator_context(self.operator_user):
            return self._apply_validated(plan, actions)

    def _apply_validated(
        self,
        plan: Any,
        actions: Mapping[str, Any],
    ) -> tuple[Any, ...]:
        create_actions = [
            action for action in actions.values() if action.action.value == "create"
        ]
        if create_actions:
            if len(create_actions) != 2 or os.path.lexists(self.runtime_manifest_path):
                raise BootstrapStateDriftError(
                    "CREATE is allowed only for a fresh two-project bootstrap"
                )
            for action in actions.values():
                self._ensure_managed_link(action.project.storage_manifest)
            project_rows = self._create_projects_and_storages(actions)
            runtime_manifest = self._build_runtime_manifest(plan, actions, project_rows)
            self._write_runtime_manifest_once(runtime_manifest)
        else:
            runtime_manifest = self._load_runtime_manifest()
            if runtime_manifest is None:
                raise BootstrapStateDriftError(
                    "non-CREATE plan requires a runtime manifest"
                )
            self.contract.assert_manifest_matches(
                plan.manifest,
                runtime_manifest["desired_manifest"],
            )
            self._validate_live_bindings(runtime_manifest)
            self._assert_live_receipts_still_match(actions)

        for split_value in ("train", "val"):
            action = actions[split_value]
            if action.action.value == "reuse":
                continue
            self._import_action_payloads(
                action=action,
                project_id=runtime_manifest["projects"][split_value]["project_id"],
            )

        receipts = tuple(
            self.attest_project(actions[split_value].project)
            for split_value in ("train", "val")
        )
        self._assert_final_receipts_match_plan(plan, receipts)
        return receipts

    def _assert_final_receipts_match_plan(
        self, plan: Any, receipts: Sequence[Any]
    ) -> None:
        receipt_map = {receipt.split: receipt for receipt in receipts}

        class CachedAttestor:
            def attest_bootstrap_manifest(inner_self):
                return plan.manifest.to_dict()

            def attest_project(inner_self, desired):
                return receipt_map.get(desired.split)

        desired = {action.project.split: action.project for action in plan.projects}
        verified = self.contract.plan_instance_bootstrap(desired, CachedAttestor())
        if any(action.action.value != "reuse" for action in verified.projects):
            raise BootstrapStateDriftError(
                "post-apply live state is not a complete REUSE receipt"
            )

    def _assert_live_receipts_still_match(self, actions: Mapping[str, Any]) -> None:
        """Reject a stale plan before any RECONCILE/REUSE mutation."""

        for split_value in ("train", "val"):
            action = actions[split_value]
            try:
                observed = self.attest_project(action.project)
            except BootstrapStateDriftError as exc:
                raise BootstrapStateDriftError(
                    f"{split_value} live attestation changed after planning"
                ) from exc
            if observed is None:
                raise BootstrapStateDriftError(
                    f"{split_value} live project disappeared after planning"
                )
            if (
                action.live_attestation_fingerprint is None
                or observed.fingerprint != action.live_attestation_fingerprint
            ):
                raise BootstrapStateDriftError(
                    f"{split_value} live attestation changed after planning"
                )

    def _validate_plan(self, plan: Any) -> dict[str, Any]:
        if not isinstance(plan, self.contract.InstanceBootstrapPlan):
            raise BootstrapAdapterError("adapter requires InstanceBootstrapPlan")
        if Path(plan.runtime_layout.repo_root).resolve(strict=False) != self.repo_root:
            raise BootstrapAdapterError(
                "bootstrap plan belongs to a different repo root"
            )
        if (
            Path(plan.runtime_layout.root).resolve(strict=False)
            != self.runtime_layout.root
        ):
            raise BootstrapAdapterError("bootstrap plan runtime root drift")
        actions: dict[str, Any] = {}
        for action in plan.projects:
            split_value = self._split_value(action.project.split)
            if split_value in actions:
                raise BootstrapAdapterError(
                    f"duplicate bootstrap action for {split_value}"
                )
            if action.project.manifest.vendor_revision != self.vendor_revision:
                raise BootstrapStateDriftError(
                    f"{split_value} plan vendor revision does not match the live checkout"
                )
            actions[split_value] = action
        if set(actions) != {"train", "val"}:
            raise BootstrapAdapterError(
                "bootstrap plan must contain train and val exactly once"
            )
        self.contract.assert_manifest_matches(
            self.contract.build_instance_bootstrap_manifest(
                {
                    self.contract.Split(key): value.project
                    for key, value in actions.items()
                }
            ),
            plan.manifest,
        )
        self._assert_local_files_settings(plan.manifest.local_files_document_root)
        return actions

    def _create_projects_and_storages(
        self, actions: Mapping[str, Any]
    ) -> dict[str, tuple[Project, LocalFilesImportStorage]]:
        rows: dict[str, tuple[Project, LocalFilesImportStorage]] = {}
        with transaction.atomic():
            Organization.objects.select_for_update().get(pk=self.organization.pk)
            self._assert_no_managed_rows_without_manifest()
            for split_value in ("train", "val"):
                planned = actions[split_value].project
                project_serializer = ProjectSerializer(
                    data={
                        "title": f"CoordExp COCO bbox refinement - {split_value}",
                        "description": self._project_marker(
                            planned.manifest.project_identity
                        ),
                        "label_config": planned.label_config,
                        "show_skip_button": False,
                        "enable_empty_annotation": True,
                        "maximum_annotations": 1,
                        "show_collab_predictions": False,
                        "evaluate_predictions_automatically": False,
                        "is_published": True,
                    },
                    context={"created_by": self.operator_user},
                )
                project_serializer.is_valid(raise_exception=True)
                # DRF CharField trims trailing whitespace, while the parent
                # manifest fingerprints the exact canonical XML bytes.
                project_serializer.validated_data["label_config"] = planned.label_config
                project = project_serializer.save(organization=self.organization)

                storage_path = (
                    Path(planned.storage_manifest.document_root)
                    / planned.storage_manifest.storage_subdirectory
                )
                storage_serializer = LocalFilesImportStorageSerializer(
                    data={
                        "project": project.pk,
                        "title": planned.storage_manifest.storage_identity,
                        "description": self._storage_marker(
                            planned.storage_manifest.storage_identity
                        ),
                        "path": str(storage_path),
                        "regex_filter": LOCAL_IMAGE_REGEX,
                        "use_blob_urls": True,
                        "recursive_scan": False,
                        "synchronizable": False,
                    }
                )
                storage_serializer.is_valid(raise_exception=True)
                storage = storage_serializer.save()
                rows[split_value] = (project, storage)
        return rows

    def _import_action_payloads(
        self,
        *,
        action: Any,
        project_id: int,
    ) -> None:
        split_value = self._split_value(action.project.split)
        for payloads in action.iter_task_import_chunks(self.chunk_size):
            detached = [_json_copy(payload) for payload in payloads]
            if any(
                payload["data"].get("split") != split_value
                for payload in detached
            ):
                raise BootstrapAdapterError(
                    f"task payload is outside the planned {split_value} split"
                )
            self._import_chunk(
                project_id=project_id,
                split_value=split_value,
                payloads=detached,
            )

    def _import_chunk(
        self,
        *,
        project_id: int,
        split_value: str,
        payloads: Sequence[dict[str, Any]],
    ) -> None:
        if not payloads:
            return
        keys = [payload["data"]["coordexp_task_key"] for payload in payloads]
        with transaction.atomic():
            project = Project.objects.select_for_update().get(pk=project_id)
            existing: dict[str, Task] = {}
            queryset = Task.objects.filter(
                project_id=project_id,
                data__coordexp_task_key__in=keys,
            ).prefetch_related("annotations", "predictions")
            for task in queryset:
                key = (
                    task.data.get("coordexp_task_key")
                    if isinstance(task.data, dict)
                    else None
                )
                if key in existing:
                    raise BootstrapStateDriftError(f"duplicate live task key {key}")
                existing[key] = task

            to_create: list[dict[str, Any]] = []
            for payload in payloads:
                key = payload["data"]["coordexp_task_key"]
                task = existing.get(key)
                if task is not None:
                    self._assert_existing_task_matches(task, payload, split_value)
                    continue
                imported = _json_copy(payload)
                imported["allow_skip"] = False
                to_create.append(imported)
            if not to_create:
                return

            serializer = ImportApiSerializer(
                data=to_create,
                many=True,
                context={"project": project, "user": self.operator_user},
            )
            serializer.is_valid(raise_exception=True)
            created_tasks = serializer.save(project_id=project.pk)
            created_annotations = list(serializer.db_annotations)
            for annotation in created_annotations:
                annotation.updated_by = self.operator_user
                annotation.bulk_created = True
                annotation.result_count = len(
                    {item.get("id") for item in (annotation.result or [])}
                )
            if created_annotations:
                Annotation.objects.bulk_update(
                    created_annotations,
                    ["updated_by", "bulk_created", "result_count"],
                    batch_size=self.chunk_size,
                )
            Task.objects.filter(pk__in=[task.pk for task in created_tasks]).update(
                updated_by=self.operator_user,
                allow_skip=False,
            )
            project._update_tasks_counters_and_task_states(
                created_tasks,
                maximum_annotations_changed=False,
                overlap_cohort_percentage_changed=False,
                tasks_number_changed=True,
                recalculate_stats_counts={
                    "task_count": len(created_tasks),
                    "annotation_count": len(created_annotations),
                    "prediction_count": 0,
                },
            )
            if hasattr(project, "summary"):
                project.summary.update_data_columns(to_create)

            observed = (
                Task.objects.filter(
                    project_id=project_id,
                    data__coordexp_task_key__in=keys,
                )
                .values("data__coordexp_task_key")
                .annotate(row_count=Count("id"))
            )
            counts = {
                row["data__coordexp_task_key"]: row["row_count"] for row in observed
            }
            duplicates = sorted(key for key, count in counts.items() if count != 1)
            if duplicates:
                raise BootstrapStateDriftError(
                    "task-key cardinality drift after import: " + ", ".join(duplicates)
                )

    def _assert_existing_task_matches(
        self, task: Task, payload: Mapping[str, Any], split_value: str
    ) -> None:
        key = payload["data"]["coordexp_task_key"]
        if task.data != payload["data"] or task.data.get("split") != split_value:
            raise BootstrapStateDriftError(f"live task data drift for {key}")
        annotations = list(task.annotations.all())
        predictions = list(task.predictions.all())
        if len(annotations) != 1 or predictions:
            raise BootstrapStateDriftError(
                f"live annotation/prediction cardinality drift for {key}"
            )
        annotation = annotations[0]
        expected = payload["annotations"][0]
        if (
            annotation.result != expected["result"]
            or annotation.ground_truth is not False
        ):
            raise BootstrapStateDriftError(
                f"live authoritative annotation drift for {key}"
            )
        if annotation.was_cancelled or task.allow_skip is not False:
            raise BootstrapStateDriftError(f"live task control drift for {key}")

    def _attest_tasks(self, *, project: Project, desired: Any) -> Any:
        """Merge the immutable expected index with live rows in bounded chunks."""

        split_value = self._split_value(desired.split)
        fingerprint = self.contract.CanonicalJsonArrayFingerprint()
        live_iterator = self._iter_live_task_rows(project=project)
        live_item = next(live_iterator, None)
        observed_count = 0
        missing_count = 0

        for entry, expected_payload in desired.task_manifest.task_index.iter_records():
            if live_item is None:
                missing_count += 1
                continue
            task, annotation = live_item
            data = task["data"]
            if not isinstance(data, dict):
                raise BootstrapStateDriftError(
                    f"task {task['id']} data is not an object"
                )
            source_line = data.get("source_line")
            if (
                isinstance(source_line, bool)
                or not isinstance(source_line, int)
                or source_line < 1
            ):
                raise BootstrapStateDriftError(
                    f"task {task['id']} has invalid source_line"
                )
            if source_line < entry.source_line:
                raise BootstrapStateDriftError(
                    f"unexpected or duplicate live source line {source_line}"
                )
            if source_line > entry.source_line:
                missing_count += 1
                continue
            attestation = self._attest_live_task(
                project=project,
                split_value=split_value,
                task=task,
                annotation=annotation,
                expected_payload=expected_payload,
            )
            fingerprint.add(attestation.to_dict())
            observed_count += 1
            live_item = next(live_iterator, None)

        if live_item is not None:
            raise BootstrapStateDriftError("live project has unexpected task rows")
        if Annotation.objects.filter(project_id=project.pk).count() != observed_count:
            raise BootstrapStateDriftError(
                "annotations exist outside the managed project task set"
            )
        if Prediction.objects.filter(project_id=project.pk).exists():
            raise BootstrapStateDriftError(
                "predictions exist inside the managed project"
            )
        return self.contract.LiveTaskSetAttestation(
            expected_task_manifest_fingerprint=desired.task_manifest.fingerprint,
            observed_task_count=observed_count,
            missing_task_count=missing_count,
            content_fingerprint=fingerprint.fingerprint,
        )

    def _iter_live_task_rows(self, *, project: Project):
        task_rows = (
            Task.objects.filter(project_id=project.pk)
            .order_by("data__source_line", "id")
            .values(
                "id",
                "data",
                "allow_skip",
                "overlap",
                "is_labeled",
                "total_annotations",
                "cancelled_annotations",
                "total_predictions",
            )
            .iterator(chunk_size=self.chunk_size)
        )
        while True:
            chunk = list(islice(task_rows, self.chunk_size))
            if not chunk:
                return
            task_ids = [task["id"] for task in chunk]
            annotations: dict[int, dict[str, Any]] = {}
            for row in (
                Annotation.objects.filter(task_id__in=task_ids)
                .order_by("task_id", "id")
                .values(
                    "id",
                    "task_id",
                    "project_id",
                    "result",
                    "ground_truth",
                    "was_cancelled",
                    "updated_at",
                )
                .iterator(chunk_size=self.chunk_size)
            ):
                if row["task_id"] in annotations:
                    raise BootstrapStateDriftError(
                        f"multiple live annotations for task {row['task_id']}"
                    )
                annotations[row["task_id"]] = row
            if Prediction.objects.filter(task_id__in=task_ids).exists():
                raise BootstrapStateDriftError(
                    "predictions exist for a managed project task"
                )
            for task in chunk:
                yield task, annotations.get(task["id"])

    def _attest_live_task(
        self,
        *,
        project: Project,
        split_value: str,
        task: Mapping[str, Any],
        annotation: Mapping[str, Any] | None,
        expected_payload: Mapping[str, Any],
    ) -> Any:
        data = task["data"]
        key = data.get("coordexp_task_key")
        if data != expected_payload["data"] or data.get("split") != split_value:
            raise BootstrapStateDriftError(f"live task data drift for {key}")
        if task["allow_skip"] is not False or task["overlap"] != 1:
            raise BootstrapStateDriftError(f"live task controls drift for {key}")
        if annotation is None:
            raise BootstrapStateDriftError(f"missing authoritative annotation for {key}")
        if (
            task["total_annotations"] != 1
            or task["cancelled_annotations"] != 0
            or task["total_predictions"] != 0
            or task["is_labeled"] is not True
        ):
            raise BootstrapStateDriftError(f"live task counters drift for {key}")
        if (
            annotation["project_id"] != project.pk
            or annotation["was_cancelled"]
            or annotation["result"] != expected_payload["annotations"][0]["result"]
            or annotation["ground_truth"] is not False
        ):
            raise BootstrapStateDriftError(
                f"live authoritative annotation drift for {key}"
            )
        identity = self.contract.TaskIdentity(
            self.contract.Split(split_value), data["image_id"]
        )
        return self.contract.LiveTaskAttestation(
            identity=identity,
            source_line=data["source_line"],
            image_locator=data["image"],
            task_data_fingerprint=self.contract.fingerprint_json(data),
            task_id=task["id"],
            annotation_count=1,
            authoritative_annotation_id=annotation["id"],
            authoritative_annotation_revision=annotation["updated_at"].isoformat(),
            authoritative_annotation_fingerprint=self.contract.fingerprint_json(
                {"result": annotation["result"], "ground_truth": False}
            ),
            authoritative_annotation_ground_truth=False,
            alternate_annotation_count=0,
            prediction_count=0,
        )

    def _assert_project_fields(
        self,
        project: Project,
        *,
        split_value: str,
        project_identity: str,
        controls: Any,
    ) -> None:
        mismatches: list[str] = []
        if project.organization_id != self.organization.pk:
            mismatches.append("organization_id")
        if project.description != self._project_marker(project_identity):
            mismatches.append("project_identity_marker")
        if project.maximum_annotations != controls.authoritative_annotations_per_task:
            mismatches.append("maximum_annotations")
        if project.maximum_annotations != 1:
            mismatches.append("maximum_annotations!=1")
        if (
            project.show_skip_button is not False
            or controls.show_native_skip is not False
        ):
            mismatches.append("show_skip_button")
        if project.enable_empty_annotation is not True:
            mismatches.append("enable_empty_annotation")
        if project.show_collab_predictions is not False:
            mismatches.append("show_collab_predictions")
        if mismatches:
            raise BootstrapStateDriftError(
                f"{split_value} project field drift: " + ", ".join(mismatches)
            )

    def _assert_storage_fields(
        self,
        *,
        project: Project,
        storage_id: int,
        storage_manifest: Any,
    ) -> None:
        storages = list(LocalFilesImportStorage.objects.filter(project_id=project.pk))
        if len(storages) != 1 or storages[0].pk != storage_id:
            raise BootstrapStateDriftError(
                f"project {project.pk} must have exactly one bound Local Files import storage"
            )
        storage = storages[0]
        expected_path = str(
            Path(storage_manifest.document_root) / storage_manifest.storage_subdirectory
        )
        mismatches: list[str] = []
        if storage.description != self._storage_marker(
            storage_manifest.storage_identity
        ):
            mismatches.append("storage_identity_marker")
        if str(Path(storage.path).resolve(strict=False)) != str(
            Path(expected_path).resolve(strict=False)
        ):
            mismatches.append("path")
        if storage.regex_filter != LOCAL_IMAGE_REGEX:
            mismatches.append("regex_filter")
        if storage.use_blob_urls is not True:
            mismatches.append("use_blob_urls")
        if storage.recursive_scan is not False:
            mismatches.append("recursive_scan")
        if storage.synchronizable is not False:
            mismatches.append("synchronizable")
        self._assert_local_files_settings(storage_manifest.document_root)
        try:
            storage.validate_connection()
        except Exception as exc:
            raise BootstrapStateDriftError(
                "Local Files storage connection drift"
            ) from exc
        if mismatches:
            raise BootstrapStateDriftError(
                "storage field drift: " + ", ".join(mismatches)
            )

    def _ensure_managed_link(self, storage_manifest: Any) -> None:
        link = Path(storage_manifest.managed_link)
        target = Path(storage_manifest.managed_link_target)
        if not target.is_dir():
            raise BootstrapAdapterError(
                f"managed image target is not a directory: {target}"
            )
        link.parent.mkdir(parents=True, exist_ok=True)
        if os.path.lexists(link):
            self._attest_managed_link(link, target)
            return
        try:
            os.symlink(str(target), str(link), target_is_directory=True)
        except FileExistsError:
            self._attest_managed_link(link, target)
        _fsync_directory(link.parent)

    def _attest_managed_link(self, link: Path, target: Path) -> tuple[bool, str]:
        if not link.is_symlink():
            raise BootstrapStateDriftError(
                f"managed image path is not a symlink: {link}"
            )
        try:
            observed = link.resolve(strict=True)
            expected = target.resolve(strict=True)
        except OSError as exc:
            raise BootstrapStateDriftError(
                f"managed image link cannot be resolved: {link}"
            ) from exc
        if observed != expected:
            raise BootstrapStateDriftError(f"managed image link target drift: {link}")
        return True, str(observed)

    def _build_runtime_manifest(
        self,
        plan: Any,
        actions: Mapping[str, Any],
        rows: Mapping[str, tuple[Project, LocalFilesImportStorage]],
    ) -> dict[str, Any]:
        projects: dict[str, Any] = {}
        for split_value in ("train", "val"):
            planned = actions[split_value].project
            project, storage = rows[split_value]
            projects[split_value] = {
                "project_identity": planned.manifest.project_identity,
                "project_id": project.pk,
                "created_by_id": project.created_by_id,
                "storage_id": storage.pk,
                "project_manifest": planned.manifest.to_dict(),
                "storage_manifest": planned.storage_manifest.to_dict(),
                "controls": planned.controls.to_dict(),
            }
        body = {
            "schema_version": RUNTIME_MANIFEST_SCHEMA_VERSION,
            "organization_id": self.organization.pk,
            "desired_manifest": plan.manifest.to_dict(),
            "projects": projects,
        }
        return {**body, "fingerprint": self.contract.fingerprint_json(body)}

    def _write_runtime_manifest_once(self, payload: Mapping[str, Any]) -> None:
        canonical = _canonical_json_bytes(payload)
        path = self.runtime_manifest_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if os.path.lexists(path):
            if path.is_symlink() or not path.is_file():
                raise BootstrapStateDriftError(
                    "runtime bootstrap manifest path is not a regular file"
                )
            if path.read_bytes() == canonical:
                return
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest already exists with different bytes"
            )
        fd, temporary = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(canonical)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            try:
                # A same-directory hard-link publish is atomic and, unlike
                # os.replace(), can never overwrite a concurrently published
                # manifest.
                os.link(temporary, path)
            except FileExistsError:
                if path.is_symlink() or not path.is_file():
                    raise BootstrapStateDriftError(
                        "runtime manifest appeared as a non-regular path"
                    ) from None
                if path.read_bytes() != canonical:
                    raise BootstrapStateDriftError(
                        "runtime manifest appeared with different bytes"
                    ) from None
            _fsync_directory(path.parent)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _load_runtime_manifest(self) -> dict[str, Any] | None:
        path = self.runtime_manifest_path
        if not os.path.lexists(path):
            self._assert_no_managed_rows_without_manifest()
            return None
        if path.is_symlink() or not path.is_file():
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest path is not a regular file"
            )
        raw = path.read_bytes()
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest is not valid JSON"
            ) from exc
        if not isinstance(payload, dict) or raw != _canonical_json_bytes(payload):
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest is not canonical JSON"
            )
        required = {
            "schema_version",
            "organization_id",
            "desired_manifest",
            "projects",
            "fingerprint",
        }
        if set(payload) != required:
            raise BootstrapStateDriftError("runtime bootstrap manifest shape drift")
        body = {key: payload[key] for key in required if key != "fingerprint"}
        if payload["fingerprint"] != self.contract.fingerprint_json(body):
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest fingerprint drift"
            )
        if payload["schema_version"] != RUNTIME_MANIFEST_SCHEMA_VERSION:
            raise BootstrapStateDriftError("runtime bootstrap manifest schema drift")
        if payload["organization_id"] != self.organization.pk:
            raise BootstrapStateDriftError(
                "runtime bootstrap manifest organization drift"
            )
        if not isinstance(payload["desired_manifest"], dict):
            raise BootstrapStateDriftError("runtime desired manifest is not an object")
        projects = payload["projects"]
        if not isinstance(projects, dict) or set(projects) != {"train", "val"}:
            raise BootstrapStateDriftError(
                "runtime project map must contain train and val"
            )
        project_ids: set[int] = set()
        storage_ids: set[int] = set()
        entry_fields = {
            "project_identity",
            "project_id",
            "created_by_id",
            "storage_id",
            "project_manifest",
            "storage_manifest",
            "controls",
        }
        for split_value, entry in projects.items():
            if not isinstance(entry, dict) or set(entry) != entry_fields:
                raise BootstrapStateDriftError(
                    f"runtime {split_value} entry shape drift"
                )
            project_id = _positive_int(entry["project_id"], f"{split_value}.project_id")
            storage_id = _positive_int(entry["storage_id"], f"{split_value}.storage_id")
            _positive_int(entry["created_by_id"], f"{split_value}.created_by_id")
            if project_id in project_ids or storage_id in storage_ids:
                raise BootstrapStateDriftError("cross-split project/storage ID reuse")
            project_ids.add(project_id)
            storage_ids.add(storage_id)
            if not all(
                isinstance(entry[field], dict)
                for field in ("project_manifest", "storage_manifest", "controls")
            ):
                raise BootstrapStateDriftError(
                    f"runtime {split_value} nested manifest drift"
                )
            if entry["project_identity"] != entry["project_manifest"].get(
                "project_identity"
            ):
                raise BootstrapStateDriftError(
                    f"runtime {split_value} identity binding drift"
                )
            if entry["project_manifest"].get("split") != split_value:
                raise BootstrapStateDriftError(
                    f"runtime {split_value} project split drift"
                )
            if entry["storage_manifest"].get("split") != split_value:
                raise BootstrapStateDriftError(
                    f"runtime {split_value} storage split drift"
                )
        return payload

    def _validate_live_bindings(self, runtime_manifest: Mapping[str, Any]) -> None:
        for split_value in ("train", "val"):
            entry = runtime_manifest["projects"][split_value]
            marker = self._project_marker(entry["project_identity"])
            matching_projects = list(Project.all_objects.filter(description=marker))
            if (
                len(matching_projects) != 1
                or matching_projects[0].pk != entry["project_id"]
            ):
                raise BootstrapStateDriftError(
                    f"{split_value} project ID/identity binding drift"
                )
            project = matching_projects[0]
            if project.organization_id != self.organization.pk:
                raise BootstrapStateDriftError(
                    f"{split_value} project organization drift"
                )
            if project.deleted_at is not None:
                raise BootstrapStateDriftError(f"{split_value} project is soft-deleted")
            if project.created_by_id != entry["created_by_id"]:
                raise BootstrapStateDriftError(
                    f"{split_value} project creator binding drift"
                )
            storage_identity = entry["storage_manifest"].get("storage_identity")
            storage_marker = self._storage_marker(storage_identity)
            matching_storages = list(
                LocalFilesImportStorage.objects.filter(description=storage_marker)
            )
            if (
                len(matching_storages) != 1
                or matching_storages[0].pk != entry["storage_id"]
                or matching_storages[0].project_id != project.pk
            ):
                raise BootstrapStateDriftError(
                    f"{split_value} storage ID/identity binding drift"
                )

    def _assert_no_managed_rows_without_manifest(self) -> None:
        identities = [
            f"coco-refinement:{self.contract.DATASET_NAME}:{split_value}"
            for split_value in ("train", "val")
        ]
        project_markers = [self._project_marker(identity) for identity in identities]
        storage_markers = [
            self._storage_marker(
                f"local-files:{self.contract.DATASET_NAME}:{split_value}"
            )
            for split_value in ("train", "val")
        ]
        if Project.all_objects.filter(description__in=project_markers).exists():
            raise BootstrapStateDriftError(
                "managed live project exists without the runtime bootstrap manifest"
            )
        if LocalFilesImportStorage.objects.filter(
            description__in=storage_markers
        ).exists():
            raise BootstrapStateDriftError(
                "managed live storage exists without the runtime bootstrap manifest"
            )

    def _assert_operator_scope(self) -> None:
        if not getattr(self.operator_user, "is_authenticated", False):
            raise BootstrapAdapterError("operator user must be authenticated")
        if not getattr(self.operator_user, "is_active", False):
            raise BootstrapAdapterError("operator user must be active")
        if self.operator_user.pk is None or self.organization.pk is None:
            raise BootstrapAdapterError(
                "operator user and organization must be persisted"
            )
        if self.operator_user.active_organization_id != self.organization.pk:
            raise BootstrapAdapterError("operator active organization does not match")
        if not OrganizationMember.objects.filter(
            user_id=self.operator_user.pk,
            organization_id=self.organization.pk,
            deleted_at__isnull=True,
        ).exists():
            raise BootstrapAdapterError("operator is not an active organization member")

    def _assert_local_files_settings(self, expected_root: str) -> None:
        configured = Path(settings.LOCAL_FILES_DOCUMENT_ROOT).resolve(strict=False)
        expected = Path(expected_root).resolve(strict=False)
        if configured != expected:
            raise BootstrapStateDriftError(
                "LOCAL_FILES_DOCUMENT_ROOT does not match the planned shared image root"
            )
        if settings.LOCAL_FILES_SERVING_ENABLED is not True:
            raise BootstrapStateDriftError("LOCAL_FILES_SERVING_ENABLED must be true")

    def _storage_manifest_from_dict(self, payload: Mapping[str, Any]) -> Any:
        expected_fields = {
            "split",
            "project_identity",
            "storage_identity",
            "document_root",
            "storage_subdirectory",
            "task_locator_prefix",
            "managed_link",
            "managed_link_target",
            "fingerprint",
        }
        if set(payload) != expected_fields:
            raise BootstrapStateDriftError("saved storage manifest shape drift")
        manifest = self.contract.StorageManifest(
            split=self.contract.Split(payload["split"]),
            project_identity=payload["project_identity"],
            storage_identity=payload["storage_identity"],
            document_root=payload["document_root"],
            storage_subdirectory=payload["storage_subdirectory"],
            task_locator_prefix=payload["task_locator_prefix"],
            managed_link=payload["managed_link"],
            managed_link_target=payload["managed_link_target"],
        )
        if manifest.fingerprint != payload["fingerprint"]:
            raise BootstrapStateDriftError("saved storage manifest fingerprint drift")
        return manifest

    def _controls_from_dict(self, payload: Mapping[str, Any]) -> Any:
        expected = self.contract.ProjectControls().to_dict()
        if dict(payload) != expected:
            raise BootstrapStateDriftError("saved project controls drift")
        return self.contract.ProjectControls(**payload)

    def _read_vendor_revision(self) -> str:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=self.vendor_root,
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (
            OSError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
        ) as exc:
            raise BootstrapAdapterError(
                "cannot attest the Label Studio vendor revision"
            ) from exc
        return result.stdout.strip()

    @staticmethod
    def _project_marker(project_identity: str) -> str:
        return PROJECT_MARKER_PREFIX + project_identity

    @staticmethod
    def _storage_marker(storage_identity: str) -> str:
        return STORAGE_MARKER_PREFIX + storage_identity

    @staticmethod
    def _split_value(split: Any) -> str:
        value = getattr(split, "value", split)
        if value not in {"train", "val"}:
            raise BootstrapAdapterError(f"unsupported split {value!r}")
        return value


def build_desired_projects(repo_root: Path, *, vendor_revision: str) -> dict[Any, Any]:
    """Build the exact train/val desired plans used by the management command."""

    contract = _load_contract_module(Path(repo_root))
    label_config_module = importlib.import_module(
        "src.label_studio_coco_refinement.label_config"
    )
    config = label_config_module.build_label_config()
    config_fingerprint = label_config_module.label_config_fingerprint(config)
    return {
        split: contract.build_split_project_plan(
            contract.SOURCE_CONTRACTS[split].path(Path(repo_root)),
            repo_root=Path(repo_root),
            split=split,
            vendor_revision=vendor_revision,
            label_config=config,
            label_config_fingerprint=config_fingerprint,
        )
        for split in (contract.Split.TRAIN, contract.Split.VAL)
    }


def _load_contract_module(repo_root: Path) -> ModuleType:
    root = Path(repo_root).resolve(strict=False)
    expected = root / "src" / "label_studio_coco_refinement" / "project.py"
    if not expected.is_file():
        raise BootstrapAdapterError(f"CoordExp contract module is missing: {expected}")
    root_string = str(root)
    if root_string not in sys.path:
        sys.path.insert(0, root_string)
    module = importlib.import_module("src.label_studio_coco_refinement.project")
    observed = Path(module.__file__).resolve(strict=True)
    if observed != expected.resolve(strict=True):
        raise BootstrapAdapterError(
            f"CoordExp contract module came from a different checkout: {observed}"
        )
    return module


def _canonical_json_bytes(payload: Any) -> bytes:
    return (
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _json_copy(payload: Any) -> Any:
    return json.loads(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise BootstrapStateDriftError(f"{field} must be a positive integer")
    return value


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def _current_operator_context(operator_user: Any):
    """Set the vendor FSM actor without leaking thread-local job context."""

    job_data = CurrentContext.get_job_data()
    previous = dict(job_data)
    CurrentContext.set_user(operator_user)
    try:
        yield
    finally:
        current = CurrentContext.get_job_data()
        current.clear()
        current.update(previous)


__all__ = [
    "BootstrapAdapterError",
    "BootstrapStateDriftError",
    "DjangoRefinementProjectAdapter",
    "build_desired_projects",
]

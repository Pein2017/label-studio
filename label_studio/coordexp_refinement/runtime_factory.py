"""Explicit production lifecycle for the localhost refinement runtime."""

from __future__ import annotations

import json
import math
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from coordexp_refinement.bootstrap import (
    DjangoRefinementProjectAdapter,
    build_desired_projects,
)
from coordexp_refinement.catalog import DjangoAnnotationVerifier, DjangoDraftCatalog
from coordexp_refinement.registry import ProjectRuntimeRegistry, runtime_registry
from src.label_studio_coco_refinement.runtime import RefinementRuntime
from src.label_studio_coco_refinement.store import BootstrapSpec, WorkingDatasetStore

_SPLITS = ("train", "val")


class RuntimeFactoryError(RuntimeError):
    """Production runtime construction or lifecycle failed closed."""


class FailClosedInferenceReceiptResolver:
    """Reject every inference receipt until the durable ROI resolver is wired."""

    def resolve(self, receipt_id: str):
        del receipt_id
        return None


class ProductionRuntimeService:
    """One explicitly started runtime plus its registry/worker cleanup state."""

    def __init__(
        self,
        *,
        runtime: RefinementRuntime,
        project_pks: Mapping[str, int],
        registry: ProjectRuntimeRegistry,
        startup_timeout: float = 120.0,
        health_poll_interval: float = 0.01,
    ) -> None:
        if set(project_pks) != set(_SPLITS):
            raise RuntimeFactoryError(
                "runtime service requires train and val project IDs"
            )
        self.runtime = runtime
        self.project_pks = dict(project_pks)
        self.registry = registry
        if (
            isinstance(startup_timeout, bool)
            or not isinstance(startup_timeout, (int, float))
            or not math.isfinite(startup_timeout)
            or startup_timeout <= 0
        ):
            raise RuntimeFactoryError("startup timeout must be positive")
        if (
            isinstance(health_poll_interval, bool)
            or not isinstance(health_poll_interval, (int, float))
            or not math.isfinite(health_poll_interval)
            or health_poll_interval <= 0
        ):
            raise RuntimeFactoryError("health poll interval must be positive")
        self.startup_timeout = float(startup_timeout)
        self.health_poll_interval = float(health_poll_interval)
        self._registered: list[int] = []
        self._workers_may_be_running = False
        self._running = False
        self._closed = False

    def start(self) -> None:
        if self._closed:
            raise RuntimeFactoryError("runtime service is already closed")
        if self._running:
            return
        try:
            self._workers_may_be_running = True
            for split in _SPLITS:
                self.runtime.start_workers(split=split)
                self._await_initial_recovery(split)
            for split in _SPLITS:
                self._require_healthy_before_registration(split)
            for split in _SPLITS:
                project_pk = self.project_pks[split]
                self.registry.register(
                    project_pk=project_pk, split=split, runtime=self.runtime
                )
                self._registered.append(project_pk)
            self._running = True
        except BaseException as exc:
            cleanup_error = self._cleanup()
            if cleanup_error is not None:
                raise RuntimeFactoryError(
                    "runtime startup cleanup failed"
                ) from cleanup_error
            if isinstance(exc, RuntimeFactoryError):
                raise
            raise RuntimeFactoryError("runtime worker startup failed") from exc

    def close(self) -> None:
        if self._closed:
            return
        stop_error = self._cleanup()
        self._closed = True
        if stop_error is not None:
            raise stop_error

    def _cleanup(self) -> BaseException | None:
        stop_error: BaseException | None = None
        if self._workers_may_be_running:
            try:
                self.runtime.stop_workers()
            except BaseException as exc:
                stop_error = exc
            finally:
                self._workers_may_be_running = False
        for project_pk in reversed(self._registered):
            self.registry.unregister(project_pk)
        self._registered.clear()
        self._running = False
        return stop_error

    def _await_initial_recovery(self, split: str) -> None:
        deadline = time.monotonic() + self.startup_timeout
        while True:
            healthy, state_value, thread_alive, error = self._read_worker_health(split)

            if (
                healthy is True
                and thread_alive is True
                and state_value in {"idle", "running"}
            ):
                return
            if state_value in {"failed", "stopped"} or thread_alive is False:
                detail = error if isinstance(error, str) and error else state_value
                raise RuntimeFactoryError(
                    f"{split} worker initial recovery failed: {detail}"
                )
            if time.monotonic() >= deadline:
                raise RuntimeFactoryError(f"{split} worker initial recovery timed out")
            time.sleep(self.health_poll_interval)

    def _require_healthy_before_registration(self, split: str) -> None:
        healthy, state_value, thread_alive, error = self._read_worker_health(split)
        if (
            healthy is True
            and thread_alive is True
            and state_value in {"idle", "running"}
        ):
            return
        detail = error if isinstance(error, str) and error else state_value
        raise RuntimeFactoryError(
            f"{split} worker became unhealthy before registration: {detail}"
        )

    def _read_worker_health(self, split: str) -> tuple[Any, Any, Any, Any]:
        try:
            health = self.runtime.worker_health(split=split)
            healthy = getattr(health, "healthy")
            state = getattr(health, "state")
            state_value = getattr(state, "value", state)
            thread_alive = getattr(health, "thread_alive")
            error = getattr(health, "error")
        except Exception as exc:
            raise RuntimeFactoryError(
                f"{split} worker returned invalid startup health"
            ) from exc
        return healthy, state_value, thread_alive, error


class ProductionRuntimeFactory:
    """Apply/attest bootstrap state and construct one two-split runtime."""

    def __init__(
        self,
        *,
        repo_root: Path,
        operator_user: Any,
        organization: Any,
        chunk_size: int = 500,
        inference_receipt_resolver: Any | None = None,
        registry: ProjectRuntimeRegistry = runtime_registry,
        adapter_factory: Callable[..., Any] = DjangoRefinementProjectAdapter,
        desired_builder: Callable[..., Mapping[Any, Any]] = build_desired_projects,
        store_bootstrap: Callable[..., Any] = WorkingDatasetStore.bootstrap,
        verifier_factory: Callable[..., Any] = DjangoAnnotationVerifier,
        catalog_factory: Callable[..., Any] = DjangoDraftCatalog,
        runtime_factory: Callable[..., Any] = RefinementRuntime,
    ) -> None:
        self.repo_root = Path(repo_root).expanduser().resolve(strict=False)
        self.operator_user = operator_user
        self.organization = organization
        if (
            isinstance(chunk_size, bool)
            or not isinstance(chunk_size, int)
            or chunk_size < 1
        ):
            raise RuntimeFactoryError("chunk_size must be a positive integer")
        self.chunk_size = chunk_size
        self.inference_receipt_resolver = (
            inference_receipt_resolver
            if inference_receipt_resolver is not None
            else FailClosedInferenceReceiptResolver()
        )
        if not callable(getattr(self.inference_receipt_resolver, "resolve", None)):
            raise RuntimeFactoryError(
                "inference receipt resolver must provide resolve()"
            )
        self.registry = registry
        self.adapter_factory = adapter_factory
        self.desired_builder = desired_builder
        self.store_bootstrap = store_bootstrap
        self.verifier_factory = verifier_factory
        self.catalog_factory = catalog_factory
        self.runtime_factory = runtime_factory

    def build(self) -> ProductionRuntimeService:
        adapter = self.adapter_factory(
            repo_root=self.repo_root,
            operator_user=self.operator_user,
            organization=self.organization,
            chunk_size=self.chunk_size,
        )
        desired = self.desired_builder(
            self.repo_root,
            vendor_revision=adapter.vendor_revision,
        )
        desired_by_split = _normalize_desired(desired)
        plan = adapter.contract.plan_instance_bootstrap(desired, adapter)
        adapter.apply(plan)
        verified = adapter.contract.plan_instance_bootstrap(desired, adapter)
        if _plan_actions(verified) != {"train": "reuse", "val": "reuse"}:
            raise RuntimeFactoryError(
                "post-apply bootstrap did not attest as exact REUSE"
            )

        manifest = _read_stable_attested_manifest(
            adapter, organization=self.organization
        )
        projects = manifest["projects"]
        project_pks = {split: int(projects[split]["project_id"]) for split in _SPLITS}
        project_ids = {split: str(project_pks[split]) for split in _SPLITS}
        verifier = self.verifier_factory(project_pks)

        stores: dict[str, WorkingDatasetStore] = {}
        for split in _SPLITS:
            planned = desired_by_split[split]
            entry = projects[split]
            spec = _store_bootstrap_spec(
                split=split,
                planned=planned,
                plan=verified,
                runtime_manifest=manifest,
                project_id=project_ids[split],
                storage_id=str(entry["storage_id"]),
            )
            result = self.store_bootstrap(
                spec,
                annotation_verifier=verifier,
                inference_receipt_resolver=self.inference_receipt_resolver,
            )
            store = getattr(result, "store", None)
            if store is None:
                raise RuntimeFactoryError(f"{split} store bootstrap returned no store")
            stores[split] = store

        catalog = self.catalog_factory(stores, project_pks)
        runtime = self.runtime_factory(
            catalog=catalog,
            stores=stores,
            project_ids=project_ids,
        )
        return ProductionRuntimeService(
            runtime=runtime,
            project_pks=project_pks,
            registry=self.registry,
        )

    def start(self) -> ProductionRuntimeService:
        service = self.build()
        service.start()
        return service


def _normalize_desired(desired: Mapping[Any, Any]) -> dict[str, Any]:
    if not isinstance(desired, Mapping):
        raise RuntimeFactoryError("desired projects must be a mapping")
    normalized: dict[str, Any] = {}
    for key, value in desired.items():
        split = getattr(key, "value", key)
        if split not in _SPLITS or split in normalized:
            raise RuntimeFactoryError(
                "desired projects must contain train and val exactly once"
            )
        normalized[split] = value
    if set(normalized) != set(_SPLITS):
        raise RuntimeFactoryError(
            "desired projects must contain train and val exactly once"
        )
    return normalized


def _plan_actions(plan: Any) -> dict[str, str]:
    actions: dict[str, str] = {}
    for action in getattr(plan, "projects", ()):
        split = getattr(getattr(action, "project", None), "split", None)
        split = getattr(split, "value", split)
        value = getattr(getattr(action, "action", None), "value", None)
        if split in actions or split not in _SPLITS or not isinstance(value, str):
            raise RuntimeFactoryError(
                "bootstrap plan has an invalid split/action shape"
            )
        actions[split] = value
    if set(actions) != set(_SPLITS):
        raise RuntimeFactoryError("bootstrap plan must contain train and val")
    return actions


def _read_stable_attested_manifest(
    adapter: Any, *, organization: Any
) -> dict[str, Any]:
    path = Path(adapter.runtime_manifest_path)
    before, raw_before = _read_canonical_manifest(path)
    attested = adapter.attest_bootstrap_manifest()
    after, raw_after = _read_canonical_manifest(path)
    if raw_before != raw_after or before != after:
        raise RuntimeFactoryError(
            "runtime bootstrap manifest changed during attestation"
        )
    if not isinstance(attested, Mapping) or dict(attested) != before.get(
        "desired_manifest"
    ):
        raise RuntimeFactoryError("runtime bootstrap manifest attestation mismatch")
    required = {
        "schema_version",
        "organization_id",
        "desired_manifest",
        "projects",
        "fingerprint",
    }
    if set(before) != required or before["organization_id"] != getattr(
        organization, "pk", None
    ):
        raise RuntimeFactoryError("runtime bootstrap manifest identity drift")
    projects = before["projects"]
    if not isinstance(projects, dict) or set(projects) != set(_SPLITS):
        raise RuntimeFactoryError("runtime bootstrap manifest must bind train and val")
    project_ids: set[int] = set()
    storage_ids: set[int] = set()
    for split in _SPLITS:
        entry = projects[split]
        if not isinstance(entry, dict):
            raise RuntimeFactoryError(f"{split} runtime manifest entry is invalid")
        project_id = _positive_int(entry.get("project_id"), f"{split}.project_id")
        storage_id = _positive_int(entry.get("storage_id"), f"{split}.storage_id")
        if project_id in project_ids or storage_id in storage_ids:
            raise RuntimeFactoryError("runtime manifest reuses project or storage IDs")
        project_ids.add(project_id)
        storage_ids.add(storage_id)
        project_manifest = entry.get("project_manifest")
        storage_manifest = entry.get("storage_manifest")
        if (
            not isinstance(project_manifest, dict)
            or project_manifest.get("split") != split
            or not isinstance(storage_manifest, dict)
            or storage_manifest.get("split") != split
        ):
            raise RuntimeFactoryError(f"{split} runtime manifest split binding drift")
    return before


def _read_canonical_manifest(path: Path) -> tuple[dict[str, Any], bytes]:
    if path.is_symlink() or not path.is_file():
        raise RuntimeFactoryError("runtime bootstrap manifest is not a regular file")
    raw = path.read_bytes()
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeFactoryError(
            "runtime bootstrap manifest is not valid JSON"
        ) from exc
    if not isinstance(payload, dict) or raw != _canonical_json_bytes(payload):
        raise RuntimeFactoryError("runtime bootstrap manifest is not canonical JSON")
    return payload, raw


def _store_bootstrap_spec(
    *,
    split: str,
    planned: Any,
    plan: Any,
    runtime_manifest: Mapping[str, Any],
    project_id: str,
    storage_id: str,
) -> BootstrapSpec:
    manifest = planned.manifest
    return BootstrapSpec(
        split=split,
        source_path=Path(planned.source_inspection.source_path),
        runtime_root=Path(plan.runtime_layout.root),
        image_root=Path(plan.runtime_layout.image_root),
        expected_source_sha256=planned.source_inspection.sha256,
        project_id=project_id,
        storage_id=storage_id,
        adapter_version=manifest.adapter_version,
        vendor_revision=manifest.vendor_revision,
        registry_fingerprint=manifest.category_registry_fingerprint,
        label_config_fingerprint=manifest.label_config_fingerprint,
        storage_subdir=planned.storage_manifest.storage_subdirectory,
        extra_fingerprints={
            "runtime_bootstrap_manifest": str(runtime_manifest["fingerprint"]),
            "project_manifest": str(manifest.fingerprint),
            "task_manifest": str(planned.task_manifest.fingerprint),
            "storage_manifest": str(planned.storage_manifest.fingerprint),
            "annotation_policy": str(
                manifest.authoritative_annotation_policy_fingerprint
            ),
        },
    )


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeFactoryError(f"{field} must be a positive integer")
    return value


def _canonical_json_bytes(payload: Any) -> bytes:
    return (
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


__all__ = [
    "FailClosedInferenceReceiptResolver",
    "ProductionRuntimeFactory",
    "ProductionRuntimeService",
    "RuntimeFactoryError",
]

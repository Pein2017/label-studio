"""Fail-closed server-side project to refinement-runtime bindings."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from src.label_studio_coco_refinement.runtime import (
    AuthenticatedPrincipal,
    BatchStatusReceipt,
)

_SUPPORTED_SPLITS = frozenset({'train', 'val'})


class RefinementRuntimeProtocol(Protocol):
    project_ids: Mapping[str, str]

    def capture_and_enqueue(
        self,
        *,
        split: str,
        batch_id: str,
        principal: AuthenticatedPrincipal,
    ) -> BatchStatusReceipt: ...

    def batch_status(self, *, split: str, batch_id: str) -> BatchStatusReceipt: ...


class RuntimeBindingError(RuntimeError):
    """A project has no valid explicit refinement-runtime binding."""


@dataclass(frozen=True)
class ProjectRuntimeBinding:
    project_pk: int
    split: str
    runtime: RefinementRuntimeProtocol
    services: Any | None = None


class ProjectRuntimeRegistry:
    """Thread-safe explicit bindings; project metadata is never inference input."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._bindings: dict[int, ProjectRuntimeBinding] = {}

    def register(
        self,
        *,
        project_pk: int,
        split: str,
        runtime: RefinementRuntimeProtocol,
        services: Any | None = None,
        replace: bool = False,
    ) -> ProjectRuntimeBinding:
        project_pk = _validate_project_pk(project_pk)
        if split not in _SUPPORTED_SPLITS:
            raise ValueError('split must be train or val')
        if not callable(getattr(runtime, 'capture_and_enqueue', None)) or not callable(
            getattr(runtime, 'batch_status', None)
        ):
            raise TypeError('runtime must provide capture_and_enqueue and batch_status')
        project_ids = getattr(runtime, 'project_ids', None)
        if not isinstance(project_ids, Mapping) or project_ids.get(split) != str(project_pk):
            raise RuntimeBindingError('runtime project/split mapping does not match the binding')
        if services is not None:
            for attribute in ('manager', 'targets', 'finalizer', 'receipt_store'):
                if getattr(services, attribute, None) is None:
                    raise RuntimeBindingError('ROI service bundle is incomplete')
        binding = ProjectRuntimeBinding(
            project_pk=project_pk,
            split=split,
            runtime=runtime,
            services=services,
        )
        with self._lock:
            current = self._bindings.get(project_pk)
            if current is not None:
                if current.split == split and current.runtime is runtime and current.services is services:
                    return current
                if not replace:
                    raise RuntimeBindingError('project runtime is already registered')
            self._bindings[project_pk] = binding
        return binding

    def resolve(self, project_pk: int) -> ProjectRuntimeBinding:
        project_pk = _validate_project_pk(project_pk)
        with self._lock:
            binding = self._bindings.get(project_pk)
        if binding is None:
            raise RuntimeBindingError('project runtime is not registered')
        return binding

    def unregister(self, project_pk: int) -> None:
        project_pk = _validate_project_pk(project_pk)
        with self._lock:
            self._bindings.pop(project_pk, None)


def _validate_project_pk(project_pk: int) -> int:
    if isinstance(project_pk, bool) or not isinstance(project_pk, int) or project_pk <= 0:
        raise ValueError('project_pk must be a positive integer')
    return project_pk


runtime_registry = ProjectRuntimeRegistry()


__all__ = [
    'ProjectRuntimeBinding',
    'ProjectRuntimeRegistry',
    'RefinementRuntimeProtocol',
    'RuntimeBindingError',
    'runtime_registry',
]

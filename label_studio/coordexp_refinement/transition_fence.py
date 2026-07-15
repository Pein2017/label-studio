"""In-process serialization for managed Draft lifecycle transitions."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator


class DraftTransitionFenceError(RuntimeError):
    """A transition fence or project binding is invalid."""


@dataclass
class _FenceEntry:
    lock: threading.RLock
    references: int = 0


class DraftTransitionFence:
    """Reference-counted per-task reentrant locks for one server process."""

    def __init__(self) -> None:
        self._registry_lock = threading.Lock()
        self._entries: dict[tuple[int, int, str], _FenceEntry] = {}

    @contextmanager
    def hold(self, *, project_id: int, user_id: int, task_key: str) -> Iterator[None]:
        key = _canonical_fence_key(project_id=project_id, user_id=user_id, task_key=task_key)
        with self._registry_lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = _FenceEntry(lock=threading.RLock())
                self._entries[key] = entry
            entry.references += 1
        entry.lock.acquire()
        try:
            yield
        finally:
            entry.lock.release()
            with self._registry_lock:
                entry.references -= 1
                if entry.references == 0:
                    if self._entries.get(key) is not entry:
                        raise DraftTransitionFenceError('transition fence registry identity changed')
                    del self._entries[key]

    @property
    def active_key_count(self) -> int:
        """Return live held-or-waiting keys; intended for health checks and tests."""

        with self._registry_lock:
            return len(self._entries)

    def reference_count(self, *, project_id: int, user_id: int, task_key: str) -> int:
        key = _canonical_fence_key(project_id=project_id, user_id=user_id, task_key=task_key)
        with self._registry_lock:
            entry = self._entries.get(key)
            return 0 if entry is None else entry.references


@dataclass(frozen=True)
class ProjectMutationBinding:
    """The shared fence and finalizer for one managed Label Studio project."""

    project_id: int
    fence: DraftTransitionFence
    finalizer: Any


class ProjectMutationBindingRegistry:
    """Optional process-local bindings, deliberately separate from runtime_registry."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._bindings: dict[int, ProjectMutationBinding] = {}

    def register(
        self,
        *,
        project_id: int,
        fence: DraftTransitionFence,
        finalizer: Any,
    ) -> ProjectMutationBinding:
        project_id = _positive_integer(project_id, field='project_id')
        if not isinstance(fence, DraftTransitionFence):
            raise DraftTransitionFenceError('fence must be a DraftTransitionFence')
        if getattr(finalizer, 'fence', None) is not fence:
            raise DraftTransitionFenceError('finalizer must use the identical transition fence')
        for method in ('preflight_draft_result', 'finalize_inserted'):
            if not callable(getattr(finalizer, method, None)):
                raise DraftTransitionFenceError(f'finalizer must provide {method}()')
        binding = ProjectMutationBinding(project_id=project_id, fence=fence, finalizer=finalizer)
        with self._lock:
            prior = self._bindings.get(project_id)
            if prior is not None:
                if prior.fence is not fence or prior.finalizer is not finalizer:
                    raise DraftTransitionFenceError('project already has a different mutation binding')
                return prior
            self._bindings[project_id] = binding
        return binding

    def get(self, project_id: int) -> ProjectMutationBinding | None:
        project_id = _positive_integer(project_id, field='project_id')
        with self._lock:
            return self._bindings.get(project_id)

    def unregister(
        self,
        project_id: int,
        *,
        expected: ProjectMutationBinding | None = None,
    ) -> None:
        project_id = _positive_integer(project_id, field='project_id')
        with self._lock:
            prior = self._bindings.get(project_id)
            if prior is None:
                return
            if expected is not None and prior is not expected:
                raise DraftTransitionFenceError('project mutation binding identity changed')
            del self._bindings[project_id]


def _canonical_fence_key(*, project_id: int, user_id: int, task_key: str) -> tuple[int, int, str]:
    return (
        _positive_integer(project_id, field='project_id'),
        _positive_integer(user_id, field='user_id'),
        _normalized_text(task_key, field='task_key'),
    )


def _positive_integer(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DraftTransitionFenceError(f'{field} must be a positive integer')
    return value


def _normalized_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise DraftTransitionFenceError(f'{field} must be non-empty normalized text')
    return value


draft_transition_fence = DraftTransitionFence()
project_mutation_bindings = ProjectMutationBindingRegistry()


__all__ = [
    'DraftTransitionFence',
    'DraftTransitionFenceError',
    'ProjectMutationBinding',
    'ProjectMutationBindingRegistry',
    'draft_transition_fence',
    'project_mutation_bindings',
]

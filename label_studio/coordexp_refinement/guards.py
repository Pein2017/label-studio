"""Write guards for CoordExp-managed refinement projects.

Managed projects deliberately keep one authoritative annotation.  Native
Label Studio annotation submission endpoints would otherwise create, replace,
delete, skip, or convert that entity outside the Draft plus dataset-Commit
workflow.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.response import Response

PROJECT_MARKER_PREFIX = "coordexp-refinement-project-identity:"

_CONFLICT_PAYLOAD = {
    "error": {
        "code": "managed_annotation_write_blocked",
        "message": (
            "Managed refinement projects allow Draft edits only; use the "
            "refinement Commit action to publish dataset changes."
        ),
    }
}

_PROJECT_CONFLICT_PAYLOAD = {
    "error": {
        "code": "managed_project_write_blocked",
        "message": (
            "Managed refinement projects are immutable outside Draft edits and "
            "the refinement Commit workflow."
        ),
    }
}

# The registered Data Manager action surface is fail-closed.  This is the only
# current action that selects a task without mutating Task, Annotation, Draft,
# Prediction, TaskLock, project summary, or storage state.  Both native call
# sites explicitly disable lock acquisition for managed projects.
MANAGED_READ_ONLY_ACTIONS = frozenset({"next_task"})


class ManagedAnnotationWriteConflict(APIException):
    """Signal a native Annotation write attempted against a managed project."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = (
        "Native annotation writes are disabled for this managed refinement project."
    )
    default_code = "managed_annotation_write_blocked"


class ManagedProjectWriteConflict(APIException):
    """Signal an out-of-band managed project/entity mutation."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = (
        "Native project, task, annotation, and prediction mutations are disabled "
        "for this managed refinement project."
    )
    default_code = "managed_project_write_blocked"


class ManagedAnnotationWriteGuardMixin:
    """Render managed-write conflicts without Label Studio's variable error ID."""

    def handle_exception(self, exc: Exception) -> Response:
        if isinstance(exc, ManagedProjectWriteConflict):
            return Response(
                {
                    "error": {
                        "code": _PROJECT_CONFLICT_PAYLOAD["error"]["code"],
                        "message": _PROJECT_CONFLICT_PAYLOAD["error"]["message"],
                    }
                },
                status=status.HTTP_409_CONFLICT,
            )
        if isinstance(exc, ManagedAnnotationWriteConflict):
            return Response(
                {
                    "error": {
                        "code": _CONFLICT_PAYLOAD["error"]["code"],
                        "message": _CONFLICT_PAYLOAD["error"]["message"],
                    }
                },
                status=status.HTTP_409_CONFLICT,
            )
        return super().handle_exception(exc)


def is_managed_refinement_project(project: Any) -> bool:
    """Return whether ``project`` carries the exact managed identity prefix."""

    description = getattr(project, "description", None)
    return isinstance(description, str) and description.startswith(
        PROJECT_MARKER_PREFIX
    )


def reject_managed_annotation_write(project: Any) -> None:
    """Reject native Annotation entity mutations for a managed project."""

    if is_managed_refinement_project(project):
        raise ManagedAnnotationWriteConflict()


def reject_managed_project_write(project: Any) -> None:
    """Reject any mutation outside the managed Draft/Commit boundary."""

    if is_managed_refinement_project(project):
        raise ManagedProjectWriteConflict()


def reject_reserved_managed_project_identity(description: Any) -> None:
    """Forbid native APIs from minting the bootstrap-owned project marker."""

    if isinstance(description, str) and description.startswith(PROJECT_MARKER_PREFIX):
        raise ManagedProjectWriteConflict()


def reject_managed_data_manager_action(
    action_id: Any,
    project: Any,
    queryset: Any,
) -> None:
    """Fail closed for every non-read-only action touching a managed scope."""

    # Defend the centralized execution boundary as well as its normal HTTP
    # caller: no action may target a queryset outside its addressed project.
    try:
        project_ids = set(
            queryset.order_by().values_list("project_id", flat=True).distinct()
        )
    except (AttributeError, TypeError, ValueError):
        raise ManagedProjectWriteConflict() from None
    if project_ids and project_ids != {getattr(project, "pk", None)}:
        raise ManagedProjectWriteConflict()

    if action_id in MANAGED_READ_ONLY_ACTIONS:
        return
    reject_managed_project_write(project)


def reject_managed_annotation_entity_write(annotation: Any) -> None:
    """Fail closed if either side of an Annotation/project binding is managed."""

    reject_managed_annotation_write(annotation.task.project)
    reject_managed_annotation_write(annotation.project)


def reject_managed_prediction_entity_write(prediction: Any) -> None:
    """Fail closed if either side of a Prediction/project binding is managed."""

    reject_managed_project_write(prediction.task.project)
    reject_managed_project_write(prediction.project)

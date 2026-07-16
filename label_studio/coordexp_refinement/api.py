"""Authenticated same-origin HTTP seam for asynchronous dataset Commit."""

from __future__ import annotations

import logging
import math
import re
from functools import wraps
from typing import Any
from uuid import UUID

from core.middleware import enforce_csrf_checks
from django.http import JsonResponse
from django.middleware.csrf import CsrfViewMiddleware, get_token
from django.utils.decorators import method_decorator
from projects.models import Project
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from src.label_studio_coco_refinement.runtime import (
    AuthenticatedPrincipal,
    AuthenticationError,
    BatchStatusReceipt,
    DraftCatalogError,
)
from src.label_studio_coco_refinement.store import (
    BatchStatus,
    CommitConflictError,
    ManifestDriftError,
    RecoveryError,
    StaleCommitError,
    StoreBusyError,
    StoreError,
    ValidationError,
)

from .catalog import DraftLifecycleConflict
from .registry import ProjectRuntimeBinding, RuntimeBindingError, runtime_registry
from .roi_finalization import DjangoRoiFinalizationError
from .roi_services import RoiReceiptConflictError, RoiServicesError
from .roi_targets import DjangoRoiTargetError

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES = frozenset({BatchStatus.QUEUED.value, BatchStatus.RUNNING.value, BatchStatus.RECONCILING.value})
_TERMINAL_STATUSES = frozenset({BatchStatus.SUCCEEDED.value, BatchStatus.FAILED.value})
_ALL_STATUSES = _ACTIVE_STATUSES | _TERMINAL_STATUSES | {BatchStatus.NOT_FOUND.value}
_ROI_INFER_FIELDS = frozenset({'request_id', 'task_id', 'roi', 'resolution', 'profile_selector'})
_ROI_ABANDON_REASONS = frozenset({'user_cancelled', 'user_discarded', 'superseded'})
_SAFE_SELECTOR = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
_RECEIPT_ID = re.compile(r'roi-receipt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')


class _JsonCsrfViewMiddleware(CsrfViewMiddleware):
    def _reject(self, request, reason):
        return JsonResponse(
            {'error': {'code': 'csrf_failed', 'message': 'CSRF validation failed.'}},
            status=403,
            headers={'Cache-Control': 'no-store'},
        )


def json_csrf_protect(view):
    """Run Django's CSRF check before DRF while retaining the JSON contract.

    Label Studio's ``DisableCSRF`` middleware normally exempts API callbacks.
    The outer marker prevents its global CSRF middleware from returning the
    stock HTML failure page; this wrapper then runs the same Django check with
    enforcement restored and returns a stable no-store JSON rejection.
    """

    enforced_view = enforce_csrf_checks(view)

    @wraps(enforced_view)
    def protected(request, *args, **kwargs):
        prior = getattr(request, '_dont_enforce_csrf_checks', None)
        prior_done = getattr(request, 'csrf_processing_done', None)
        request._dont_enforce_csrf_checks = False
        request.csrf_processing_done = False
        try:
            rejection = _JsonCsrfViewMiddleware(lambda _: None).process_view(request, _csrf_target, args, kwargs)
        finally:
            if prior is None:
                delattr(request, '_dont_enforce_csrf_checks')
            else:
                request._dont_enforce_csrf_checks = prior
            if prior_done is None:
                delattr(request, 'csrf_processing_done')
            else:
                request.csrf_processing_done = prior_done
        if rejection is not None:
            return rejection
        return enforced_view(request, *args, **kwargs)

    protected._dont_enforce_csrf_checks = True
    return protected


def _csrf_target(request, *args, **kwargs):
    """Non-exempt callback used only for Django's process_view CSRF check."""

    return None


class _NoStoreAPIView(APIView):
    permission_classes = (IsAuthenticated,)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store'
        return response

    def _binding(self, request, pk: int) -> tuple[ProjectRuntimeBinding | None, Response | None]:
        if not Project.objects.for_user(request.user).filter(pk=pk).only('pk').exists():
            return None, _error('project_not_found', 'Project not found.', 404)
        try:
            return runtime_registry.resolve(pk), None
        except RuntimeBindingError:
            return None, _error(
                'refinement_unavailable',
                'Refinement runtime is unavailable for this project.',
                503,
            )

    @staticmethod
    def _roi_services(binding: ProjectRuntimeBinding) -> tuple[Any | None, Response | None]:
        if binding.services is None:
            return None, _error(
                'refinement_unavailable',
                'ROI refinement is unavailable for this project.',
                503,
            )
        return binding.services, None


class _JsonBodyAPIView(_NoStoreAPIView):
    parser_classes = (JSONParser,)

    def handle_exception(self, exc):
        if isinstance(exc, (ParseError, UnsupportedMediaType)):
            return _error('invalid_request', 'Body must be valid JSON.', 400)
        return super().handle_exception(exc)


@method_decorator(enforce_csrf_checks, name='dispatch')
class RefinementCommitAPI(_NoStoreAPIView):
    """Capture current-user Drafts and return after durable enqueue."""

    parser_classes = (JSONParser,)
    http_method_names = ('post',)

    def handle_exception(self, exc):
        if isinstance(exc, (ParseError, UnsupportedMediaType)):
            return _error('invalid_request', 'Body must be valid JSON.', 400)
        return super().handle_exception(exc)

    def post(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        batch_id, failure = _parse_batch_body(request.data)
        if failure is not None:
            return failure
        assert binding is not None and batch_id is not None
        try:
            receipt = binding.runtime.capture_and_enqueue(
                split=binding.split,
                batch_id=batch_id,
                principal=AuthenticatedPrincipal(str(request.user.pk), True),
            )
            payload = _safe_commit_receipt(receipt, requested_batch_id=batch_id, split=binding.split)
        except AuthenticationError:
            return _error('authentication_failed', 'Authentication is required.', 403)
        except (DraftCatalogError, ValidationError, StaleCommitError):
            return _error('invalid_commit', 'The current Draft batch cannot be committed.', 400)
        except CommitConflictError:
            return _error('batch_conflict', 'The batch ID conflicts with an existing batch.', 409)
        except StoreBusyError:
            return _error('batch_busy', 'The split is busy or reconciling.', 409)
        except (ManifestDriftError, RecoveryError):
            return _error('refinement_unavailable', 'Refinement state requires recovery.', 503)
        except StoreError:
            return _error('refinement_unavailable', 'Refinement runtime is unavailable.', 503)
        except Exception:
            logger.exception('Unexpected CoordExp refinement Commit failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'Refinement runtime is unavailable.', 503)
        return Response(payload, status=202 if receipt.status in _ACTIVE_STATUSES else 200)


class RefinementStatusAPI(_NoStoreAPIView):
    """Resolve an idempotent batch ID without recapturing mutable Drafts."""

    http_method_names = ('get',)

    def get(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        batch_id, failure = _parse_batch_query(request.query_params)
        if failure is not None:
            return failure
        assert binding is not None and batch_id is not None
        try:
            receipt = binding.runtime.batch_status(split=binding.split, batch_id=batch_id)
            payload = _safe_receipt(receipt, batch_id=batch_id, split=binding.split)
        except StoreBusyError:
            return _error('batch_busy', 'The split is busy or reconciling.', 409)
        except (ManifestDriftError, RecoveryError):
            return _error('refinement_unavailable', 'Refinement state requires recovery.', 503)
        except ValidationError:
            return _error('invalid_batch_id', 'batch_id must be a canonical UUID.', 400)
        except StoreError:
            return _error('refinement_unavailable', 'Refinement runtime is unavailable.', 503)
        except Exception:
            logger.exception('Unexpected CoordExp refinement status failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'Refinement runtime is unavailable.', 503)
        return Response(payload, status=200)


class RefinementSessionAPI(_NoStoreAPIView):
    """Issue Django's masked CSRF token for the registered project origin."""

    http_method_names = ('get',)

    def get(self, request, pk: int) -> Response:
        _, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        return Response({'csrf_token': get_token(request)}, status=200)


class RoiProfilesAPI(_NoStoreAPIView):
    """Return only the launch manager's browser-safe profile projection."""

    http_method_names = ('get',)

    def get(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        assert binding is not None
        services, failure = self._roi_services(binding)
        if failure is not None:
            return failure
        try:
            with services.request_admission():
                profiles = list(services.safe_profiles())
            return Response({'profiles': profiles}, status=200)
        except Exception:
            logger.exception('Unexpected CoordExp ROI profile failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'ROI refinement is unavailable.', 503)


class RoiInferAPI(_JsonBodyAPIView):
    """Infer from one Label Studio percent-xywh ROI on the source image."""

    http_method_names = ('post',)

    def post(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        body, failure = _parse_roi_infer_body(request.data)
        if failure is not None:
            return failure
        assert binding is not None and body is not None
        services, failure = self._roi_services(binding)
        if failure is not None:
            return failure
        try:
            with services.request_admission():
                with services.inference_lifecycle(
                    request_id=body['request_id'],
                    expected_project_pk=pk,
                    expected_split=binding.split,
                    expected_user_pk=request.user.pk,
                ) as active:
                    captured = services.targets.capture(
                        user=request.user,
                        project_pk=pk,
                        task_pk=body['task_id'],
                        request_id=body['request_id'],
                        roi=body['roi'],
                        resolution=body['resolution'],
                        profile_selector=body['profile_selector'],
                    )
                    with captured:
                        cancellation_token = services.bind_inference_target(active, captured.target)
                        response = services.manager.infer(
                            selector=body['profile_selector'],
                            image=captured.image,
                            target=captured.target,
                            transform=captured.transform,
                            cancellation_token=cancellation_token,
                        )
                payload = services.safe_infer_response(response)
        except DjangoRoiTargetError:
            return _error('invalid_roi_target', 'The ROI target is no longer valid.', 409)
        except RoiServicesError:
            return _error('refinement_unavailable', 'ROI inference is unavailable.', 503)
        except Exception:
            logger.exception('Unexpected CoordExp ROI inference failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'ROI inference is unavailable.', 503)
        return Response(payload, status=200)


class RoiAbandonAPI(_JsonBodyAPIView):
    """Fence and permanently abandon one produced ROI receipt."""

    http_method_names = ('post',)

    def post(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        body, failure = _parse_roi_abandon_body(request.data)
        if failure is not None:
            return failure
        assert binding is not None and body is not None
        services, failure = self._roi_services(binding)
        if failure is not None:
            return failure
        try:
            with services.request_admission():
                payload = services.abandon(
                    user=request.user,
                    receipt_id=body['receipt_id'],
                    reason=body['reason'],
                    expected_project_pk=pk,
                    expected_split=binding.split,
                )
        except (DjangoRoiFinalizationError, RoiReceiptConflictError):
            return _error('receipt_conflict', 'The ROI receipt cannot be abandoned.', 409)
        except RoiServicesError:
            return _error('refinement_unavailable', 'ROI refinement is unavailable.', 503)
        except Exception:
            logger.exception('Unexpected CoordExp ROI abandonment failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'ROI refinement is unavailable.', 503)
        return Response(payload, status=200)


class RefinementProjectStateAPI(_NoStoreAPIView):
    """Read the authoritative managed Draft/batch overlay without enqueueing."""

    http_method_names = ('get',)

    def get(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        assert binding is not None
        services, failure = self._roi_services(binding)
        if failure is not None:
            return failure
        try:
            with services.request_admission():
                payload = services.project_state(
                    project_pk=pk,
                    split=binding.split,
                    user_pk=request.user.pk,
                )
        except Exception:
            logger.exception('Unexpected CoordExp project state failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'Refinement state is unavailable.', 503)
        return Response(payload, status=200)


class RefinementTaskLifecycleAPI(_JsonBodyAPIView):
    """Resolve committed task state and perform exact-token Draft reset/CAS."""

    http_method_names = ('post',)

    def post(self, request, pk: int) -> Response:
        binding, failure = self._binding(request, pk)
        if failure is not None:
            return failure
        body, failure = _parse_task_lifecycle_body(request.data)
        if failure is not None:
            return failure
        assert binding is not None and body is not None
        services, failure = self._roi_services(binding)
        if failure is not None:
            return failure
        try:
            with services.request_admission():
                payload = services.draft_catalog.current_task_lifecycle(
                    split=binding.split,
                    principal=AuthenticatedPrincipal(str(request.user.pk), True),
                    task_pk=body['task_id'],
                    action=body['action'],
                    expected_draft=body['expected_draft'],
                )
        except DraftLifecycleConflict:
            return _error('draft_token_conflict', 'The persisted Draft changed before reset.', 409)
        except (DraftCatalogError, ValidationError):
            return _error('invalid_task_lifecycle', 'The current task lifecycle request is invalid.', 400)
        except (ManifestDriftError, RecoveryError, StoreBusyError):
            return _error('refinement_unavailable', 'Refinement state requires recovery.', 503)
        except Exception:
            logger.exception('Unexpected CoordExp task lifecycle failure for project_id=%s', pk)
            return _error('refinement_unavailable', 'Refinement state is unavailable.', 503)
        return Response(payload, status=200)


def _parse_batch_body(data: Any) -> tuple[str | None, Response | None]:
    if not isinstance(data, dict) or set(data) != {'batch_id'}:
        return None, _error('invalid_request', 'Body must contain only batch_id.', 400)
    return _parse_batch_id(data['batch_id'])


def _parse_task_lifecycle_body(data: Any) -> tuple[dict[str, Any] | None, Response | None]:
    if not isinstance(data, dict) or set(data) != {'action', 'task_id', 'expected_draft'}:
        return None, _error('invalid_request', 'Body has an unsupported task lifecycle shape.', 400)
    action = data['action']
    if action not in {'inspect', 'reconcile', 'discard'}:
        return None, _error('invalid_action', 'action is invalid.', 400)
    task_id = data['task_id']
    if isinstance(task_id, bool) or not isinstance(task_id, int) or task_id <= 0:
        return None, _error('invalid_task_id', 'task_id must be a positive integer.', 400)
    expected = data['expected_draft']
    if not isinstance(expected, dict) or set(expected) != {
        'draft_id',
        'draft_updated_at',
        'draft_semantic_hash',
    }:
        return None, _error('invalid_draft_token', 'expected_draft has an unsupported shape.', 400)
    draft_id = expected['draft_id']
    if isinstance(draft_id, bool) or not isinstance(draft_id, int) or draft_id <= 0:
        return None, _error('invalid_draft_token', 'expected Draft id must be a positive integer.', 400)
    revision = expected['draft_updated_at']
    semantic = expected['draft_semantic_hash']
    if not isinstance(revision, str) or not revision:
        return None, _error('invalid_draft_token', 'expected Draft revision is invalid.', 400)
    if not isinstance(semantic, str) or re.fullmatch(r'[0-9a-f]{64}', semantic) is None:
        return None, _error('invalid_draft_token', 'expected Draft semantic hash is invalid.', 400)
    return {
        'action': action,
        'task_id': task_id,
        'expected_draft': {
            'draft_id': draft_id,
            'draft_updated_at': revision,
            'draft_semantic_hash': semantic,
        },
    }, None


def _parse_roi_infer_body(data: Any) -> tuple[dict[str, Any] | None, Response | None]:
    if not isinstance(data, dict) or set(data) != _ROI_INFER_FIELDS:
        return None, _error('invalid_request', 'Body has an unsupported ROI inference shape.', 400)
    request_id, failure = _parse_batch_id(data['request_id'])
    if failure is not None:
        return None, _error('invalid_request_id', 'request_id must be a canonical UUID.', 400)
    task_id = data['task_id']
    if isinstance(task_id, bool) or not isinstance(task_id, int) or task_id <= 0:
        return None, _error('invalid_task_id', 'task_id must be a positive integer.', 400)
    roi = data['roi']
    if not isinstance(roi, dict) or set(roi) != {'x', 'y', 'width', 'height'}:
        return None, _error('invalid_roi', 'roi must contain x, y, width, and height.', 400)
    if any(not _finite_number(roi[field]) for field in ('x', 'y', 'width', 'height')):
        return None, _error('invalid_roi', 'roi values must be finite numbers.', 400)
    resolution = data['resolution']
    if not isinstance(resolution, dict) or set(resolution) != {'width', 'height'}:
        return None, _error('invalid_resolution', 'resolution must contain width and height.', 400)
    if any(
        isinstance(resolution[field], bool) or not isinstance(resolution[field], int) or resolution[field] <= 0
        for field in ('width', 'height')
    ):
        return None, _error('invalid_resolution', 'resolution values must be positive integers.', 400)
    selector = data['profile_selector']
    if not isinstance(selector, str) or _SAFE_SELECTOR.fullmatch(selector) is None:
        return None, _error('invalid_profile_selector', 'profile_selector is invalid.', 400)
    return {
        'request_id': request_id,
        'task_id': task_id,
        'roi': dict(roi),
        'resolution': dict(resolution),
        'profile_selector': selector,
    }, None


def _parse_roi_abandon_body(data: Any) -> tuple[dict[str, str] | None, Response | None]:
    if not isinstance(data, dict) or set(data) != {'receipt_id', 'reason'}:
        return None, _error('invalid_request', 'Body must contain only receipt_id and reason.', 400)
    receipt_id = data['receipt_id']
    if not isinstance(receipt_id, str) or _RECEIPT_ID.fullmatch(receipt_id) is None:
        return None, _error('invalid_receipt_id', 'receipt_id is invalid.', 400)
    reason = data['reason']
    if reason not in _ROI_ABANDON_REASONS:
        return None, _error('invalid_reason', 'reason is invalid.', 400)
    return {'receipt_id': receipt_id, 'reason': reason}, None


def _finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _parse_batch_query(data: Any) -> tuple[str | None, Response | None]:
    if set(data) != {'batch_id'}:
        return None, _error('invalid_request', 'Query must contain only batch_id.', 400)
    values = data.getlist('batch_id') if hasattr(data, 'getlist') else [data.get('batch_id')]
    if len(values) != 1:
        return None, _error('invalid_request', 'Query must contain one batch_id.', 400)
    return _parse_batch_id(values[0])


def _parse_batch_id(value: Any) -> tuple[str | None, Response | None]:
    if not isinstance(value, str):
        return None, _error('invalid_batch_id', 'batch_id must be a canonical UUID.', 400)
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        return None, _error('invalid_batch_id', 'batch_id must be a canonical UUID.', 400)
    if str(parsed) != value:
        return None, _error('invalid_batch_id', 'batch_id must be a canonical UUID.', 400)
    return value, None


def _safe_receipt(receipt: Any, *, batch_id: str, split: str) -> dict[str, Any]:
    if not isinstance(receipt, BatchStatusReceipt):
        raise TypeError('runtime returned an invalid receipt')
    if receipt.batch_id != batch_id or receipt.status not in _ALL_STATUSES:
        raise ValueError('runtime returned a mismatched receipt')
    if receipt.status == BatchStatus.NOT_FOUND.value:
        if receipt.split is not None:
            raise ValueError('not-found receipt unexpectedly names a split')
    elif receipt.split != split:
        raise ValueError('runtime returned a cross-split receipt')
    error = None
    if receipt.error is not None:
        error = (
            'Batch processing failed.'
            if receipt.status == BatchStatus.FAILED.value
            else 'Batch requires reconciliation.'
        )
    return {
        'base_generation': receipt.base_generation,
        'batch_id': receipt.batch_id,
        'error': error,
        'generation': receipt.generation,
        'member_count': receipt.member_count,
        'payload_hash': receipt.payload_hash,
        'split': receipt.split,
        'status': receipt.status,
    }


def _safe_commit_receipt(receipt: Any, *, requested_batch_id: str, split: str) -> dict[str, Any]:
    """Allow Commit admission to report an already-active same-split batch.

    The store returns the existing active receipt when a split already owns a
    queued/running/reconciling batch.  That receipt may legitimately name a
    different canonical UUID from the new request.  No other receipt identity
    substitution is accepted, and status lookups continue to use
    :func:`_safe_receipt` directly.
    """

    if not isinstance(receipt, BatchStatusReceipt):
        raise TypeError('runtime returned an invalid receipt')
    if receipt.batch_id == requested_batch_id:
        return _safe_receipt(receipt, batch_id=requested_batch_id, split=split)
    if not _is_canonical_batch_id(receipt.batch_id):
        raise ValueError('runtime returned a non-canonical active batch ID')
    if receipt.status not in _ACTIVE_STATUSES:
        raise ValueError('runtime substituted a non-active batch receipt')
    if receipt.split != split:
        raise ValueError('runtime returned a cross-split active batch receipt')
    return _safe_receipt(receipt, batch_id=receipt.batch_id, split=split)


def _is_canonical_batch_id(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        return False
    return str(parsed) == value


def _error(code: str, message: str, status: int) -> Response:
    return Response({'error': {'code': code, 'message': message}}, status=status)


__all__ = [
    'RefinementCommitAPI',
    'RefinementProjectStateAPI',
    'RefinementSessionAPI',
    'RefinementStatusAPI',
    'RefinementTaskLifecycleAPI',
    'RoiAbandonAPI',
    'RoiInferAPI',
    'RoiProfilesAPI',
    'json_csrf_protect',
]

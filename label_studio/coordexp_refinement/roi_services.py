"""Shared in-process ROI services for registered refinement projects."""

from __future__ import annotations

import json
import math
import re
import threading
import time
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from src.label_studio_coco_refinement.geometry import (
    norm1000_bbox_to_label_studio_xywh,
)
from src.label_studio_coco_refinement.runtime import AuthenticatedPrincipal

from .roi_targets import (
    DjangoRoiTargetCatalog,
    ResolvedRoiProfile,
)


class RoiServicesError(RuntimeError):
    """The shared ROI service graph is incomplete or returned unsafe data."""


class RoiReceiptConflictError(RoiServicesError):
    """A receipt does not belong to the routed project/split authority."""


_SAFE_TOKEN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}\Z')
_RECEIPT_ID = re.compile(r'roi-receipt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
_PENDING_ABANDON_TTL_SECONDS = 60.0
_PENDING_ABANDON_CAPACITY = 1024
_SAFE_NO_INSERTION_TERMINALS = {
    'empty',
    'all_rejected',
    'response_failure',
    'profile_failure',
    'transport_failure',
    'runtime_failure',
    'timeout_failure',
    'cancelled',
    'abandoned_before_insertion',
}
_PROFILE_FIELDS = {
    'selector',
    'display_label',
    'default_canvas',
    'processor_factor',
    'bounds',
    'generation_deadline_seconds',
}
_PROJECT_STATE_FIELDS = {
    'generation',
    'pending_draft_count',
    'members',
    'active_batch_id',
    'batch_state',
    'active_batch',
    'last_terminal_batch',
}


class DeferredCurrentTargetProvider:
    """Break the launch-manager/target-catalog cycle with one strict bind."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._target: Any | None = None

    def bind(self, target: Any) -> None:
        if not callable(getattr(target, 'current_target', None)):
            raise RoiServicesError('current target provider must provide current_target()')
        with self._lock:
            if self._target is not None:
                raise RoiServicesError('current target provider is already bound')
            self._target = target

    def current_target(self, frozen: Any) -> Any:
        with self._lock:
            target = self._target
        if target is None:
            raise RoiServicesError('current target provider is not bound')
        return target.current_target(frozen)

    @property
    def bound_target(self) -> Any | None:
        with self._lock:
            return self._target


@dataclass
class _ActiveRoiInference:
    request_id: str
    project_pk: int
    split: str
    user_pk: int
    target: Any | None = None
    token: Any | None = None
    abandon_reason: str | None = None
    completed: bool = False


@dataclass(frozen=True)
class _PendingRoiAbandonment:
    request_id: str
    project_pk: int
    split: str
    user_pk: int
    reason: str
    recorded_at: float


class RoiLaunchProfileResolver:
    """Adapt the parent launch manager's INTERNAL profile contract."""

    def __init__(self, manager: Any) -> None:
        for method in ('resolve_selected_profile', 'current_profile'):
            if not callable(getattr(manager, method, None)):
                raise RoiServicesError(f'ROI launch manager must provide {method}()')
        self.manager = manager

    def resolve_selected(self, *, project_id: str, selector: str) -> ResolvedRoiProfile:
        return _resolved_profile(
            self.manager.resolve_selected_profile(
                project_id=project_id,
                selector=selector,
            )
        )

    def current(self, *, project_id: str) -> ResolvedRoiProfile:
        return _resolved_profile(self.manager.current_profile(project_id=project_id))


@dataclass
class RoiProjectServices:
    """One identity-checked ROI graph shared by every split binding."""

    manager: Any
    targets: DjangoRoiTargetCatalog
    finalizer: Any
    receipt_store: Any
    draft_catalog: Any
    stores: Mapping[str, Any]
    profile_resolver: RoiLaunchProfileResolver
    _state_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _state_versions: dict[tuple[int, int], tuple[str, int]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _admission: threading.Condition = field(
        default_factory=lambda: threading.Condition(threading.Lock()),
        init=False,
        repr=False,
    )
    _closing: bool = field(default=False, init=False, repr=False)
    _active_requests: int = field(default=0, init=False, repr=False)
    _inference_lifecycle: threading.Condition = field(
        default_factory=lambda: threading.Condition(threading.Lock()),
        init=False,
        repr=False,
    )
    _active_inference: dict[str, _ActiveRoiInference] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _pending_abandonments: dict[str, _PendingRoiAbandonment] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _pending_saturated_until: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self) -> None:
        if getattr(self.manager, 'receipt_store', None) is not self.receipt_store:
            raise RoiServicesError('manager must own the shared receipt store')
        if getattr(self.manager, 'inference_receipt_resolver', None) is not self.receipt_store:
            raise RoiServicesError('manager receipt resolver identity differs')
        if getattr(self.finalizer, 'receipt_store', None) is not self.receipt_store:
            raise RoiServicesError('finalizer must use the shared receipt store')
        if self.profile_resolver.manager is not self.manager:
            raise RoiServicesError('profile resolver must use the shared launch manager')
        if not isinstance(self.targets, DjangoRoiTargetCatalog):
            raise RoiServicesError('targets must be a Django ROI target catalog')
        if not isinstance(self.stores, Mapping) or set(self.stores) != {'train', 'val'}:
            raise RoiServicesError('ROI services require train and val stores')
        for method in ('profile_options', 'infer', 'close', 'new_cancellation_token'):
            if not callable(getattr(self.manager, method, None)):
                raise RoiServicesError(f'ROI launch manager must provide {method}()')
        for method in ('finalize_abandoned',):
            if not callable(getattr(self.finalizer, method, None)):
                raise RoiServicesError(f'ROI finalizer must provide {method}()')

    def safe_profiles(self) -> tuple[dict[str, Any], ...]:
        value = self.manager.profile_options()
        if not isinstance(value, tuple) or any(not isinstance(item, dict) for item in value):
            raise RoiServicesError('ROI profile projection is invalid')
        profiles = tuple(_ordinary_json(item) for item in value)
        selectors: set[str] = set()
        for profile in profiles:
            _validate_profile_option(profile)
            selector = profile['selector']
            if selector in selectors:
                raise RoiServicesError('ROI profile selectors must be unique')
            selectors.add(selector)
        return profiles

    @contextmanager
    def request_admission(self):
        """Reject new HTTP work after closing and drain admitted requests."""

        with self._admission:
            if self._closing:
                raise RoiServicesError('ROI services are closing')
            self._active_requests += 1
        try:
            yield
        finally:
            with self._admission:
                self._active_requests -= 1
                self._admission.notify_all()

    def close_admission(self) -> None:
        with self._admission:
            self._closing = True
            while self._active_requests:
                self._admission.wait()

    def safe_infer_response(self, response: Any) -> dict[str, Any]:
        if not isinstance(response, Mapping):
            raise RoiServicesError('ROI inference returned an invalid response')
        payload = _ordinary_json(response)
        _validate_infer_response(payload)
        return payload

    def expire_orphan_receipts(self) -> tuple[str, ...]:
        """Delegate overdue decisions to the DB/fence-owning finalizer."""

        expire = getattr(self.finalizer, 'reconcile_expired', None)
        if not callable(expire):
            raise RoiServicesError('ROI receipt reconciliation authority is unavailable')
        expired = expire()
        if not isinstance(expired, tuple) or any(
            not isinstance(receipt_id, str) or _RECEIPT_ID.fullmatch(receipt_id) is None
            for receipt_id in expired
        ):
            raise RoiServicesError('ROI receipt expiry returned invalid identities')
        return expired

    @contextmanager
    def inference_lifecycle(
        self,
        *,
        request_id: str,
        expected_project_pk: int,
        expected_split: str,
        expected_user_pk: int,
    ):
        """Reserve the authenticated route before target capture begins."""

        _canonical_uuid(request_id, field='ROI request id')
        _positive_int(expected_project_pk, field='expected project id')
        _positive_int(expected_user_pk, field='expected user id')
        if expected_split not in {'train', 'val'}:
            raise RoiServicesError('ROI request split is invalid')
        active = _ActiveRoiInference(
            request_id=request_id,
            project_pk=expected_project_pk,
            split=expected_split,
            user_pk=expected_user_pk,
        )
        with self._inference_lifecycle:
            now = time.monotonic()
            self._prune_pending_abandonments_locked(now)
            if request_id in self._active_inference:
                raise RoiServicesError('ROI request is already active')
            pending = self._pending_abandonments.get(request_id)
            if pending is not None:
                if (
                    pending.project_pk != expected_project_pk
                    or pending.split != expected_split
                    or pending.user_pk != expected_user_pk
                ):
                    raise RoiReceiptConflictError('pending ROI abandonment route conflicts')
                active.abandon_reason = pending.reason
                del self._pending_abandonments[request_id]
            elif now < self._pending_saturated_until:
                raise RoiReceiptConflictError('pending ROI abandonment admission is saturated')
            self._active_inference[request_id] = active
        try:
            yield active
        finally:
            with self._inference_lifecycle:
                active.completed = True
                if self._active_inference.get(request_id) is active:
                    del self._active_inference[request_id]
                self._inference_lifecycle.notify_all()

    def bind_inference_target(self, active: _ActiveRoiInference, target: Any) -> Any:
        """Bind the exact server-frozen target and apply any earlier abandon."""

        with self._inference_lifecycle:
            if (
                self._active_inference.get(active.request_id) is not active
                or active.completed
                or active.target is not None
            ):
                raise RoiServicesError('ROI request reservation is not bindable')
            _validate_active_target(
                target=target,
                request_id=active.request_id,
                expected_project_pk=active.project_pk,
                expected_split=active.split,
                expected_user_pk=active.user_pk,
            )
            token = self.manager.new_cancellation_token()
            if not callable(getattr(token, 'cancel', None)):
                raise RoiServicesError('ROI manager returned an invalid cancellation token')
            active.target = target
            active.token = token
            if active.abandon_reason is not None:
                token.cancel(active.abandon_reason)
            return token

    def abandon(
        self,
        *,
        user: Any,
        receipt_id: str,
        reason: str,
        expected_project_pk: int,
        expected_split: str,
    ) -> dict[str, Any]:
        request_id = receipt_id.removeprefix('roi-receipt:')
        with self._inference_lifecycle:
            now = time.monotonic()
            self._prune_pending_abandonments_locked(now)
            active = self._active_inference.get(request_id)
            if active is not None:
                if (
                    active.project_pk != expected_project_pk
                    or active.split != expected_split
                    or active.user_pk != user.pk
                ):
                    raise RoiReceiptConflictError('active ROI target route does not match')
                if active.abandon_reason is not None and active.abandon_reason != reason:
                    raise RoiReceiptConflictError('active ROI abandonment reason conflicts')
                active.abandon_reason = reason
                self._inference_lifecycle.notify_all()
                if active.token is not None:
                    active.token.cancel(reason)
                while not active.completed:
                    self._inference_lifecycle.wait()
            elif self.receipt_store.get(receipt_id) is None:
                self._remember_pending_abandonment_locked(
                    request_id=request_id,
                    project_pk=expected_project_pk,
                    split=expected_split,
                    user_pk=user.pk,
                    reason=reason,
                    recorded_at=now,
                )
                raise RoiReceiptConflictError('ROI receipt is pending inference registration')
        _validate_receipt_route(
            receipt_store=self.receipt_store,
            receipt_id=receipt_id,
            expected_project_pk=expected_project_pk,
            expected_split=expected_split,
            expected_user_pk=user.pk,
        )
        response = self.receipt_store.response(receipt_id)
        if not isinstance(response, Mapping):
            raise RoiServicesError('ROI abandonment returned no durable response')
        payload = _ordinary_json(response)
        _validate_infer_response(payload)
        if payload['request_state'] in _SAFE_NO_INSERTION_TERMINALS:
            if (
                payload['request_state'] == 'abandoned_before_insertion'
                and payload['failure']['code'] != reason
            ):
                raise RoiReceiptConflictError('ROI abandonment reason conflicts')
            return payload
        if payload['request_state'] != 'produced' or payload['terminal_status'] is not None:
            raise RoiReceiptConflictError('ROI receipt is already inserted or not abandonable')
        finalized_id = self.finalizer.finalize_abandoned(
            user=user,
            receipt_id_or_request_id=receipt_id,
            reason=reason,
        )
        if finalized_id != receipt_id:
            raise RoiServicesError('ROI finalizer returned a mismatched receipt')
        terminal_response = self.receipt_store.response(receipt_id)
        if not isinstance(terminal_response, Mapping):
            raise RoiServicesError('ROI abandonment returned no durable response')
        terminal_payload = _ordinary_json(terminal_response)
        _validate_infer_response(terminal_payload)
        return terminal_payload

    def _prune_pending_abandonments_locked(self, now: float) -> None:
        expired = [
            request_id
            for request_id, pending in self._pending_abandonments.items()
            if now - pending.recorded_at >= _PENDING_ABANDON_TTL_SECONDS
        ]
        for request_id in expired:
            del self._pending_abandonments[request_id]

    def _remember_pending_abandonment_locked(
        self,
        *,
        request_id: str,
        project_pk: int,
        split: str,
        user_pk: int,
        reason: str,
        recorded_at: float,
    ) -> None:
        _canonical_uuid(request_id, field='ROI request id')
        _positive_int(project_pk, field='expected project id')
        _positive_int(user_pk, field='expected user id')
        if split not in {'train', 'val'}:
            raise RoiReceiptConflictError('pending ROI abandonment split is invalid')
        prior = self._pending_abandonments.get(request_id)
        if prior is not None:
            if (
                prior.project_pk != project_pk
                or prior.split != split
                or prior.user_pk != user_pk
                or prior.reason != reason
            ):
                raise RoiReceiptConflictError('pending ROI abandonment conflicts')
            return
        if len(self._pending_abandonments) >= _PENDING_ABANDON_CAPACITY:
            self._pending_saturated_until = max(
                self._pending_saturated_until,
                recorded_at + _PENDING_ABANDON_TTL_SECONDS,
            )
            raise RoiReceiptConflictError('pending ROI abandonment capacity is full')
        self._pending_abandonments[request_id] = _PendingRoiAbandonment(
            request_id=request_id,
            project_pk=project_pk,
            split=split,
            user_pk=user_pk,
            reason=reason,
            recorded_at=recorded_at,
        )

    def project_state(
        self,
        *,
        project_pk: int,
        split: str,
        user_pk: int,
    ) -> dict[str, Any]:
        state = self.draft_catalog.project_state(
            split=split,
            principal=AuthenticatedPrincipal(str(user_pk), True),
        )
        if not isinstance(state, Mapping):
            raise RoiServicesError('Draft catalog returned an invalid project state')
        payload = _ordinary_json(state)
        _validate_project_state(payload)
        fingerprint = json.dumps(payload, ensure_ascii=True, separators=(',', ':'), sort_keys=True)
        key = (project_pk, user_pk)
        with self._state_lock:
            prior = self._state_versions.get(key)
            version = 0 if prior is None else prior[1]
            if prior is not None and prior[0] != fingerprint:
                version += 1
            self._state_versions[key] = (fingerprint, version)
        return {'version': version, **payload}


def _resolved_profile(value: Any) -> ResolvedRoiProfile:
    try:
        return ResolvedRoiProfile(
            fingerprint=value.fingerprint,
            processor_factor=value.processor_factor,
            default_width=value.default_width,
            default_height=value.default_height,
            min_axis_pixels=value.min_axis_pixels,
            max_axis_pixels=value.max_axis_pixels,
            max_total_pixels=value.max_total_pixels,
            deadline_seconds=value.deadline_seconds,
        )
    except Exception as exc:
        raise RoiServicesError('ROI launch manager returned an invalid profile binding') from exc


def _validate_profile_option(value: Any) -> None:
    _exact_keys(value, _PROFILE_FIELDS, field='ROI profile option')
    selector = value['selector']
    if not isinstance(selector, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', selector) is None:
        raise RoiServicesError('ROI profile selector is invalid')
    if value['display_label'] != selector:
        raise RoiServicesError('ROI profile display label must equal its selector')
    canvas = value['default_canvas']
    _exact_keys(canvas, {'width', 'height'}, field='ROI default canvas')
    width = _positive_int(canvas['width'], field='ROI default width')
    height = _positive_int(canvas['height'], field='ROI default height')
    factor = _positive_int(value['processor_factor'], field='ROI processor factor')
    bounds = value['bounds']
    _exact_keys(
        bounds,
        {'min_axis_pixels', 'max_axis_pixels', 'max_total_pixels'},
        field='ROI profile bounds',
    )
    minimum = _positive_int(bounds['min_axis_pixels'], field='ROI minimum axis')
    maximum = _positive_int(bounds['max_axis_pixels'], field='ROI maximum axis')
    total = _positive_int(bounds['max_total_pixels'], field='ROI maximum pixels')
    deadline = value['generation_deadline_seconds']
    if (
        isinstance(deadline, bool)
        or not isinstance(deadline, (int, float))
        or not math.isfinite(deadline)
        or deadline <= 0
    ):
        raise RoiServicesError('ROI profile deadline is invalid')
    if (
        minimum > maximum
        or width % factor
        or height % factor
        or not (minimum <= width <= maximum and minimum <= height <= maximum)
        or width * height > total
    ):
        raise RoiServicesError('ROI profile default canvas is inconsistent')


def _validate_infer_response(value: Any) -> None:
    base_fields = {
        'receipt_id',
        'request_id',
        'request_state',
        'terminal_status',
        'clear_roi',
        'insertion_payload',
        'failure',
    }
    if not isinstance(value, dict):
        raise RoiServicesError('ROI response must be a JSON object')
    request_id = _canonical_uuid(value.get('request_id'), field='ROI response request_id')
    if value.get('receipt_id') != f'roi-receipt:{request_id}':
        raise RoiServicesError('ROI response receipt identity is invalid')
    state = value.get('request_state')
    if state not in {
        'produced',
        'empty',
        'all_rejected',
        'response_failure',
        'cancelled',
        'profile_failure',
        'transport_failure',
        'runtime_failure',
        'timeout_failure',
        'abandoned_before_insertion',
        'accepted',
        'accepted_with_drops',
    }:
        raise RoiServicesError('ROI response state is invalid')
    terminal = value.get('terminal_status')
    if terminal != (None if state == 'produced' else state):
        raise RoiServicesError('ROI response terminal status is inconsistent')
    if not isinstance(value.get('clear_roi'), bool):
        raise RoiServicesError('ROI response clear_roi must be boolean')

    if state in {'accepted', 'accepted_with_drops'}:
        _exact_keys(
            value,
            base_fields | {'counts', 'result_region_keys', 'insertion_attestation'},
            field='inserted ROI response',
        )
        _validate_counts(value['counts'], inserted=True)
        _validate_string_map(value['result_region_keys'], field='ROI result-region keys')
        _validate_insertion_attestation(value['insertion_attestation'])
        if value['insertion_payload'] is not None or value['failure'] is not None or value['clear_roi'] is not True:
            raise RoiServicesError('inserted ROI response shape is inconsistent')
        return

    if 'counts' in value:
        _exact_keys(value, base_fields | {'counts'}, field='ROI result response')
        inserted_counts = state == 'abandoned_before_insertion'
        _validate_counts(value['counts'], inserted=inserted_counts)
        if state == 'produced':
            _validate_insertion_payload(value['insertion_payload'], request_id=request_id)
            if len(value['insertion_payload']['regions']) != value['counts']['produced']:
                raise RoiServicesError('produced ROI count differs from insertion regions')
            if value['failure'] is not None or value['clear_roi'] is not False:
                raise RoiServicesError('produced ROI response shape is inconsistent')
        elif inserted_counts:
            _validate_failure(value['failure'])
            if value['insertion_payload'] is not None or value['clear_roi'] is not False:
                raise RoiServicesError('abandoned ROI response shape is inconsistent')
        elif value['insertion_payload'] is not None or value['failure'] is not None:
            raise RoiServicesError('terminal ROI result response shape is inconsistent')
        elif value['clear_roi'] is not (state in {'empty', 'all_rejected'}):
            raise RoiServicesError('terminal ROI clear flag is inconsistent')
        return

    _exact_keys(value, base_fields, field='ROI failure response')
    if state in {'produced', 'empty', 'all_rejected', 'response_failure', 'accepted', 'accepted_with_drops'}:
        raise RoiServicesError('ROI result response is missing counts')
    _validate_failure(value['failure'])
    if value['insertion_payload'] is not None or value['clear_roi'] is not False:
        raise RoiServicesError('ROI failure response shape is inconsistent')


def _validate_counts(value: Any, *, inserted: bool) -> None:
    fields = {'parsed', 'inserted', 'rejected'} if inserted else {'parsed', 'produced', 'rejected'}
    _exact_keys(value, fields, field='ROI response counts')
    for key in fields:
        _nonnegative_int(value[key], field=f'ROI count {key}')


def _validate_failure(value: Any) -> None:
    _exact_keys(value, {'stage', 'code'}, field='ROI failure')
    for key in ('stage', 'code'):
        item = value[key]
        if not isinstance(item, str) or _SAFE_TOKEN.fullmatch(item) is None:
            raise RoiServicesError('ROI failure identity is invalid')


def _validate_insertion_payload(value: Any, *, request_id: str) -> None:
    _exact_keys(value, {'target', 'mode', 'regions'}, field='ROI insertion payload')
    if value['mode'] != 'append_one_undo_action':
        raise RoiServicesError('ROI insertion mode is invalid')
    target = value['target']
    _exact_keys(
        target,
        {
            'request_id',
            'project_id',
            'task_id',
            'task_epoch',
            'image_id',
            'annotation_id',
            'annotation_revision',
            'current_user_id',
            'draft_id',
            'draft_revision',
            'profile_fingerprint',
            'project_generation',
            'transform_fingerprint',
            'preexisting_draft_dirty',
        },
        field='ROI insertion target',
    )
    if target['request_id'] != request_id:
        raise RoiServicesError('ROI insertion request identity differs')
    for key in (
        'project_id',
        'task_id',
        'task_epoch',
        'image_id',
        'annotation_id',
        'annotation_revision',
        'current_user_id',
        'draft_id',
        'draft_revision',
        'transform_fingerprint',
    ):
        _nonempty_text(target[key], field=f'ROI target {key}')
    _sha256(target['profile_fingerprint'], field='ROI target profile fingerprint')
    _nonnegative_int(target['project_generation'], field='ROI target generation')
    if not isinstance(target['preexisting_draft_dirty'], bool):
        raise RoiServicesError('ROI target dirty flag is invalid')
    regions = value['regions']
    if not isinstance(regions, list) or not regions:
        raise RoiServicesError('ROI insertion regions must be non-empty')
    seen: set[str] = set()
    for region in regions:
        _validate_insertion_region(region, request_id=request_id)
        result_id = region['result_id']
        if result_id in seen:
            raise RoiServicesError('ROI insertion result IDs must be unique')
        seen.add(result_id)


def _validate_insertion_region(value: Any, *, request_id: str) -> None:
    _exact_keys(
        value,
        {
            'result_id',
            'category_name',
            'category_id',
            'bbox_2d',
            'request_id',
            'parser_object_span_id',
            'source_draft_revision',
            'region_key',
            'label_studio_result',
        },
        field='ROI insertion region',
    )
    if value['request_id'] != request_id:
        raise RoiServicesError('ROI insertion region request identity differs')
    for key in ('result_id', 'category_name', 'parser_object_span_id', 'source_draft_revision', 'region_key'):
        _nonempty_text(value[key], field=f'ROI insertion region {key}')
    _positive_int(value['category_id'], field='ROI category id')
    bbox = value['bbox_2d']
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) for item in bbox)
        or not (0 <= bbox[0] < bbox[2] <= 999 and 0 <= bbox[1] < bbox[3] <= 999)
    ):
        raise RoiServicesError('ROI insertion bbox is invalid')
    _validate_label_studio_result(
        value['label_studio_result'],
        region_key=value['region_key'],
        request_id=request_id,
        result_id=value['result_id'],
        category_name=value['category_name'],
        source_draft_revision=value['source_draft_revision'],
        bbox=bbox,
    )


def _validate_label_studio_result(
    value: Any,
    *,
    region_key: str,
    request_id: str,
    result_id: str,
    category_name: str,
    source_draft_revision: str,
    bbox: list[int],
) -> None:
    _exact_keys(
        value,
        {
            'id',
            'type',
            'from_name',
            'to_name',
            'original_width',
            'original_height',
            'image_rotation',
            'value',
            'meta',
        },
        field='Label Studio ROI result',
    )
    if (
        value['id'] != region_key
        or value['type'] != 'rectanglelabels'
        or value['from_name'] != 'bbox'
        or value['to_name'] != 'image'
        or value['image_rotation'] != 0
    ):
        raise RoiServicesError('Label Studio ROI result identity is invalid')
    _positive_int(value['original_width'], field='Label Studio result width')
    _positive_int(value['original_height'], field='Label Studio result height')
    rectangle = value['value']
    _exact_keys(rectangle, {'x', 'y', 'width', 'height', 'rotation', 'rectanglelabels'}, field='ROI rectangle')
    if rectangle['rotation'] != 0:
        raise RoiServicesError('ROI rectangle rotation is invalid')
    observed_rectangle = tuple(
        _finite_number(rectangle[field], field=f'ROI rectangle {field}') for field in ('x', 'y', 'width', 'height')
    )
    expected_rectangle = norm1000_bbox_to_label_studio_xywh(bbox)
    if not all(
        math.isclose(observed, expected, rel_tol=0.0, abs_tol=1e-9)
        for observed, expected in zip(observed_rectangle, expected_rectangle, strict=True)
    ):
        raise RoiServicesError('ROI rectangle does not match its normalized bbox')
    labels = rectangle['rectanglelabels']
    if labels != [category_name]:
        raise RoiServicesError('ROI rectangle labels are invalid')
    meta = value['meta']
    _exact_keys(
        meta,
        {
            'coordexp_region_key',
            'coordexp_inference_receipt_id',
            'coordexp_inference_request_id',
            'coordexp_inference_result_id',
            'coordexp_inference_source_draft_revision',
        },
        field='ROI result metadata',
    )
    expected_meta = {
        'coordexp_region_key': region_key,
        'coordexp_inference_receipt_id': f'roi-receipt:{request_id}',
        'coordexp_inference_request_id': request_id,
        'coordexp_inference_result_id': result_id,
        'coordexp_inference_source_draft_revision': source_draft_revision,
    }
    if meta != expected_meta:
        raise RoiServicesError('ROI result metadata identity differs')


def _validate_insertion_attestation(value: Any) -> None:
    fields = {
        'source_annotation_revision',
        'observed_annotation_revision',
        'source_draft_revision',
        'inserted_draft_revision',
        'inserted_draft_updated_at',
        'saved_full_result_sha256',
        'saved_semantic_result_sha256',
    }
    _exact_keys(value, fields, field='ROI insertion attestation')
    for key in fields - {'saved_full_result_sha256', 'saved_semantic_result_sha256'}:
        _nonempty_text(value[key], field=f'ROI attestation {key}')
    _sha256(value['saved_full_result_sha256'], field='ROI full result hash')
    _sha256(value['saved_semantic_result_sha256'], field='ROI semantic result hash')


def _validate_project_state(value: Any) -> None:
    _exact_keys(value, _PROJECT_STATE_FIELDS, field='managed project state')
    _nonnegative_int(value['generation'], field='project generation')
    pending_count = _nonnegative_int(value['pending_draft_count'], field='pending Draft count')
    members = value['members']
    if not isinstance(members, list):
        raise RoiServicesError('project state members must be a list')
    pending_observed = 0
    task_ids: set[int] = set()
    task_keys: set[str] = set()
    for member in members:
        _validate_project_member(member)
        if member['task_id'] in task_ids:
            raise RoiServicesError('project state task IDs must be unique')
        task_ids.add(member['task_id'])
        if member['task_key'] in task_keys:
            raise RoiServicesError('project state task keys must be unique')
        task_keys.add(member['task_key'])
        pending_observed += int(member['pending'])
    if pending_observed != pending_count:
        raise RoiServicesError('project pending Draft count is inconsistent')
    active = value['active_batch']
    if active is None:
        if value['active_batch_id'] is not None or value['batch_state'] is not None:
            raise RoiServicesError('project active batch legacy fields are inconsistent')
        if any(member['active_batch_member'] for member in members):
            raise RoiServicesError('project members reference a missing active batch')
    else:
        _validate_batch_projection(active, terminal=False)
        if value['active_batch_id'] != active['batch_id'] or value['batch_state'] != active['state']:
            raise RoiServicesError('project active batch legacy fields differ')
        active_member_task_keys = {member['task_key'] for member in members if member['active_batch_member']}
        if active['member_count'] != len(active_member_task_keys):
            raise RoiServicesError('project member active-batch membership differs')
    terminal = value['last_terminal_batch']
    if terminal is not None:
        _validate_batch_projection(terminal, terminal=True)
        terminal_member_task_keys = sorted(
            member['task_key'] for member in members if member['last_terminal_batch_member']
        )
        if terminal['member_task_keys'] != terminal_member_task_keys:
            raise RoiServicesError('project member terminal-batch membership differs')
    elif any(member['last_terminal_batch_member'] for member in members):
        raise RoiServicesError('project members reference a missing terminal batch')


def _validate_project_member(value: Any) -> None:
    _exact_keys(
        value,
        {
            'task_id',
            'task_key',
            'draft_id',
            'draft_updated_at',
            'draft_semantic_hash',
            'committed_semantic_hash',
            'pending',
            'draft_ahead_of_committed',
            'active_batch_member',
            'active_batch_semantic_hash',
            'draft_ahead_of_active_batch',
            'last_terminal_batch_member',
            'last_terminal_batch_semantic_hash',
            'draft_matches_last_terminal_batch',
        },
        field='project state member',
    )
    _positive_int(value['task_id'], field='project member task_id')
    _positive_int(value['draft_id'], field='project member draft_id')
    _nonempty_text(value['task_key'], field='project member task_key')
    _nonempty_text(value['draft_updated_at'], field='project member revision')
    _sha256(value['draft_semantic_hash'], field='project member Draft hash')
    _sha256(value['committed_semantic_hash'], field='project member committed hash')
    for key in (
        'pending',
        'draft_ahead_of_committed',
        'active_batch_member',
        'draft_ahead_of_active_batch',
        'last_terminal_batch_member',
        'draft_matches_last_terminal_batch',
    ):
        if not isinstance(value[key], bool):
            raise RoiServicesError(f'project member {key} must be boolean')
    if value['pending'] != value['draft_ahead_of_committed']:
        raise RoiServicesError('project member committed-ahead flags differ')
    active_hash = value['active_batch_semantic_hash']
    if value['active_batch_member']:
        _sha256(active_hash, field='project member active batch hash')
        expected_ahead = value['draft_semantic_hash'] != active_hash
        if value['draft_ahead_of_active_batch'] != expected_ahead:
            raise RoiServicesError('project member active-batch ahead flag differs')
    elif active_hash is not None or value['draft_ahead_of_active_batch']:
        raise RoiServicesError('unrelated project member carries active batch state')
    terminal_hash = value['last_terminal_batch_semantic_hash']
    if value['last_terminal_batch_member']:
        _sha256(terminal_hash, field='project member terminal batch hash')
        expected_match = value['draft_semantic_hash'] == terminal_hash
        if value['draft_matches_last_terminal_batch'] != expected_match:
            raise RoiServicesError('project member terminal-batch match flag differs')
    elif terminal_hash is not None or value['draft_matches_last_terminal_batch']:
        raise RoiServicesError('unrelated project member carries terminal batch state')


def _validate_batch_projection(value: Any, *, terminal: bool) -> None:
    fields = {'batch_id', 'state', 'member_count', 'base_generation', 'payload_hash'}
    if terminal:
        fields |= {'generation', 'error', 'member_task_keys'}
    _exact_keys(value, fields, field='batch projection')
    _canonical_uuid(value['batch_id'], field='batch id')
    allowed_states = {'succeeded', 'failed'} if terminal else {'queued', 'running', 'reconciling'}
    if value['state'] not in allowed_states:
        raise RoiServicesError('batch projection state is invalid')
    _positive_int(value['member_count'], field='batch member count')
    _nonnegative_int(value['base_generation'], field='batch base generation')
    _sha256(value['payload_hash'], field='batch payload hash')
    if terminal:
        member_task_keys = value['member_task_keys']
        if (
            not isinstance(member_task_keys, list)
            or len(member_task_keys) != value['member_count']
            or member_task_keys != sorted(set(member_task_keys))
        ):
            raise RoiServicesError('terminal batch member task keys are invalid')
        for task_key in member_task_keys:
            _nonempty_text(task_key, field='terminal batch member task key')
        _nonnegative_int(value['generation'], field='batch generation')
        if value['state'] == 'failed':
            if value['error'] != 'Batch processing failed.':
                raise RoiServicesError('failed batch error is not canonical')
        elif value['error'] is not None:
            raise RoiServicesError('successful batch unexpectedly has an error')


def _validate_receipt_route(
    *,
    receipt_store: Any,
    receipt_id: str,
    expected_project_pk: int,
    expected_split: str,
    expected_user_pk: int,
) -> None:
    _positive_int(expected_project_pk, field='expected project id')
    _positive_int(expected_user_pk, field='expected user id')
    if expected_split not in {'train', 'val'}:
        raise RoiReceiptConflictError('receipt route split is invalid')
    record = receipt_store.get(receipt_id)
    if not isinstance(record, Mapping):
        raise RoiReceiptConflictError('ROI receipt is unknown')
    try:
        if (
            record.get('record_kind') != 'attempt'
            or record.get('receipt_id') != receipt_id
            or record.get('attempt', {}).get('request_state')
            not in {'produced', *_SAFE_NO_INSERTION_TERMINALS}
        ):
            raise RoiReceiptConflictError('ROI receipt is not abandonable')
        target = record['attempt']['request']
        if (
            not isinstance(target, Mapping)
            or target.get('project_id') != str(expected_project_pk)
            or target.get('current_user_id') != str(expected_user_pk)
            or not isinstance(target.get('task_id'), str)
            or not target['task_id'].startswith(f'{expected_split}:')
        ):
            raise RoiReceiptConflictError('ROI receipt route does not match the project')
    except RoiReceiptConflictError:
        raise
    except Exception as exc:
        raise RoiReceiptConflictError('ROI receipt route is malformed') from exc


def _validate_active_target(
    *,
    target: Any,
    request_id: str,
    expected_project_pk: int,
    expected_split: str,
    expected_user_pk: int,
) -> None:
    _positive_int(expected_project_pk, field='expected project id')
    _positive_int(expected_user_pk, field='expected user id')
    if expected_split not in {'train', 'val'}:
        raise RoiReceiptConflictError('active ROI split is invalid')
    if (
        getattr(target, 'request_id', None) != request_id
        or getattr(target, 'project_id', None) != str(expected_project_pk)
        or getattr(target, 'current_user_id', None) != str(expected_user_pk)
        or not isinstance(getattr(target, 'task_id', None), str)
        or not target.task_id.startswith(f'{expected_split}:')
    ):
        raise RoiReceiptConflictError('active ROI target route does not match')


def _exact_keys(value: Any, expected: set[str], *, field: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise RoiServicesError(f'{field} fields are invalid')


def _positive_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RoiServicesError(f'{field} must be a positive integer')
    return value


def _nonnegative_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RoiServicesError(f'{field} must be a non-negative integer')
    return value


def _finite_number(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RoiServicesError(f'{field} must be finite')
    return float(value)


def _nonempty_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise RoiServicesError(f'{field} must be non-empty normalized text')
    return value


def _sha256(value: Any, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in '0123456789abcdef' for character in value)
    ):
        raise RoiServicesError(f'{field} must be a lowercase SHA-256')
    return value


def _canonical_uuid(value: Any, *, field: str) -> str:
    if not isinstance(value, str):
        raise RoiServicesError(f'{field} must be a canonical UUID')
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise RoiServicesError(f'{field} must be a canonical UUID') from exc
    if str(parsed) != value:
        raise RoiServicesError(f'{field} must be a canonical UUID')
    return value


def _validate_string_map(value: Any, *, field: str) -> None:
    if not isinstance(value, dict) or not value:
        raise RoiServicesError(f'{field} must be a non-empty object')
    for key, item in value.items():
        _nonempty_text(key, field=field)
        _nonempty_text(item, field=field)


def _ordinary_json(value: Any) -> Any:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(',', ':'),
            sort_keys=True,
        )
        copied = json.loads(encoded)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RoiServicesError('ROI response must be finite ordinary JSON') from exc
    _reject_private_keys(copied)
    return copied


def _reject_private_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = key.casefold().replace('-', '_')
            if normalized in {
                'path',
                'endpoint',
                'authorization',
                'cookie',
                'password',
                'secret',
                'api_key',
            } or normalized.endswith(('_path', '_token', '_secret', '_password', '_api_key')):
                raise RoiServicesError('ROI response contains a private field')
            _reject_private_keys(item)
    elif isinstance(value, list):
        for item in value:
            _reject_private_keys(item)


__all__ = [
    'DeferredCurrentTargetProvider',
    'RoiLaunchProfileResolver',
    'RoiProjectServices',
    'RoiReceiptConflictError',
    'RoiServicesError',
]

from __future__ import annotations

import copy
from contextlib import nullcontext
from threading import Event, Thread
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import coordexp_refinement.roi_services as roi_services_module
from coordexp_refinement.catalog import DraftCatalogError, _store_project_state
from coordexp_refinement.roi_services import (
    DeferredCurrentTargetProvider,
    RoiLaunchProfileResolver,
    RoiProjectServices,
    RoiReceiptConflictError,
    RoiServicesError,
)
from coordexp_refinement.roi_targets import DjangoRoiTargetCatalog
from django.test import SimpleTestCase
from src.label_studio_coco_refinement.geometry import (
    norm1000_bbox_to_label_studio_xywh,
)
from src.label_studio_coco_refinement.inference_results import RequestTarget


class _ReceiptStore:
    def __init__(self) -> None:
        self.records = {}
        self.dispositions = {}

    def resolve(self, receipt_id):
        del receipt_id
        return None

    def get(self, receipt_id):
        return copy.deepcopy(self.records.get(receipt_id))

    def disposition(self, receipt_id):
        return copy.deepcopy(self.dispositions.get(receipt_id))

    def response(self, receipt_id):
        return copy.deepcopy(self.records[receipt_id]['response'])


class _FakeCancellationToken:
    def __init__(self) -> None:
        self.requested = False
        self.reason = None

    def cancel(self, reason):
        if not self.requested:
            self.requested = True
            self.reason = reason


class _Manager:
    def __init__(self) -> None:
        self.receipt_store = _ReceiptStore()
        self.inference_receipt_resolver = self.receipt_store

    def resolve_selected_profile(self, **kwargs):
        del kwargs
        return _profile()

    def current_profile(self, **kwargs):
        del kwargs
        return _profile()

    def profile_options(self):
        return (_profile_option(),)

    def infer(self, **kwargs):
        del kwargs
        return _empty_response()

    @staticmethod
    def new_cancellation_token():
        return _FakeCancellationToken()

    def close(self):
        return None


class _Catalog:
    def __init__(self) -> None:
        self.state = {
            'generation': 2,
            'pending_draft_count': 0,
            'members': [],
            'active_batch_id': None,
            'batch_state': None,
            'active_batch': None,
            'last_terminal_batch': None,
        }

    def project_state(self, **kwargs):
        del kwargs
        return dict(self.state)


class DeferredCurrentTargetProviderTest(SimpleTestCase):
    def test_bind_once_and_unbound_lookup_fail_closed(self) -> None:
        provider = DeferredCurrentTargetProvider()
        with self.assertRaisesRegex(RoiServicesError, 'not bound'):
            provider.current_target('frozen')
        target = SimpleNamespace(current_target=lambda frozen: ('current', frozen))
        provider.bind(target)
        self.assertIs(provider.bound_target, target)
        self.assertEqual(provider.current_target('frozen'), ('current', 'frozen'))
        with self.assertRaisesRegex(RoiServicesError, 'already bound'):
            provider.bind(target)

    def test_profile_resolver_preserves_only_internal_profile_fields(self) -> None:
        manager = _Manager()
        resolver = RoiLaunchProfileResolver(manager)

        selected = resolver.resolve_selected(project_id='7', selector='safe')
        current = resolver.current(project_id='7')

        self.assertEqual(selected, current)
        self.assertEqual(selected.fingerprint, 'a' * 64)
        self.assertFalse(hasattr(selected, 'endpoint'))
        self.assertFalse(hasattr(selected, 'path'))

    def test_services_enforce_receipt_identity_and_monotonic_state_version(self) -> None:
        manager = _Manager()
        resolver = RoiLaunchProfileResolver(manager)
        targets = object.__new__(DjangoRoiTargetCatalog)
        finalizer = SimpleNamespace(
            receipt_store=manager.receipt_store,
            finalize_abandoned=lambda **kwargs: kwargs['receipt_id_or_request_id'],
        )
        catalog = _Catalog()
        services = RoiProjectServices(
            manager=manager,
            targets=targets,
            finalizer=finalizer,
            receipt_store=manager.receipt_store,
            draft_catalog=catalog,
            stores={'train': object(), 'val': object()},
            profile_resolver=resolver,
        )

        first = services.project_state(project_pk=7, split='train', user_pk=3)
        retry = services.project_state(project_pk=7, split='train', user_pk=3)
        catalog.state['generation'] = 3
        changed = services.project_state(project_pk=7, split='train', user_pk=3)

        self.assertEqual(first['version'], 0)
        self.assertEqual(retry['version'], 0)
        self.assertEqual(changed['version'], 1)
        self.assertIs(services.receipt_store, manager.receipt_store)
        self.assertIs(services.finalizer.receipt_store, manager.receipt_store)
        services.close_admission()
        with self.assertRaisesRegex(RoiServicesError, 'closing'):
            with services.request_admission():
                self.fail('closing services admitted a request')

    def test_safe_response_rejects_paths_credentials_and_nonfinite_json(self) -> None:
        manager = _Manager()
        services = RoiProjectServices(
            manager=manager,
            targets=object.__new__(DjangoRoiTargetCatalog),
            finalizer=SimpleNamespace(
                receipt_store=manager.receipt_store,
                finalize_abandoned=lambda **kwargs: kwargs['receipt_id_or_request_id'],
            ),
            receipt_store=manager.receipt_store,
            draft_catalog=_Catalog(),
            stores={'train': object(), 'val': object()},
            profile_resolver=RoiLaunchProfileResolver(manager),
        )
        for payload in (
            {'checkpoint_path': '/private/model'},
            {'access_token': 'secret'},
            {'value': float('nan')},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(RoiServicesError):
                    services.safe_infer_response(payload)

    def test_safe_profiles_require_exact_nested_schema_and_types(self) -> None:
        services = _services()
        self.assertEqual(services.safe_profiles(), (_profile_option(),))
        mutations = (
            lambda value: value.update(extra=True),
            lambda value: value.pop('bounds'),
            lambda value: value['default_canvas'].update(width=True),
            lambda value: value['bounds'].update(max_total_pixels=2_097_152.0),
            lambda value: value.update(generation_deadline_seconds=float('inf')),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                option = _profile_option()
                mutate(option)
                services.manager.profile_options = lambda option=option: (option,)
                with self.assertRaises(RoiServicesError):
                    services.safe_profiles()

    def test_safe_infer_response_requires_exact_nested_schema_and_types(self) -> None:
        services = _services()
        valid = _produced_response()
        self.assertEqual(services.safe_infer_response(valid), valid)
        mutations = (
            lambda value: value.update(extra=True),
            lambda value: value['counts'].update(produced=True),
            lambda value: value['insertion_payload']['target'].pop('task_epoch'),
            lambda value: value['insertion_payload']['regions'][0].update(category_id='1'),
            lambda value: value['insertion_payload']['regions'][0]['label_studio_result']['value'].update(
                rotation='0'
            ),
            lambda value: value['insertion_payload']['regions'][0]['label_studio_result']['meta'].update(
                private_extra='no'
            ),
            lambda value: value['insertion_payload']['regions'][0]['label_studio_result']['meta'].update(
                coordexp_inference_request_id=123
            ),
            lambda value: value.update(clear_roi=True),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                payload = copy.deepcopy(valid)
                mutate(payload)
                with self.assertRaises(RoiServicesError):
                    services.safe_infer_response(payload)

    def test_safe_infer_response_accepts_parent_norm1000_geometry_golden_cases(self) -> None:
        services = _services()
        cases = (
            (
                (100, 200, 300, 400),
                (10000 / 999, 20000 / 999, 30000 / 999 - 10000 / 999, 40000 / 999 - 20000 / 999),
            ),
            (
                (568, 4, 717, 153),
                (56800 / 999, 400 / 999, 71700 / 999 - 56800 / 999, 15300 / 999 - 400 / 999),
            ),
            ((0, 0, 999, 999), (0.0, 0.0, 100.0, 100.0)),
        )

        for bbox, expected in cases:
            with self.subTest(bbox=bbox):
                self.assertEqual(norm1000_bbox_to_label_studio_xywh(bbox), expected)
                payload = _produced_response(bbox=bbox)
                rectangle = payload['insertion_payload']['regions'][0]['label_studio_result']['value']
                self.assertEqual(
                    tuple(rectangle[field] for field in ('x', 'y', 'width', 'height')),
                    expected,
                )
                self.assertEqual(services.safe_infer_response(payload), payload)

    def test_safe_infer_response_rejects_legacy_divide_by_ten_geometry(self) -> None:
        services = _services()
        payload = _produced_response(bbox=(100, 200, 300, 400))
        payload['insertion_payload']['regions'][0]['label_studio_result']['value'].update(
            x=10.0,
            y=20.0,
            width=20.0,
            height=20.0,
        )

        with self.assertRaisesRegex(RoiServicesError, 'normalized bbox'):
            services.safe_infer_response(payload)

    def test_project_state_requires_exact_active_terminal_and_member_schema(self) -> None:
        services = _services()
        valid = _project_state()
        services.draft_catalog.state = copy.deepcopy(valid)
        self.assertEqual(services.project_state(project_pk=7, split='train', user_pk=3)['generation'], 9)
        mutations = (
            lambda value: value.update(extra=True),
            lambda value: value['members'][0].pop('task_key'),
            lambda value: value['members'][0].update(pending=1),
            lambda value: value['members'][0].update(draft_matches_last_terminal_batch=False),
            lambda value: value['active_batch'].update(state='succeeded'),
            lambda value: value['last_terminal_batch'].update(error='private detail'),
            lambda value: value['last_terminal_batch'].update(member_task_keys=['train:43', 'train:41']),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                payload = copy.deepcopy(valid)
                mutate(payload)
                services.draft_catalog.state = payload
                with self.assertRaises(RoiServicesError):
                    services.project_state(project_pk=7, split='train', user_pk=3)

    def test_project_state_rejects_active_batch_member_count_mismatch(self) -> None:
        services = _services()
        state = _project_state()
        state['active_batch']['member_count'] = 2
        services.draft_catalog.state = state

        with self.assertRaisesRegex(RoiServicesError, 'active-batch membership differs'):
            services.project_state(project_pk=7, split='train', user_pk=3)

    def test_project_state_rejects_ghost_terminal_batch_task_key(self) -> None:
        services = _services()
        state = _project_state()
        terminal_only_member = state['members'][1]
        terminal_only_member.update(
            last_terminal_batch_member=False,
            last_terminal_batch_semantic_hash=None,
            draft_matches_last_terminal_batch=False,
        )
        state['last_terminal_batch']['member_task_keys'] = ['train:41', 'train:44']
        services.draft_catalog.state = state

        with self.assertRaisesRegex(RoiServicesError, 'terminal-batch membership differs'):
            services.project_state(project_pk=7, split='train', user_pk=3)

    def test_project_state_rejects_duplicate_member_task_key(self) -> None:
        services = _services()
        state = _project_state()
        state['members'][1]['task_key'] = 'train:41'
        services.draft_catalog.state = state

        with self.assertRaisesRegex(RoiServicesError, 'task keys must be unique'):
            services.project_state(project_pk=7, split='train', user_pk=3)

    def test_project_state_preserves_differing_active_and_terminal_memberships(self) -> None:
        services = _services()
        state = _project_state()
        active_member, terminal_member = state['members']
        active_member.update(
            last_terminal_batch_member=False,
            last_terminal_batch_semantic_hash=None,
            draft_matches_last_terminal_batch=False,
        )
        terminal_member.update(
            active_batch_member=False,
            active_batch_semantic_hash=None,
            draft_ahead_of_active_batch=False,
        )
        state['last_terminal_batch'].update(member_count=1, member_task_keys=['train:43'])
        services.draft_catalog.state = state

        projected = services.project_state(project_pk=7, split='train', user_pk=3)

        self.assertNotEqual(projected['active_batch']['batch_id'], projected['last_terminal_batch']['batch_id'])
        self.assertTrue(projected['members'][0]['active_batch_member'])
        self.assertFalse(projected['members'][0]['last_terminal_batch_member'])
        self.assertFalse(projected['members'][1]['active_batch_member'])
        self.assertTrue(projected['members'][1]['last_terminal_batch_member'])

    def test_terminal_project_state_survives_reload_and_versions_only_on_change(self) -> None:
        services = _services()
        services.draft_catalog.state = _project_state()
        first = services.project_state(project_pk=7, split='train', user_pk=3)
        reloaded = services.project_state(project_pk=7, split='train', user_pk=3)
        services.draft_catalog.state['last_terminal_batch']['generation'] = 10
        changed = services.project_state(project_pk=7, split='train', user_pk=3)

        self.assertEqual(first['last_terminal_batch']['state'], 'failed')
        self.assertEqual(reloaded['last_terminal_batch'], first['last_terminal_batch'])
        self.assertEqual((first['version'], reloaded['version'], changed['version']), (0, 0, 1))

    def test_project_state_distinguishes_committed_and_active_batch_ahead_flags(self) -> None:
        services = _services()
        state = _project_state()
        active_member = state['members'][0]
        active_member.update(
            draft_semantic_hash='b' * 64,
            committed_semantic_hash='b' * 64,
            pending=False,
            draft_ahead_of_committed=False,
            active_batch_semantic_hash='c' * 64,
            draft_ahead_of_active_batch=True,
            draft_matches_last_terminal_batch=False,
        )
        state['members'].append(
            {
                'task_id': 15,
                'task_key': 'train:42',
                'draft_id': 16,
                'draft_updated_at': '2026-07-15T00:00:01.000000Z',
                'draft_semantic_hash': 'f' * 64,
                'committed_semantic_hash': 'f' * 64,
                'pending': False,
                'draft_ahead_of_committed': False,
                'active_batch_member': False,
                'active_batch_semantic_hash': None,
                'draft_ahead_of_active_batch': False,
                'last_terminal_batch_member': False,
                'last_terminal_batch_semantic_hash': None,
                'draft_matches_last_terminal_batch': False,
            }
        )
        state['pending_draft_count'] = 0
        services.draft_catalog.state = state

        projected = services.project_state(project_pk=7, split='train', user_pk=3)

        self.assertFalse(projected['members'][0]['draft_ahead_of_committed'])
        self.assertTrue(projected['members'][0]['draft_ahead_of_active_batch'])
        self.assertFalse(projected['members'][1]['active_batch_member'])
        self.assertIsNotNone(projected['last_terminal_batch'])

    def test_terminal_success_does_not_hide_current_newer_draft(self) -> None:
        services = _services()
        state = _project_state()
        state['active_batch_id'] = None
        state['batch_state'] = None
        state['active_batch'] = None
        member = state['members'][0]
        member.update(
            active_batch_member=False,
            active_batch_semantic_hash=None,
            draft_ahead_of_active_batch=False,
        )
        state['last_terminal_batch'].update(state='succeeded', error=None)
        services.draft_catalog.state = state

        projected = services.project_state(project_pk=7, split='train', user_pk=3)

        self.assertEqual(projected['last_terminal_batch']['state'], 'succeeded')
        self.assertTrue(projected['members'][0]['pending'])
        self.assertTrue(projected['members'][0]['draft_ahead_of_committed'])

    def test_cross_project_abandon_conflict_does_not_call_finalizer_or_mutate_receipt(self) -> None:
        request_id = str(uuid4())
        receipt_id = f'roi-receipt:{request_id}'
        services = _services()
        response = _produced_response(request_id=request_id)
        services.receipt_store.records[receipt_id] = {
            'record_kind': 'attempt',
            'receipt_id': receipt_id,
            'attempt': {
                'request_state': 'produced',
                'request': {'project_id': '8', 'task_id': 'val:41'},
            },
            'response': response,
        }
        before = copy.deepcopy(services.receipt_store.records)
        before_disposition = services.receipt_store.disposition(receipt_id)

        with self.assertRaises(RoiReceiptConflictError):
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=receipt_id,
                reason='user_discarded',
                expected_project_pk=7,
                expected_split='train',
            )

        self.assertEqual(services.finalizer.calls, [])
        self.assertEqual(services.receipt_store.records, before)
        self.assertEqual(services.receipt_store.disposition(receipt_id), before_disposition)

    def test_active_generation_can_be_abandoned_before_receipt_and_backend_is_reusable(self) -> None:
        services = _services()
        first_target = _request_target()
        first_receipt_id = f'roi-receipt:{first_target.request_id}'
        generation_started = Event()
        generation_finished = Event()
        allow_target_bind = Event()
        errors = []
        backend_calls = []
        active_holder = []

        def run_blocked_generation() -> None:
            try:
                with services.inference_lifecycle(
                    request_id=first_target.request_id,
                    expected_project_pk=7,
                    expected_split='train',
                    expected_user_pk=3,
                ) as active:
                    active_holder.append(active)
                    generation_started.set()
                    self.assertTrue(allow_target_bind.wait(timeout=5))
                    token = services.bind_inference_target(active, first_target)
                    backend_calls.append(first_target.request_id)
                    self.assertTrue(token.requested)
                    response = _abandoned_response(first_target.request_id, token.reason)
                    services.receipt_store.records[first_receipt_id] = {
                        'record_kind': 'attempt',
                        'receipt_id': first_receipt_id,
                        'attempt': {
                            'request_state': 'abandoned_before_insertion',
                            'request': {
                                'project_id': first_target.project_id,
                                'task_id': first_target.task_id,
                                'current_user_id': first_target.current_user_id,
                            },
                        },
                        'response': response,
                    }
            except BaseException as exc:  # pragma: no cover - asserted below.
                errors.append(exc)
            finally:
                generation_finished.set()

        inference_thread = Thread(target=run_blocked_generation)
        inference_thread.start()
        self.assertTrue(generation_started.wait(timeout=5))

        terminal = []
        abandon_thread = Thread(
            target=lambda: terminal.append(
                services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=first_receipt_id,
                    reason='user_cancelled',
                    expected_project_pk=7,
                    expected_split='train',
                )
            )
        )
        abandon_thread.start()
        with services._inference_lifecycle:
            while active_holder[0].abandon_reason is None:
                services._inference_lifecycle.wait(timeout=5)
        with self.assertRaisesRegex(RoiReceiptConflictError, 'reason conflicts'):
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=first_receipt_id,
                reason='superseded',
                expected_project_pk=7,
                expected_split='train',
            )
        allow_target_bind.set()

        inference_thread.join(timeout=5)
        abandon_thread.join(timeout=5)
        self.assertFalse(inference_thread.is_alive())
        self.assertFalse(abandon_thread.is_alive())
        self.assertTrue(generation_finished.is_set())
        self.assertEqual(errors, [])
        self.assertEqual(terminal[0]['terminal_status'], 'abandoned_before_insertion')
        self.assertEqual(terminal[0]['failure'], {'stage': 'cancel', 'code': 'user_cancelled'})
        self.assertEqual(services.finalizer.calls, [])
        self.assertEqual(
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=first_receipt_id,
                reason='user_cancelled',
                expected_project_pk=7,
                expected_split='train',
            ),
            terminal[0],
        )
        later_target = _request_target(request_id=str(uuid4()))
        with services.inference_lifecycle(
            request_id=later_target.request_id,
            expected_project_pk=7,
            expected_split='train',
            expected_user_pk=3,
        ) as active:
            token = services.bind_inference_target(active, later_target)
            backend_calls.append(later_target.request_id)
            self.assertFalse(token.requested)
        self.assertEqual(backend_calls, [first_target.request_id, later_target.request_id])

    def test_abandon_first_intent_is_consumed_by_later_inference_registration(self) -> None:
        services = _services()
        target = _request_target()
        receipt_id = f'roi-receipt:{target.request_id}'

        with self.assertRaisesRegex(RoiReceiptConflictError, 'pending inference registration'):
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=receipt_id,
                reason='user_discarded',
                expected_project_pk=7,
                expected_split='train',
            )

        self.assertIn(target.request_id, services._pending_abandonments)
        with services.inference_lifecycle(
            request_id=target.request_id,
            expected_project_pk=7,
            expected_split='train',
            expected_user_pk=3,
        ) as active:
            self.assertEqual(active.abandon_reason, 'user_discarded')
            token = services.bind_inference_target(active, target)
            self.assertTrue(token.requested)
            self.assertEqual(token.reason, 'user_discarded')
            services.receipt_store.records[receipt_id] = _terminal_record(
                target,
                _abandoned_response(target.request_id, token.reason),
            )

        self.assertNotIn(target.request_id, services._pending_abandonments)
        self.assertEqual(
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=receipt_id,
                reason='user_discarded',
                expected_project_pk=7,
                expected_split='train',
            )['terminal_status'],
            'abandoned_before_insertion',
        )

    def test_pending_abandonment_is_bounded_expires_and_conflicts_exactly(self) -> None:
        services = _services()
        request_a, request_b = str(uuid4()), str(uuid4())
        clock = [0.0]

        with (
            patch.object(roi_services_module, '_PENDING_ABANDON_CAPACITY', 1),
            patch.object(roi_services_module, '_PENDING_ABANDON_TTL_SECONDS', 10.0),
            patch.object(roi_services_module.time, 'monotonic', side_effect=lambda: clock[0]),
        ):
            with self.assertRaisesRegex(RoiReceiptConflictError, 'pending inference registration'):
                services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=f'roi-receipt:{request_a}',
                    reason='user_cancelled',
                    expected_project_pk=7,
                    expected_split='train',
                )
            pending_a = services._pending_abandonments[request_a]
            before = dict(services._pending_abandonments)

            clock[0] = 1.0
            with self.assertRaisesRegex(RoiReceiptConflictError, 'pending inference registration'):
                services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=f'roi-receipt:{request_a}',
                    reason='user_cancelled',
                    expected_project_pk=7,
                    expected_split='train',
                )
            self.assertEqual(services._pending_abandonments, before)
            self.assertIs(services._pending_abandonments[request_a], pending_a)
            with self.assertRaisesRegex(RoiReceiptConflictError, 'pending ROI abandonment conflicts'):
                services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=f'roi-receipt:{request_a}',
                    reason='superseded',
                    expected_project_pk=7,
                    expected_split='train',
                )
            with self.assertRaisesRegex(RoiReceiptConflictError, 'pending ROI abandonment conflicts'):
                services.abandon(
                    user=SimpleNamespace(pk=4),
                    receipt_id=f'roi-receipt:{request_a}',
                    reason='user_cancelled',
                    expected_project_pk=7,
                    expected_split='train',
                )

            with self.assertRaisesRegex(RoiReceiptConflictError, 'capacity is full'):
                services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=f'roi-receipt:{request_b}',
                    reason='user_cancelled',
                    expected_project_pk=7,
                    expected_split='train',
                )
            self.assertEqual(services._pending_abandonments, before)
            self.assertIs(services._pending_abandonments[request_a], pending_a)

            target_a = _request_target(request_id=request_a)
            with services.inference_lifecycle(
                request_id=request_a,
                expected_project_pk=7,
                expected_split='train',
                expected_user_pk=3,
            ) as active:
                self.assertEqual(active.abandon_reason, 'user_cancelled')
                self.assertTrue(services.bind_inference_target(active, target_a).requested)

            with self.assertRaisesRegex(RoiReceiptConflictError, 'admission is saturated'):
                with services.inference_lifecycle(
                    request_id=request_b,
                    expected_project_pk=7,
                    expected_split='train',
                    expected_user_pk=3,
                ):
                    self.fail('saturated unknown inference was admitted')

            clock[0] = 12.0
            target_b = _request_target(request_id=request_b)
            with services.inference_lifecycle(
                request_id=request_b,
                expected_project_pk=7,
                expected_split='train',
                expected_user_pk=3,
            ) as active:
                self.assertIsNone(active.abandon_reason)
                self.assertFalse(services.bind_inference_target(active, target_b).requested)

    def test_existing_safe_no_insertion_terminals_return_exactly_without_mutation(self) -> None:
        safe_states = (
            ('empty', True, True),
            ('all_rejected', True, True),
            ('response_failure', False, True),
            ('profile_failure', False, False),
            ('transport_failure', False, False),
            ('runtime_failure', False, False),
            ('timeout_failure', False, False),
            ('cancelled', False, False),
            ('abandoned_before_insertion', False, False),
        )
        for state, clear_roi, has_counts in safe_states:
            with self.subTest(state=state):
                services = _services()
                target = _request_target(request_id=str(uuid4()))
                response = _safe_terminal_response(
                    target.request_id,
                    state=state,
                    clear_roi=clear_roi,
                    has_counts=has_counts,
                )
                services.receipt_store.records[response['receipt_id']] = _terminal_record(target, response)
                before = copy.deepcopy(services.receipt_store.records)
                reason = 'safe_terminal' if state == 'abandoned_before_insertion' else 'superseded'

                returned = services.abandon(
                    user=SimpleNamespace(pk=3),
                    receipt_id=response['receipt_id'],
                    reason=reason,
                    expected_project_pk=7,
                    expected_split='train',
                )

                self.assertEqual(returned, response)
                self.assertEqual(services.receipt_store.records, before)
                self.assertEqual(services.finalizer.calls, [])

    def test_existing_abandoned_terminal_requires_exact_reason_for_both_shapes(self) -> None:
        for label, response_factory in (
            ('early', lambda request_id: _abandoned_response(request_id, 'user_cancelled')),
            ('disposition', lambda request_id: _abandoned_disposition_response(request_id, 'user_cancelled')),
        ):
            with self.subTest(label=label):
                services = _services()
                target = _request_target(request_id=str(uuid4()))
                response = response_factory(target.request_id)
                services.receipt_store.records[response['receipt_id']] = _terminal_record(target, response)

                self.assertEqual(
                    services.abandon(
                        user=SimpleNamespace(pk=3),
                        receipt_id=response['receipt_id'],
                        reason='user_cancelled',
                        expected_project_pk=7,
                        expected_split='train',
                    ),
                    response,
                )
                with self.assertRaisesRegex(RoiReceiptConflictError, 'reason conflicts'):
                    services.abandon(
                        user=SimpleNamespace(pk=3),
                        receipt_id=response['receipt_id'],
                        reason='superseded',
                        expected_project_pk=7,
                        expected_split='train',
                    )

    def test_inserted_acceptance_is_never_treated_as_safe_abandonment(self) -> None:
        services = _services()
        target = _request_target()
        response = _accepted_response(target.request_id)
        services.receipt_store.records[response['receipt_id']] = {
            **_terminal_record(target, response),
            'attempt': {
                'request_state': 'produced',
                'request': {
                    'project_id': target.project_id,
                    'task_id': target.task_id,
                    'current_user_id': target.current_user_id,
                },
            },
        }

        with self.assertRaisesRegex(RoiReceiptConflictError, 'already inserted'):
            services.abandon(
                user=SimpleNamespace(pk=3),
                receipt_id=response['receipt_id'],
                reason='user_discarded',
                expected_project_pk=7,
                expected_split='train',
            )

        self.assertEqual(services.finalizer.calls, [])

    def test_store_state_keeps_prior_terminal_and_new_active_snapshot_separate(self) -> None:
        store = _ProjectStateStore()
        terminal_enqueue, terminal, journal = _terminal_records(state='succeeded')
        active = _active_enqueue()
        store.queue_records = [terminal_enqueue, terminal, active]
        store._records = [journal]
        store.active = active

        state = _store_project_state(store)

        self.assertEqual(state['generation'], 9)
        self.assertEqual(state['active_batch']['batch_id'], active['batch_id'])
        self.assertEqual(state['active_batch']['state'], 'running')
        self.assertEqual(
            state['active_member_semantic_hashes'],
            {'train:41': 'a' * 64},
        )
        self.assertEqual(state['last_terminal_batch']['batch_id'], terminal['batch_id'])
        self.assertEqual(state['last_terminal_batch']['state'], 'succeeded')
        self.assertEqual(
            state['last_terminal_batch']['member_task_keys'],
            ['train:40', 'train:43'],
        )
        self.assertEqual(
            state['last_terminal_member_semantic_hashes'],
            {'train:40': 'e' * 64, 'train:43': 'f' * 64},
        )

    def test_store_state_preserves_failed_terminal_and_reconciling_hides_it(self) -> None:
        store = _ProjectStateStore()
        enqueue, terminal, journal = _terminal_records(state='failed')
        store.queue_records = [enqueue, terminal]
        store._records = [journal]
        terminal_state = _store_project_state(store)
        self.assertEqual(terminal_state['last_terminal_batch']['error'], 'Batch processing failed.')

        active = _active_enqueue()
        store.queue_records.append(active)
        store.active = active
        store.reconciliation_reason = 'incomplete queue/journal transition'
        reconciling = _store_project_state(store)
        self.assertEqual(reconciling['active_batch']['state'], 'reconciling')
        self.assertIsNone(reconciling['last_terminal_batch'])

    def test_store_state_rejects_malformed_or_duplicate_queued_member_identity(self) -> None:
        store = _ProjectStateStore()
        active = _active_enqueue()
        active['payload']['members'].append(copy.deepcopy(active['payload']['members'][0]))
        store.queue_records = [active]
        store.active = active
        with self.assertRaises(DraftCatalogError):
            _store_project_state(store)


def _profile():
    return SimpleNamespace(
        fingerprint='a' * 64,
        processor_factor=32,
        default_width=1024,
        default_height=1024,
        min_axis_pixels=32,
        max_axis_pixels=2048,
        max_total_pixels=2_097_152,
        deadline_seconds=20.0,
        endpoint='http://127.0.0.1:1',
        path='/private/model',
    )


def _profile_option():
    return {
        'selector': 'safe',
        'display_label': 'safe',
        'default_canvas': {'width': 1024, 'height': 1024},
        'processor_factor': 32,
        'bounds': {
            'min_axis_pixels': 32,
            'max_axis_pixels': 2048,
            'max_total_pixels': 2_097_152,
        },
        'generation_deadline_seconds': 20.0,
    }


def _empty_response(*, request_id=None):
    request_id = request_id or str(uuid4())
    return {
        'receipt_id': f'roi-receipt:{request_id}',
        'request_id': request_id,
        'request_state': 'empty',
        'terminal_status': 'empty',
        'clear_roi': True,
        'insertion_payload': None,
        'failure': None,
        'counts': {'parsed': 0, 'produced': 0, 'rejected': 0},
    }


def _abandoned_response(request_id, reason):
    return {
        'receipt_id': f'roi-receipt:{request_id}',
        'request_id': request_id,
        'request_state': 'abandoned_before_insertion',
        'terminal_status': 'abandoned_before_insertion',
        'clear_roi': False,
        'insertion_payload': None,
        'failure': {'stage': 'cancel', 'code': reason},
    }


def _abandoned_disposition_response(request_id, reason):
    return {
        **_abandoned_response(request_id, reason),
        'failure': {'stage': 'insertion', 'code': reason},
        'counts': {'parsed': 1, 'inserted': 0, 'rejected': 0},
    }


def _terminal_record(target, response):
    return {
        'record_kind': 'attempt',
        'receipt_id': response['receipt_id'],
        'attempt': {
            'request_state': response['request_state'],
            'request': {
                'project_id': target.project_id,
                'task_id': target.task_id,
                'current_user_id': target.current_user_id,
            },
        },
        'response': response,
    }


def _safe_terminal_response(request_id, *, state, clear_roi, has_counts):
    response = {
        'receipt_id': f'roi-receipt:{request_id}',
        'request_id': request_id,
        'request_state': state,
        'terminal_status': state,
        'clear_roi': clear_roi,
        'insertion_payload': None,
        'failure': None,
    }
    if has_counts:
        response['counts'] = {
            'parsed': 1 if state == 'all_rejected' else 0,
            'produced': 0,
            'rejected': 1 if state == 'all_rejected' else 0,
        }
    else:
        response['failure'] = {
            'stage': 'cancel' if state in {'cancelled', 'abandoned_before_insertion'} else 'runtime',
            'code': 'safe_terminal',
        }
    return response


def _accepted_response(request_id):
    revision = '2026-07-15T00:00:01.000000Z'
    return {
        'receipt_id': f'roi-receipt:{request_id}',
        'request_id': request_id,
        'request_state': 'accepted',
        'terminal_status': 'accepted',
        'clear_roi': True,
        'insertion_payload': None,
        'failure': None,
        'counts': {'parsed': 1, 'inserted': 1, 'rejected': 0},
        'result_region_keys': {f'{request_id}:result-0': f'roi:{request_id}:1'},
        'insertion_attestation': {
            'source_annotation_revision': revision,
            'observed_annotation_revision': revision,
            'source_draft_revision': revision,
            'inserted_draft_revision': revision,
            'inserted_draft_updated_at': revision,
            'saved_full_result_sha256': 'a' * 64,
            'saved_semantic_result_sha256': 'b' * 64,
        },
    }


def _request_target(*, request_id=None):
    return RequestTarget(
        request_id=request_id or str(uuid4()),
        project_id='7',
        task_id='train:41',
        task_epoch='epoch-1',
        image_id='41',
        annotation_id='11',
        annotation_revision='annotation-revision-1',
        current_user_id='3',
        draft_id='12',
        draft_revision='2026-07-15T00:00:00.000000Z',
        profile_fingerprint='a' * 64,
        project_generation=9,
        transform_fingerprint='b' * 64,
        preexisting_draft_dirty=False,
    )


def _produced_response(*, request_id=None, bbox=(100, 200, 300, 400)):
    request_id = request_id or str(uuid4())
    receipt_id = f'roi-receipt:{request_id}'
    region_key = f'roi:{request_id}:1'
    result_id = 'result-1'
    revision = '2026-07-15T00:00:00.000000Z'
    x, y, width, height = norm1000_bbox_to_label_studio_xywh(bbox)
    return {
        'receipt_id': receipt_id,
        'request_id': request_id,
        'request_state': 'produced',
        'terminal_status': None,
        'clear_roi': False,
        'insertion_payload': {
            'target': {
                'request_id': request_id,
                'project_id': '7',
                'task_id': 'train:41',
                'task_epoch': 'epoch-1',
                'image_id': '41',
                'annotation_id': '11',
                'annotation_revision': revision,
                'current_user_id': '3',
                'draft_id': '12',
                'draft_revision': revision,
                'profile_fingerprint': 'a' * 64,
                'project_generation': 9,
                'transform_fingerprint': 'transform-1',
                'preexisting_draft_dirty': False,
            },
            'mode': 'append_one_undo_action',
            'regions': [
                {
                    'result_id': result_id,
                    'category_name': 'person',
                    'category_id': 1,
                    'bbox_2d': list(bbox),
                    'request_id': request_id,
                    'parser_object_span_id': 'span-1',
                    'source_draft_revision': revision,
                    'region_key': region_key,
                    'label_studio_result': {
                        'id': region_key,
                        'type': 'rectanglelabels',
                        'from_name': 'bbox',
                        'to_name': 'image',
                        'original_width': 640,
                        'original_height': 480,
                        'image_rotation': 0,
                        'value': {
                            'x': x,
                            'y': y,
                            'width': width,
                            'height': height,
                            'rotation': 0,
                            'rectanglelabels': ['person'],
                        },
                        'meta': {
                            'coordexp_region_key': region_key,
                            'coordexp_inference_receipt_id': receipt_id,
                            'coordexp_inference_request_id': request_id,
                            'coordexp_inference_result_id': result_id,
                            'coordexp_inference_source_draft_revision': revision,
                        },
                    },
                }
            ],
        },
        'failure': None,
        'counts': {'parsed': 1, 'produced': 1, 'rejected': 0},
    }


def _project_state():
    active_id = str(uuid4())
    terminal_id = str(uuid4())
    return {
        'generation': 9,
        'pending_draft_count': 1,
        'members': [
            {
                'task_id': 11,
                'task_key': 'train:41',
                'draft_id': 12,
                'draft_updated_at': '2026-07-15T00:00:00.000000Z',
                'draft_semantic_hash': 'a' * 64,
                'committed_semantic_hash': 'b' * 64,
                'pending': True,
                'draft_ahead_of_committed': True,
                'active_batch_member': True,
                'active_batch_semantic_hash': 'c' * 64,
                'draft_ahead_of_active_batch': True,
                'last_terminal_batch_member': True,
                'last_terminal_batch_semantic_hash': 'a' * 64,
                'draft_matches_last_terminal_batch': True,
            },
            {
                'task_id': 13,
                'task_key': 'train:43',
                'draft_id': 14,
                'draft_updated_at': '2026-07-15T00:00:01.000000Z',
                'draft_semantic_hash': 'f' * 64,
                'committed_semantic_hash': 'f' * 64,
                'pending': False,
                'draft_ahead_of_committed': False,
                'active_batch_member': False,
                'active_batch_semantic_hash': None,
                'draft_ahead_of_active_batch': False,
                'last_terminal_batch_member': True,
                'last_terminal_batch_semantic_hash': 'f' * 64,
                'draft_matches_last_terminal_batch': True,
            },
        ],
        'active_batch_id': active_id,
        'batch_state': 'running',
        'active_batch': {
            'batch_id': active_id,
            'state': 'running',
            'member_count': 1,
            'base_generation': 9,
            'payload_hash': 'd' * 64,
        },
        'last_terminal_batch': {
            'batch_id': terminal_id,
            'state': 'failed',
            'member_count': 2,
            'base_generation': 8,
            'generation': 9,
            'error': 'Batch processing failed.',
            'payload_hash': 'e' * 64,
            'member_task_keys': ['train:41', 'train:43'],
        },
    }


def _services():
    manager = _Manager()
    finalizer = SimpleNamespace(
        receipt_store=manager.receipt_store,
        calls=[],
    )

    def finalize_abandoned(**kwargs):
        finalizer.calls.append(kwargs)
        return kwargs['receipt_id_or_request_id']

    finalizer.finalize_abandoned = finalize_abandoned
    return RoiProjectServices(
        manager=manager,
        targets=object.__new__(DjangoRoiTargetCatalog),
        finalizer=finalizer,
        receipt_store=manager.receipt_store,
        draft_catalog=_Catalog(),
        stores={'train': object(), 'val': object()},
        profile_resolver=RoiLaunchProfileResolver(manager),
    )


class _ProjectStateStore:
    def __init__(self):
        self.queue_records = []
        self._records = []
        self.active = None
        self.reconciliation_reason = None

    def _shared_lock(self):
        return nullcontext()

    def _shared_queue_lock(self):
        return nullcontext()

    def _read_queue_records(self):
        return copy.deepcopy(self.queue_records)

    def _batch_reconciliation_reason(self, queue_records):
        del queue_records
        return self.reconciliation_reason

    def _read_manifest(self):
        return {'generation': 9}

    def _active_queue_enqueue(self, queue_records):
        del queue_records
        return copy.deepcopy(self.active)

    def _queue_batch_state(self, active, queue_records):
        del active, queue_records
        return SimpleNamespace(value='running'), None, None


def _active_enqueue():
    return {
        'kind': 'enqueue',
        'batch_id': str(uuid4()),
        'payload_hash': 'b' * 64,
        'base_generation': 9,
        'member_count': 1,
        'payload': {
            'members': [
                {
                    'request': {
                        'task_id': 'train:41',
                        'semantic_hash': 'a' * 64,
                    }
                }
            ]
        },
    }


def _terminal_records(*, state):
    batch_id = str(uuid4())
    error = None if state == 'succeeded' else 'private worker detail'
    common = {
        'batch_id': batch_id,
        'payload_hash': 'c' * 64,
        'status': state,
        'generation': 9,
        'working_sha256': 'd' * 64,
        'error': error,
    }
    enqueue = {
        'kind': 'enqueue',
        'batch_id': batch_id,
        'payload_hash': 'c' * 64,
        'base_generation': 8,
        'member_count': 2,
        'payload': {
            'members': [
                {'request': {'task_id': 'train:40', 'semantic_hash': 'e' * 64}},
                {'request': {'task_id': 'train:43', 'semantic_hash': 'f' * 64}},
            ]
        },
    }
    return enqueue, {'kind': 'queue_terminal', **common}, {'kind': 'batch_terminal', **common}

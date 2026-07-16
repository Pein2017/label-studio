from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

from coordexp_refinement.registry import runtime_registry
from coordexp_refinement.roi_services import RoiReceiptConflictError
from coordexp_refinement.roi_targets import DjangoRoiTargetError
from django.contrib.auth import get_user_model
from django.test import TestCase
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from rest_framework.test import APIClient


class _Runtime:
    def __init__(self, project_pk: int) -> None:
        self.project_ids = {'train': str(project_pk)}

    def capture_and_enqueue(self, **kwargs):
        raise AssertionError(kwargs)

    def batch_status(self, **kwargs):
        raise AssertionError(kwargs)


class _Captured:
    def __init__(self) -> None:
        self.image = SimpleNamespace(name='server-image')
        self.target = SimpleNamespace(project_id='server-project')
        self.transform = SimpleNamespace(fingerprint='server-transform')
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True


class _Targets:
    def __init__(self) -> None:
        self.calls = []
        self.captured = _Captured()
        self.error = None

    def capture(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        self.captured = _Captured()
        return self.captured


class _Manager:
    def __init__(self) -> None:
        self.calls = []
        self.response = {
            'receipt_id': f'roi-receipt:{uuid4()}',
            'request_id': str(uuid4()),
            'request_state': 'empty',
            'terminal_status': 'empty',
            'clear_roi': True,
            'insertion_payload': None,
            'failure': None,
            'counts': {'parsed': 0, 'produced': 0, 'rejected': 0},
        }
        self.error = None

    def profile_options(self):
        return (
            {
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
            },
        )

    def infer(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class _Services:
    def __init__(self) -> None:
        self.manager = _Manager()
        self.targets = _Targets()
        self.finalizer = SimpleNamespace(name='server-finalizer')
        self.receipt_store = SimpleNamespace(name='server-receipts')
        self.abandon_calls = []
        self.state_calls = []

    @contextmanager
    def request_admission(self):
        yield

    @contextmanager
    def inference_lifecycle(self, **kwargs):
        self.inference_lifecycle_call = kwargs
        yield SimpleNamespace(name='server-active-inference')

    def bind_inference_target(self, active, target):
        self.bound_inference = (active, target)
        return SimpleNamespace(name='server-cancellation-token')

    def safe_profiles(self):
        return self.manager.profile_options()

    def safe_infer_response(self, response):
        return response

    def abandon(self, **kwargs):
        self.abandon_calls.append(kwargs)
        return {
            'receipt_id': kwargs['receipt_id'],
            'request_id': kwargs['receipt_id'].removeprefix('roi-receipt:'),
            'request_state': 'abandoned_before_insertion',
            'terminal_status': 'abandoned_before_insertion',
            'clear_roi': False,
            'insertion_payload': None,
            'failure': {'stage': 'insertion', 'code': kwargs['reason']},
            'counts': {'parsed': 1, 'inserted': 0, 'rejected': 0},
        }

    def project_state(self, **kwargs):
        self.state_calls.append(kwargs)
        return {
            'version': 4,
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
                    'last_terminal_batch_member': False,
                    'last_terminal_batch_semantic_hash': None,
                    'draft_matches_last_terminal_batch': False,
                }
            ],
            'active_batch_id': (batch_id := str(uuid4())),
            'batch_state': 'running',
            'active_batch': {
                'batch_id': batch_id,
                'state': 'running',
                'member_count': 1,
                'base_generation': 9,
                'payload_hash': 'd' * 64,
            },
            'last_terminal_batch': None,
        }


class RoiApiTest(TestCase):
    def setUp(self) -> None:
        self.user = get_user_model().objects.create_user(
            username='roi-owner@example.test',
            email='roi-owner@example.test',
            password='test-password',
        )
        organization = Organization.objects.create(title='ROI', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=organization)
        self.user.active_organization = organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='ROI train',
            organization=organization,
            created_by=self.user,
            is_published=True,
        )
        self.runtime = _Runtime(self.project.pk)
        self.services = _Services()
        runtime_registry.register(
            project_pk=self.project.pk,
            split='train',
            runtime=self.runtime,
            services=self.services,
        )
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.force_authenticate(user=self.user)
        self.request_id = str(uuid4())

    def tearDown(self) -> None:
        runtime_registry.unregister(self.project.pk)

    def _url(self, suffix: str) -> str:
        return f'/api/projects/{self.project.pk}/coordexp-refinement/{suffix}/'

    def _token(self) -> str:
        response = self.client.get(self._url('session'))
        self.assertEqual(response.status_code, 200)
        return response.json()['csrf_token']

    def _infer_body(self, **updates):
        body = {
            'request_id': self.request_id,
            'task_id': 17,
            'roi': {'x': 1.0, 'y': 2.0, 'width': 30.0, 'height': 40.0},
            'resolution': {'width': 1024, 'height': 1024},
            'profile_selector': 'safe',
        }
        body.update(updates)
        return body

    def _post(self, suffix: str, body: dict, **extra):
        return self.client.post(
            self._url(suffix),
            body,
            format='json',
            HTTP_X_CSRFTOKEN=self._token(),
            **extra,
        )

    def test_profiles_are_authenticated_no_store_and_safe(self) -> None:
        anonymous = APIClient().get(self._url('roi/profiles'))
        self.assertIn(anonymous.status_code, {401, 403})

        response = self.client.get(self._url('roi/profiles'))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response.json(), {'profiles': list(self.services.manager.profile_options())})
        self.assertNotIn('/data/', response.content.decode())

    def test_infer_requires_csrf_and_same_origin(self) -> None:
        missing = self.client.post(self._url('roi/infer'), self._infer_body(), format='json')
        self.assertEqual(missing.status_code, 403)
        token = self._token()
        cross_origin = self.client.post(
            self._url('roi/infer'),
            self._infer_body(),
            format='json',
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN='https://evil.example',
        )
        self.assertEqual(cross_origin.status_code, 403)
        self.assertEqual(self.services.targets.calls, [])

    def test_infer_uses_only_server_capture_and_always_closes_image(self) -> None:
        response = self._post('roi/infer', self._infer_body())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response.json(), self.services.manager.response)
        capture = self.services.targets.calls[0]
        self.assertIs(capture['user'], self.user)
        self.assertEqual(capture['project_pk'], self.project.pk)
        self.assertEqual(capture['task_pk'], 17)
        self.assertNotIn('image', capture)
        call = self.services.manager.calls[0]
        self.assertIs(call['image'], self.services.targets.captured.image)
        self.assertIs(call['target'], self.services.targets.captured.target)
        self.assertEqual(call['cancellation_token'].name, 'server-cancellation-token')
        self.assertEqual(
            self.services.inference_lifecycle_call,
            {
                'request_id': self.request_id,
                'expected_project_pk': self.project.pk,
                'expected_split': 'train',
                'expected_user_pk': self.user.pk,
            },
        )
        self.assertIs(self.services.bound_inference[1], self.services.targets.captured.target)
        self.assertTrue(self.services.targets.captured.closed)

    def test_infer_body_rejects_browser_authority_and_non_finite_values(self) -> None:
        forbidden = (
            'project_id',
            'user_id',
            'draft_id',
            'annotation_id',
            'image',
            'image_id',
            'generation',
            'fingerprint',
            'revision',
            'path',
        )
        for field in forbidden:
            with self.subTest(field=field):
                body = self._infer_body()
                body[field] = 'attacker'
                response = self._post('roi/infer', body)
                self.assertEqual(response.status_code, 400)
        for value in (True, '1'):
            with self.subTest(value=value):
                response = self._post(
                    'roi/infer',
                    self._infer_body(roi={'x': value, 'y': 2, 'width': 3, 'height': 4}),
                )
                self.assertEqual(response.status_code, 400)
        for value in (float('nan'), float('inf')):
            with self.subTest(value=value):
                raw = json.dumps(self._infer_body(roi={'x': value, 'y': 2, 'width': 3, 'height': 4}))
                response = self.client.generic(
                    'POST',
                    self._url('roi/infer'),
                    raw,
                    content_type='application/json',
                    HTTP_X_CSRFTOKEN=self._token(),
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.services.targets.calls, [])

    def test_target_and_runtime_failures_are_safe_and_image_closes(self) -> None:
        self.services.targets.error = DjangoRoiTargetError('/private/task mismatch')
        mismatch = self._post('roi/infer', self._infer_body())
        self.assertEqual(mismatch.status_code, 409)
        self.assertNotIn('/private', mismatch.content.decode())
        self.services.targets.error = None
        self.services.manager.error = RuntimeError('token=secret /private/model')
        failed = self._post('roi/infer', self._infer_body())
        self.assertEqual(failed.status_code, 503)
        self.assertNotIn('secret', failed.content.decode())
        self.assertTrue(self.services.targets.captured.closed)

    def test_parent_produced_empty_failure_and_retry_shapes_pass_through_exactly(self) -> None:
        receipt_id = f'roi-receipt:{self.request_id}'
        cases = (
            {
                'receipt_id': receipt_id,
                'request_id': self.request_id,
                'request_state': 'produced',
                'terminal_status': None,
                'clear_roi': False,
                'insertion_payload': {
                    'target': {'request_id': self.request_id},
                    'regions': [{'result_id': 'result-1', 'region_key': 'roi:1'}],
                },
                'failure': None,
                'counts': {'parsed': 1, 'produced': 1, 'rejected': 0},
            },
            {
                'receipt_id': receipt_id,
                'request_id': self.request_id,
                'request_state': 'empty',
                'terminal_status': 'empty',
                'clear_roi': True,
                'insertion_payload': None,
                'failure': None,
                'counts': {'parsed': 0, 'produced': 0, 'rejected': 0},
            },
            {
                'receipt_id': receipt_id,
                'request_id': self.request_id,
                'request_state': 'runtime_failure',
                'terminal_status': 'runtime_failure',
                'clear_roi': False,
                'insertion_payload': None,
                'failure': {'stage': 'runtime', 'code': 'resident.runtime_failure'},
            },
        )
        for response_payload in cases:
            with self.subTest(state=response_payload['request_state']):
                self.services.manager.response = response_payload
                first = self._post('roi/infer', self._infer_body())
                retry = self._post('roi/infer', self._infer_body())
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.json(), response_payload)
                self.assertEqual(retry.json(), response_payload)
                self.assertNotIn('/private', retry.content.decode())

    def test_abandon_has_exact_reason_enum_and_returns_terminal_receipt(self) -> None:
        receipt_id = f'roi-receipt:{self.request_id}'
        invalid = self._post(
            'roi/abandon',
            {'receipt_id': receipt_id, 'reason': 'attacker_reason'},
        )
        self.assertEqual(invalid.status_code, 400)

        response = self._post(
            'roi/abandon',
            {'receipt_id': receipt_id, 'reason': 'user_discarded'},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['receipt_id'], receipt_id)
        self.assertEqual(response.json()['terminal_status'], 'abandoned_before_insertion')
        self.assertEqual(
            self.services.abandon_calls,
            [
                {
                    'user': self.user,
                    'receipt_id': receipt_id,
                    'reason': 'user_discarded',
                    'expected_project_pk': self.project.pk,
                    'expected_split': 'train',
                }
            ],
        )

    def test_cross_project_abandon_conflict_returns_409(self) -> None:
        def conflict(**_kwargs):
            raise RoiReceiptConflictError('route mismatch')

        self.services.abandon = conflict
        response = self._post(
            'roi/abandon',
            {
                'receipt_id': f'roi-receipt:{self.request_id}',
                'reason': 'user_discarded',
            },
        )

        self.assertEqual(response.status_code, 409)
        self.assertNotIn('route mismatch', response.content.decode())

    def test_project_state_has_exact_authoritative_overlay_without_enqueue(self) -> None:
        response = self.client.get(self._url('project-state'))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {
                'version',
                'generation',
                'pending_draft_count',
                'members',
                'active_batch_id',
                'batch_state',
                'active_batch',
                'last_terminal_batch',
            },
        )
        self.assertEqual(payload['pending_draft_count'], 1)
        self.assertEqual(payload['members'][0]['task_id'], 11)
        self.assertEqual(
            self.services.state_calls,
            [
                {
                    'project_pk': self.project.pk,
                    'split': 'train',
                    'user_pk': self.user.pk,
                }
            ],
        )

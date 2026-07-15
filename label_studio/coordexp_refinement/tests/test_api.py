from __future__ import annotations

from uuid import uuid4

from coordexp_refinement.registry import RuntimeBindingError, runtime_registry
from django.contrib.auth import get_user_model
from django.test import TestCase
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from rest_framework.test import APIClient
from src.label_studio_coco_refinement.runtime import (
    BatchStatusReceipt,
    DraftCatalogError,
)
from src.label_studio_coco_refinement.store import BatchStatus, StoreBusyError, ValidationError


class FakeRuntime:
    def __init__(self, *, split: str = 'train') -> None:
        self.split = split
        self.project_ids: dict[str, str] = {}
        self.status = BatchStatus.QUEUED.value
        self.error: str | None = None
        self.capture_error: Exception | None = None
        self.status_error: Exception | None = None
        self.capture_receipt: BatchStatusReceipt | None = None
        self.status_receipt: BatchStatusReceipt | None = None
        self.capture_calls: list[dict] = []
        self.status_calls: list[dict] = []

    def capture_and_enqueue(self, **kwargs) -> BatchStatusReceipt:
        self.capture_calls.append(dict(kwargs))
        if self.capture_error is not None:
            raise self.capture_error
        if self.capture_receipt is not None:
            return self.capture_receipt
        return self._receipt(kwargs['batch_id'])

    def batch_status(self, **kwargs) -> BatchStatusReceipt:
        self.status_calls.append(dict(kwargs))
        if self.status_error is not None:
            raise self.status_error
        if self.status_receipt is not None:
            return self.status_receipt
        return self._receipt(kwargs['batch_id'])

    def _receipt(self, batch_id: str) -> BatchStatusReceipt:
        terminal = self.status in {BatchStatus.SUCCEEDED.value, BatchStatus.FAILED.value}
        return BatchStatusReceipt(
            batch_id=batch_id,
            payload_hash='a' * 64,
            status=self.status,
            split=self.split,
            member_count=3,
            base_generation=7,
            generation=8 if terminal else None,
            error=self.error,
        )


class RefinementAPITestCase(TestCase):
    def setUp(self) -> None:
        self.user = _user('owner@example.test')
        self.organization = Organization.objects.create(title='CoordExp', created_by=self.user)
        OrganizationMember.objects.create(user=self.user, organization=self.organization)
        self.user.active_organization = self.organization
        self.user.save(update_fields=['active_organization'])
        self.project = Project.objects.create(
            title='COCO train',
            organization=self.organization,
            created_by=self.user,
            is_published=True,
        )
        self.runtime = FakeRuntime()
        self.runtime.project_ids = {'train': str(self.project.pk)}
        runtime_registry.register(project_pk=self.project.pk, split='train', runtime=self.runtime)
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.force_authenticate(user=self.user)
        self.batch_id = str(uuid4())

    def tearDown(self) -> None:
        runtime_registry.unregister(self.project.pk)

    @property
    def commit_url(self) -> str:
        return f'/api/projects/{self.project.pk}/coordexp-refinement/commit/'

    @property
    def status_url(self) -> str:
        return f'/api/projects/{self.project.pk}/coordexp-refinement/status/'

    @property
    def session_url(self) -> str:
        return f'/api/projects/{self.project.pk}/coordexp-refinement/session/'

    def csrf_token(self) -> str:
        response = self.client.get(self.session_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        token = response.json()['csrf_token']
        self.assertEqual(len(token), 64)
        self.assertNotEqual(token, self.client.cookies['csrftoken'].value)
        return token

    def post(self, payload: dict, **extra):
        token = self.csrf_token()
        return self.client.post(
            self.commit_url,
            payload,
            format='json',
            HTTP_X_CSRFTOKEN=token,
            **extra,
        )

    def test_anonymous_requests_are_rejected(self) -> None:
        client = APIClient(enforce_csrf_checks=True)

        for method, url in (
            ('get', self.session_url),
            ('get', f'{self.status_url}?batch_id={self.batch_id}'),
        ):
            with self.subTest(method=method, url=url):
                response = getattr(client, method)(url)
                self.assertIn(response.status_code, {401, 403})
                self.assertEqual(response['Cache-Control'], 'no-store')

    def test_commit_requires_csrf_and_rejects_cross_site_origin(self) -> None:
        missing = self.client.post(self.commit_url, {'batch_id': self.batch_id}, format='json')
        self.assertEqual(missing.status_code, 403)
        self.assertEqual(missing.json()['error']['code'], 'csrf_failed')
        self.assertEqual(missing['Cache-Control'], 'no-store')
        self.assertEqual(self.runtime.capture_calls, [])

        token = self.csrf_token()
        cross_site = self.client.post(
            self.commit_url,
            {'batch_id': self.batch_id},
            format='json',
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN='https://evil.example',
        )
        self.assertEqual(cross_site.status_code, 403)
        self.assertEqual(cross_site.json()['error']['code'], 'csrf_failed')
        self.assertEqual(cross_site['Cache-Control'], 'no-store')
        self.assertEqual(self.runtime.capture_calls, [])

        accepted = self.client.post(
            self.commit_url,
            {'batch_id': self.batch_id},
            format='json',
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(accepted.status_code, 202)

    def test_foreign_organization_project_is_hidden_before_registry_access(self) -> None:
        other = _user('foreign@example.test')
        organization = Organization.objects.create(title='Foreign', created_by=other)
        OrganizationMember.objects.create(user=other, organization=organization)
        other.active_organization = organization
        other.save(update_fields=['active_organization'])
        project = Project.objects.create(title='Foreign', organization=organization, created_by=other)
        foreign_runtime = FakeRuntime(split='val')
        foreign_runtime.project_ids = {'val': str(project.pk)}
        runtime_registry.register(project_pk=project.pk, split='val', runtime=foreign_runtime)
        try:
            response = self.post_to(project.pk, {'batch_id': self.batch_id})
        finally:
            runtime_registry.unregister(project.pk)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(foreign_runtime.capture_calls, [])
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_unregistered_accessible_project_fails_closed(self) -> None:
        project = Project.objects.create(
            title='Unregistered',
            organization=self.organization,
            created_by=self.user,
        )

        response = self.post_to(project.pk, {'batch_id': self.batch_id})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['error']['code'], 'refinement_unavailable')
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_registry_rejects_runtime_bound_to_another_project(self) -> None:
        project = Project.objects.create(
            title='Wrong binding',
            organization=self.organization,
            created_by=self.user,
        )
        runtime = FakeRuntime()
        runtime.project_ids = {'train': str(self.project.pk)}

        with self.assertRaisesRegex(RuntimeBindingError, 'project/split mapping'):
            runtime_registry.register(project_pk=project.pk, split='train', runtime=runtime)

    def test_body_accepts_only_batch_id_and_never_browser_authority(self) -> None:
        forbidden = (
            'split',
            'project_id',
            'user_id',
            'task_id',
            'draft_id',
            'source_row_index',
            'path',
            'host',
        )
        for field in forbidden:
            with self.subTest(field=field):
                response = self.post({'batch_id': self.batch_id, field: 'attacker-value'})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['error']['code'], 'invalid_request')
        self.assertEqual(self.runtime.capture_calls, [])

    def test_malformed_json_and_non_json_body_have_stable_errors(self) -> None:
        token = self.csrf_token()
        malformed = self.client.generic(
            'POST',
            self.commit_url,
            '{"batch_id":',
            content_type='application/json',
            HTTP_X_CSRFTOKEN=token,
        )
        non_json = self.client.post(
            self.commit_url,
            {'batch_id': self.batch_id},
            HTTP_X_CSRFTOKEN=token,
        )

        for response in (malformed, non_json):
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()['error']['code'], 'invalid_request')
            self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(self.runtime.capture_calls, [])

    def test_commit_derives_split_and_current_authenticated_principal(self) -> None:
        response = self.post({'batch_id': self.batch_id})

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()['status'], 'queued')
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(len(self.runtime.capture_calls), 1)
        call = self.runtime.capture_calls[0]
        self.assertEqual(call['split'], 'train')
        self.assertEqual(call['batch_id'], self.batch_id)
        self.assertTrue(call['principal'].authenticated)
        self.assertEqual(call['principal'].user_id, str(self.user.pk))

    def test_terminal_idempotent_retry_returns_200(self) -> None:
        self.runtime.status = BatchStatus.SUCCEEDED.value

        response = self.post({'batch_id': self.batch_id})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'succeeded')
        self.assertEqual(response.json()['generation'], 8)

    def test_each_active_retry_state_returns_202(self) -> None:
        for status in (
            BatchStatus.QUEUED.value,
            BatchStatus.RUNNING.value,
            BatchStatus.RECONCILING.value,
        ):
            with self.subTest(status=status):
                self.runtime.status = status
                response = self.post({'batch_id': str(uuid4())})
                self.assertEqual(response.status_code, 202)
                self.assertEqual(response.json()['status'], status)

    def test_commit_reports_different_existing_active_batch_identity(self) -> None:
        requested_batch_id = str(uuid4())
        active_batch_id = str(uuid4())
        for status in (
            BatchStatus.QUEUED.value,
            BatchStatus.RUNNING.value,
            BatchStatus.RECONCILING.value,
        ):
            with self.subTest(status=status):
                self.runtime.capture_receipt = _receipt(
                    batch_id=active_batch_id,
                    status=status,
                    split='train',
                )
                response = self.post({'batch_id': requested_batch_id})

                self.assertEqual(response.status_code, 202)
                self.assertEqual(response['Cache-Control'], 'no-store')
                self.assertEqual(response.json()['batch_id'], active_batch_id)
                self.assertEqual(response.json()['status'], status)
                self.assertEqual(self.runtime.capture_calls[-1]['batch_id'], requested_batch_id)

    def test_commit_rejects_unsafe_different_receipt_identity(self) -> None:
        requested_batch_id = str(uuid4())
        active_batch_id = '123e4567-e89b-12d3-a456-426614174000'
        cases = (
            (
                'non-canonical active ID',
                _receipt(
                    batch_id=active_batch_id.upper(),
                    status=BatchStatus.QUEUED.value,
                    split='train',
                ),
            ),
            (
                'succeeded receipt',
                _receipt(
                    batch_id=active_batch_id,
                    status=BatchStatus.SUCCEEDED.value,
                    split='train',
                ),
            ),
            (
                'failed receipt',
                _receipt(
                    batch_id=active_batch_id,
                    status=BatchStatus.FAILED.value,
                    split='train',
                ),
            ),
            (
                'not-found receipt',
                _receipt(
                    batch_id=active_batch_id,
                    status=BatchStatus.NOT_FOUND.value,
                    split=None,
                ),
            ),
            (
                'cross-split active receipt',
                _receipt(
                    batch_id=active_batch_id,
                    status=BatchStatus.RUNNING.value,
                    split='val',
                ),
            ),
        )
        for label, receipt in cases:
            with self.subTest(label=label):
                self.runtime.capture_receipt = receipt
                response = self.post({'batch_id': requested_batch_id})

                self.assertEqual(response.status_code, 503)
                self.assertEqual(response['Cache-Control'], 'no-store')
                self.assertEqual(response.json()['error']['code'], 'refinement_unavailable')

    def test_status_rejects_different_receipt_identity(self) -> None:
        active_batch_id = str(uuid4())
        self.runtime.status_receipt = _receipt(
            batch_id=active_batch_id,
            status=BatchStatus.RUNNING.value,
            split='train',
        )

        response = self.client.get(f'{self.status_url}?batch_id={self.batch_id}')

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response.json()['error']['code'], 'refinement_unavailable')
        self.assertEqual(self.runtime.status_calls, [{'split': 'train', 'batch_id': self.batch_id}])

    def test_status_uses_registered_split_and_sanitizes_runtime_error(self) -> None:
        self.runtime.status = BatchStatus.FAILED.value
        self.runtime.error = '/private/runtime/path: internal failure'

        response = self.client.get(f'{self.status_url}?batch_id={self.batch_id}')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response.json()['error'], 'Batch processing failed.')
        self.assertNotIn('/private', response.content.decode())
        self.assertEqual(self.runtime.status_calls, [{'split': 'train', 'batch_id': self.batch_id}])

    def test_malformed_and_duplicate_batch_ids_are_rejected(self) -> None:
        for value in ('not-a-uuid', self.batch_id.upper(), 7, ''):
            with self.subTest(value=value):
                response = self.post({'batch_id': value})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['error']['code'], 'invalid_batch_id')

        response = self.client.get(f'{self.status_url}?batch_id={self.batch_id}&batch_id={str(uuid4())}')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.runtime.capture_calls, [])
        self.assertEqual(self.runtime.status_calls, [])

    def test_catalog_validation_busy_and_status_busy_have_stable_errors(self) -> None:
        commit_cases = (
            (DraftCatalogError('secret draft row'), 400, 'invalid_commit'),
            (ValidationError('secret payload'), 400, 'invalid_commit'),
            (StoreBusyError('/private/lock'), 409, 'batch_busy'),
        )
        for error, status, code in commit_cases:
            with self.subTest(error=type(error).__name__):
                self.runtime.capture_error = error
                response = self.post({'batch_id': self.batch_id})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()['error']['code'], code)
                self.assertNotIn('secret', response.content.decode())
                self.assertNotIn('/private', response.content.decode())
        self.runtime.capture_error = None
        self.runtime.status_error = StoreBusyError('/private/lock')

        response = self.client.get(f'{self.status_url}?batch_id={self.batch_id}')

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['error']['code'], 'batch_busy')
        self.assertNotIn('/private', response.content.decode())

    def post_to(self, project_pk: int, payload: dict):
        token = self.csrf_token()
        return self.client.post(
            f'/api/projects/{project_pk}/coordexp-refinement/commit/',
            payload,
            format='json',
            HTTP_X_CSRFTOKEN=token,
        )


def _user(email: str):
    return get_user_model().objects.create_user(username=email, email=email, password='test-password')


def _receipt(*, batch_id: str, status: str, split: str | None) -> BatchStatusReceipt:
    terminal = status in {BatchStatus.SUCCEEDED.value, BatchStatus.FAILED.value}
    return BatchStatusReceipt(
        batch_id=batch_id,
        payload_hash='a' * 64,
        status=status,
        split=split,
        member_count=3,
        base_generation=7,
        generation=8 if terminal else None,
        error='internal failure' if status == BatchStatus.FAILED.value else None,
    )

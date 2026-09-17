#!/usr/bin/env python
"""Launch a disposable, model-free Label Studio shell for the CoordExp Cypress E2E.

From ``/data/CoordExp/label-studio``::

    .venv/bin/python label_studio/coordexp_refinement/tests/browser_e2e_fixture.py \
      --port 8081

The command migrates a fresh SQLite database, seeds one authenticated managed
project with two 1024x1024 image tasks, and starts Django's ordinary
``runserver`` without loading ``serve_coordexp_refinement`` or any model.  When
``--data-dir`` is omitted the directory is temporary and removed when the
server exits; pass a nonexistent path explicitly to retain it for debugging.
The Cypress spec owns the model-free managed API fake and its table-driven
terminal outcomes; this fixture deliberately owns only real auth, task,
annotation, and Draft persistence.

In another shell, after building the local web bundle, run::

    cd web
    CYPRESS_baseUrl=http://127.0.0.1:8081 \
      corepack yarn cypress run --config-file apps/labelstudio-e2e/cypress.config.ts \
      --browser electron --spec apps/labelstudio-e2e/src/e2e/coordexp-managed.cy.ts

The app-local Biome config is an independent root.  Run it from that app so the
repository root exclusion cannot silently produce ``Checked 0 files``::

    cd web/apps/labelstudio-e2e
    ../../node_modules/.bin/biome check --config-path biome.json \
      cypress.config.ts src/e2e/coordexp-managed.cy.ts --verbose
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
COORDEXP_ROOT = REPO_ROOT.parent
MANAGED_MARKER = 'coordexp-refinement-project-identity:browser-e2e:train'
EMAIL = 'browser-e2e@example.test'
PASSWORD = 'browser-e2e-password'
LIFECYCLE_SEAM_HEADER = 'coordexp-browser-e2e-lifecycle-v1'
LIFECYCLE_SEAM_PATH = '__coordexp-browser-e2e__/task-lifecycle/'


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8081)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--verbosity', type=int, choices=(0, 1, 2, 3), default=1)
    return parser.parse_args()


def _image_data_url(label: str) -> str:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
        'viewBox="0 0 1024 1024">'
        '<rect width="1024" height="1024" fill="#f4f4f4"/>'
        '<path d="M0 512H1024M512 0V1024" stroke="#d0d0d0" stroke-width="4"/>'
        f'<text x="32" y="64" font-size="36" fill="#333">{label}</text>'
        '</svg>'
    )
    encoded = base64.b64encode(svg.encode('utf-8')).decode('ascii')
    return f'data:image/svg+xml;base64,{encoded}'


def _source_result(ordinal: int) -> list[dict[str, object]]:
    """Return one canonical editable source bbox, away from scripted ROI gestures."""

    boxes = {
        1: (650, 650, 800, 820),
        2: (700, 100, 850, 260),
    }
    x1, y1, x2, y2 = boxes[ordinal]
    object_id = 1000 + ordinal
    region_key = f'train:coco:{object_id}'
    return [
        {
            'id': region_key,
            'type': 'rectanglelabels',
            'from_name': 'bbox',
            'to_name': 'image',
            'original_width': 1024,
            'original_height': 1024,
            'image_rotation': 0,
            'value': {
                'x': 100 * x1 / 999,
                'y': 100 * y1 / 999,
                'width': 100 * (x2 - x1) / 999,
                'height': 100 * (y2 - y1) / 999,
                'rotation': 0,
                'rectanglelabels': ['person'],
            },
            'meta': {
                'coordexp_region_key': region_key,
                'last_committed_bbox': [x1, y1, x2, y2],
                'coco_ann_id': object_id,
            },
        }
    ]


def _timestamp(value: Any) -> str:
    result = value.isoformat()
    return f'{result[:-6]}Z' if result.endswith('+00:00') else result


def _install_lifecycle_persistence_seam() -> None:
    """Install a disposable exact-token Draft CAS endpoint for browser E2E only."""

    from importlib import import_module

    from django.conf import settings
    from django.db import transaction
    from django.http import HttpRequest, JsonResponse
    from django.urls import clear_url_caches, path
    from django.views.decorators.csrf import csrf_exempt
    from src.label_studio_coco_refinement.draft_adapter import canonicalize_label_studio_draft
    from tasks.models import AnnotationDraft

    def response(payload: dict[str, object], *, status: int = 200) -> JsonResponse:
        result = JsonResponse(payload, status=status)
        result['Cache-Control'] = 'no-store'
        return result

    @csrf_exempt
    def task_lifecycle(request: HttpRequest) -> JsonResponse:
        if request.method != 'POST':
            return response({'error': {'code': 'method_not_allowed'}}, status=405)
        if request.headers.get('X-Coordexp-Browser-E2E-Seam') != LIFECYCLE_SEAM_HEADER:
            return response({'error': {'code': 'fixture_seam_required'}}, status=403)
        if not getattr(request.user, 'is_authenticated', False):
            return response({'error': {'code': 'fixture_auth_required'}}, status=403)
        try:
            body = json.loads(request.body)
        except (TypeError, ValueError):
            return response({'error': {'code': 'invalid_fixture_json'}}, status=400)
        expected_keys = {
            'action',
            'annotation_id',
            'allow_rebase',
            'committed_generation',
            'committed_result',
            'committed_semantic_hash',
            'expected_draft',
            'production_request',
            'task_id',
        }
        if not isinstance(body, dict) or set(body) != expected_keys:
            received_keys = sorted(body) if isinstance(body, dict) else None
            return response(
                {
                    'error': {
                        'code': 'invalid_fixture_shape',
                        'received_keys': received_keys,
                    }
                },
                status=400,
            )
        production = body['production_request']
        if not isinstance(production, dict) or set(production) != {
            'action',
            'task_id',
            'expected_draft',
        }:
            return response({'error': {'code': 'invalid_production_shape'}}, status=400)
        if (
            body['action'] != production['action']
            or body['task_id'] != production['task_id']
            or body['expected_draft'] != production['expected_draft']
        ):
            return response({'error': {'code': 'fixture_production_mismatch'}}, status=400)
        action = production['action']
        expected = production['expected_draft']
        if action not in {'inspect', 'reconcile', 'discard'} or not isinstance(expected, dict):
            return response({'error': {'code': 'invalid_production_action'}}, status=400)
        if set(expected) != {'draft_id', 'draft_updated_at', 'draft_semantic_hash'}:
            return response({'error': {'code': 'invalid_production_token'}}, status=400)
        allow_rebase = body['allow_rebase']
        if not isinstance(allow_rebase, bool) or (allow_rebase and action != 'reconcile'):
            return response({'error': {'code': 'invalid_fixture_rebase'}}, status=400)
        if not isinstance(body['committed_result'], list):
            return response({'error': {'code': 'invalid_fixture_result'}}, status=400)
        if (
            isinstance(body['committed_generation'], bool)
            or not isinstance(body['committed_generation'], int)
            or body['committed_generation'] < 0
        ):
            return response({'error': {'code': 'invalid_fixture_generation'}}, status=400)

        try:
            with transaction.atomic():
                draft = AnnotationDraft.objects.select_for_update().get(
                    pk=expected['draft_id'],
                    task_id=production['task_id'],
                    annotation_id=body['annotation_id'],
                    user_id=request.user.pk,
                )
                task_data = draft.task.data
                current = canonicalize_label_studio_draft(
                    draft.result,
                    split=task_data['split'],
                    image_id=task_data['image_id'],
                    image_width=1024,
                    image_height=1024,
                )
                revision_matches = (
                    _timestamp(draft.updated_at) == expected['draft_updated_at']
                )
                semantic_hash_matches = (
                    current.semantic_hash == expected['draft_semantic_hash']
                )
                token_matches = (
                    revision_matches and semantic_hash_matches
                )
                if not token_matches and action == 'discard':
                    return response(
                        {
                            'error': {
                                'code': 'fixture_token_conflict',
                                'action': action,
                                'task_id': draft.task_id,
                                'revision_matches': revision_matches,
                                'semantic_hash_matches': semantic_hash_matches,
                                'actual_revision': _timestamp(draft.updated_at),
                                'expected_revision': expected['draft_updated_at'],
                                'actual_semantic_hash': current.semantic_hash,
                                'expected_semantic_hash': expected['draft_semantic_hash'],
                            }
                        },
                        status=409,
                    )
                if allow_rebase and not token_matches:
                    return response(
                        {'error': {'code': 'fixture_stale_rebase_requested'}},
                        status=409,
                    )

                disposition = 'metadata_only'
                draft_hash = current.semantic_hash
                if action == 'discard' or (
                    action == 'reconcile' and allow_rebase and token_matches
                ):
                    draft.result = body['committed_result']
                    draft.was_postponed = False
                    draft.save(update_fields=['result', 'was_postponed', 'updated_at'])
                    draft_hash = body['committed_semantic_hash']
                    disposition = 'reset' if action == 'discard' else 'rebased'

                return response(
                    {
                        'action': action,
                        'disposition': disposition,
                        'task_id': draft.task_id,
                        'annotation_id': draft.annotation_id,
                        'draft': {
                            'draft_id': draft.pk,
                            'draft_updated_at': _timestamp(draft.updated_at),
                            'draft_semantic_hash': draft_hash,
                        },
                        'expected_draft_matches': token_matches,
                        'committed': {
                            'generation': body['committed_generation'],
                            'semantic_hash': body['committed_semantic_hash'],
                            'result': body['committed_result'],
                        },
                    }
                )
        except AnnotationDraft.DoesNotExist:
            return response({'error': {'code': 'fixture_draft_not_found'}}, status=404)

    root_urls = import_module(settings.ROOT_URLCONF)
    root_urls.urlpatterns.insert(0, path(LIFECYCLE_SEAM_PATH, task_lifecycle))
    clear_url_caches()


def _configure(data_dir: Path) -> None:
    os.environ.update(
        {
            'BASE_DATA_DIR': str(data_dir),
            'DJANGO_DB': 'sqlite',
            'DJANGO_SETTINGS_MODULE': 'core.settings.label_studio',
            'DEBUG': 'true',
            'COLLECT_ANALYTICS': 'false',
            'FEATURE_FLAGS_OFFLINE': 'true',
            'LATEST_VERSION_CHECK': 'false',
            'SENTRY_DSN': '',
            'FRONTEND_SENTRY_DSN': '',
            'SECRET_KEY': 'coordexp-browser-e2e-test-only-secret',
            'LOG_LEVEL': 'WARNING',
        }
    )
    sys.path.insert(0, str(COORDEXP_ROOT))
    sys.path.insert(0, str(REPO_ROOT / 'label_studio'))


def _seed() -> dict[str, object]:
    from django.contrib.auth import get_user_model
    from organizations.models import Organization, OrganizationMember
    from projects.models import Project
    from src.label_studio_coco_refinement.label_config import build_label_config
    from tasks.models import Annotation, Task

    user = get_user_model().objects.create_user(
        username=EMAIL,
        email=EMAIL,
        password=PASSWORD,
    )
    organization = Organization.objects.create(title='CoordExp browser E2E', created_by=user)
    OrganizationMember.objects.create(user=user, organization=organization)
    user.active_organization = organization
    user.save(update_fields=['active_organization'])
    project = Project.objects.create(
        title='CoordExp managed browser E2E',
        description=MANAGED_MARKER,
        organization=organization,
        created_by=user,
        is_published=True,
        label_config=build_label_config(),
        show_skip_button=False,
        enable_empty_annotation=True,
    )
    tasks = []
    annotations = []
    for ordinal, label in enumerate(('Task A', 'Task B'), start=1):
        task = Task.objects.create(
            project=project,
            inner_id=ordinal,
            data={
                'image': _image_data_url(label),
                'coordexp_task_key': f'train:{ordinal}',
                'split': 'train',
                'image_id': ordinal,
                'source_line': ordinal,
            },
            allow_skip=True,
            is_labeled=True,
            total_annotations=1,
        )
        annotation = Annotation.objects.create(
            task=task,
            project=project,
            completed_by=user,
            updated_by=user,
            result=_source_result(ordinal),
        )
        tasks.append(task.pk)
        annotations.append(annotation.pk)
    return {
        'email': EMAIL,
        'password': PASSWORD,
        'project_id': project.pk,
        'task_ids': tasks,
        'annotation_ids': annotations,
    }


def _readiness_line(seed: dict[str, object], *, port: int) -> str:
    payload = {
        'base_url': f'http://127.0.0.1:{port}',
        'project_id': seed['project_id'],
        'task_ids': seed['task_ids'],
        'annotation_ids': seed['annotation_ids'],
    }
    line = f'COORDEXP_BROWSER_E2E_READY {json.dumps(payload, sort_keys=True)}'

    # This line is commonly captured in CI/agent logs. Keep it an explicit
    # non-sensitive allowlist even though the in-process seed also contains
    # credentials needed by Cypress login.
    if PASSWORD in line or 'password' in line.lower():
        raise RuntimeError('browser E2E readiness output contains credentials')
    return line


def _serve(data_dir: Path, *, port: int, verbosity: int) -> None:
    _configure(data_dir)
    import django
    from django.core.management import call_command

    django.setup()
    call_command('migrate', interactive=False, verbosity=verbosity)
    _install_lifecycle_persistence_seam()
    seed = _seed()
    print(_readiness_line(seed, port=port), flush=True)
    call_command('runserver', f'127.0.0.1:{port}', use_reloader=False, verbosity=verbosity)


def main() -> None:
    args = _parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit('--port must be between 1 and 65535')
    if args.data_dir is not None:
        data_dir = args.data_dir.expanduser().resolve()
        data_dir.mkdir(parents=True, exist_ok=False)
        _serve(data_dir, port=args.port, verbosity=args.verbosity)
        return
    with tempfile.TemporaryDirectory(prefix='coordexp-browser-e2e-') as temporary:
        _serve(Path(temporary), port=args.port, verbosity=args.verbosity)


if __name__ == '__main__':
    main()

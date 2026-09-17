"""Serve the explicit CoordExp refinement runtime on a loopback bind."""

from __future__ import annotations

import ipaddress
import os
from pathlib import Path

from django.conf import settings
from coordexp_refinement.runtime_factory import (
    ProductionRuntimeFactory,
    RuntimeFactoryError,
)
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from organizations.models import Organization

AUTO_LOGIN_ENV = 'COORDEXP_AUTO_LOGIN_USER_ID'
AUTO_LOGIN_MIDDLEWARE = 'coordexp_refinement.middleware.CoordExpAutoLoginMiddleware'


class Command(BaseCommand):
    help = 'Apply/attest and serve the CoordExp refinement runtime on its configured loopback without autoreload.'

    def add_arguments(self, parser):
        parser.add_argument('--repo-root', required=True, type=Path)
        parser.add_argument('--operator-user-id', required=True, type=int)
        parser.add_argument('--organization-id', required=True, type=int)
        parser.add_argument('--roi-launch-config', required=True, type=Path)
        parser.add_argument('--chunk-size', type=int, default=500)
        parser.add_argument(
            '--auto-login',
            action='store_true',
            help='Automatically authenticate the operator for this loopback-only refinement service.',
        )

    def handle(self, *args, **options):
        if 'host' in options or 'port' in options:
            raise CommandError('host/port overrides are not supported; use --roi-launch-config')
        service = None
        previous_auto_login = os.environ.get(AUTO_LOGIN_ENV)
        auto_login_middleware_added = False
        try:
            user = get_user_model().objects.get(pk=options['operator_user_id'])
            organization = Organization.objects.get(pk=options['organization_id'])
            factory = ProductionRuntimeFactory(
                repo_root=options['repo_root'],
                roi_launch_config_path=options['roi_launch_config'],
                operator_user=user,
                organization=organization,
                chunk_size=options['chunk_size'],
            )
            service = factory.start()
            bind = service.roi_manager.config.bind
            host, port = bind.host, bind.port
            addrport, use_ipv6 = _django_runserver_bind(host, port)
            if options.get('auto_login'):
                os.environ[AUTO_LOGIN_ENV] = str(user.pk)
                if AUTO_LOGIN_MIDDLEWARE not in settings.MIDDLEWARE:
                    settings.MIDDLEWARE.append(AUTO_LOGIN_MIDDLEWARE)
                    auto_login_middleware_added = True
            else:
                os.environ.pop(AUTO_LOGIN_ENV, None)
            self.stdout.write(self.style.SUCCESS(f'CoordExp refinement runtime serving on http://{addrport}'))
            call_command(
                'runserver',
                addrport,
                use_reloader=False,
                use_ipv6=use_ipv6,
            )
        except (get_user_model().DoesNotExist, Organization.DoesNotExist) as exc:
            raise CommandError('operator user or organization does not exist') from exc
        except CommandError:
            raise
        except (RuntimeFactoryError, ValueError, TypeError) as exc:
            raise CommandError(str(exc)) from exc
        finally:
            if previous_auto_login is None:
                os.environ.pop(AUTO_LOGIN_ENV, None)
            else:
                os.environ[AUTO_LOGIN_ENV] = previous_auto_login
            if auto_login_middleware_added:
                settings.MIDDLEWARE.remove(AUTO_LOGIN_MIDDLEWARE)
            if service is not None:
                service.close()


def _django_runserver_bind(host, port) -> tuple[str, bool]:
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise CommandError('runtime returned an invalid loopback bind')
    if not isinstance(host, str) or not host or host != host.strip():
        raise CommandError('runtime returned an invalid loopback bind')

    if host.casefold() in {'localhost', 'localhost.'}:
        return f'localhost:{port}', False

    candidate = host[1:-1] if host.startswith('[') and host.endswith(']') else host
    if '%' in candidate:
        raise CommandError('runtime returned an invalid loopback bind')
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        raise CommandError('runtime returned an invalid loopback bind') from None
    if not address.is_loopback:
        raise CommandError('runtime returned an invalid loopback bind')
    if isinstance(address, ipaddress.IPv6Address):
        if address != ipaddress.IPv6Address('::1'):
            raise CommandError('runtime returned an invalid loopback bind')
        return f'[{address.compressed}]:{port}', True
    return f'{address}:{port}', False


__all__ = ['Command']

"""Serve the explicit CoordExp refinement runtime on IPv4 localhost only."""

from __future__ import annotations

from pathlib import Path

from coordexp_refinement.runtime_factory import (
    ProductionRuntimeFactory,
    RuntimeFactoryError,
)
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from organizations.models import Organization


class Command(BaseCommand):
    help = "Apply/attest and serve the CoordExp refinement runtime on 127.0.0.1 without Django autoreload."

    def add_arguments(self, parser):
        parser.add_argument("--repo-root", required=True, type=Path)
        parser.add_argument("--operator-user-id", required=True, type=int)
        parser.add_argument("--organization-id", required=True, type=int)
        parser.add_argument("--chunk-size", type=int, default=500)
        parser.add_argument("--host", default="127.0.0.1")
        parser.add_argument("--port", type=int, default=18083)

    def handle(self, *args, **options):
        host = _validate_host(options.get("host"))
        port = _validate_port(options.get("port"))
        service = None
        try:
            user = get_user_model().objects.get(pk=options["operator_user_id"])
            organization = Organization.objects.get(pk=options["organization_id"])
            factory = ProductionRuntimeFactory(
                repo_root=options["repo_root"],
                operator_user=user,
                organization=organization,
                chunk_size=options["chunk_size"],
            )
            service = factory.start()
            self.stdout.write(
                self.style.SUCCESS(
                    f"CoordExp refinement runtime serving on http://{host}:{port}"
                )
            )
            call_command(
                "runserver",
                f"{host}:{port}",
                use_reloader=False,
                use_ipv6=False,
            )
        except (get_user_model().DoesNotExist, Organization.DoesNotExist) as exc:
            raise CommandError("operator user or organization does not exist") from exc
        except CommandError:
            raise
        except (RuntimeFactoryError, ValueError, TypeError) as exc:
            raise CommandError(str(exc)) from exc
        finally:
            if service is not None:
                service.close()


def _validate_host(value) -> str:
    if value != "127.0.0.1":
        raise CommandError("host must be exactly 127.0.0.1")
    return value


def _validate_port(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise CommandError("port must be an integer from 1 through 65535")
    return value


__all__ = ["Command"]

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from coordexp_refinement.management.commands import serve_coordexp_refinement
from coordexp_refinement.runtime_factory import RuntimeFactoryError
from django.core.management.base import CommandError
from django.test import SimpleTestCase


class FakeManager:
    def __init__(self, value) -> None:
        self.value = value
        self.calls = []

    def get(self, **kwargs):
        self.calls.append(kwargs)
        return self.value


class FakeService:
    def __init__(self) -> None:
        self.closes = 0

    def close(self) -> None:
        self.closes += 1


class FakeFactory:
    instances = []
    service = FakeService()

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.starts = 0
        type(self).instances.append(self)

    def start(self):
        self.starts += 1
        return type(self).service


class ServeCommandTest(SimpleTestCase):
    def setUp(self) -> None:
        FakeFactory.instances.clear()
        FakeFactory.service = FakeService()
        self.user = SimpleNamespace(pk=7)
        self.organization = SimpleNamespace(pk=9)
        self.user_model = SimpleNamespace(
            objects=FakeManager(self.user),
            DoesNotExist=type("UserDoesNotExist", (Exception,), {}),
        )
        self.organization_model = SimpleNamespace(
            objects=FakeManager(self.organization),
            DoesNotExist=type("OrganizationDoesNotExist", (Exception,), {}),
        )

    def options(self, **updates):
        values = {
            "repo_root": Path("/data/CoordExp"),
            "operator_user_id": 7,
            "organization_id": 9,
            "chunk_size": 123,
            "host": "127.0.0.1",
            "port": 18083,
        }
        values.update(updates)
        return values

    def patches(self):
        return (
            patch.object(
                serve_coordexp_refinement,
                "get_user_model",
                return_value=self.user_model,
            ),
            patch.object(
                serve_coordexp_refinement, "Organization", self.organization_model
            ),
            patch.object(
                serve_coordexp_refinement, "ProductionRuntimeFactory", FakeFactory
            ),
        )

    def test_serves_exact_loopback_without_reloader_then_cleans_up(self) -> None:
        command = serve_coordexp_refinement.Command()
        user_patch, org_patch, factory_patch = self.patches()
        with (
            user_patch,
            org_patch,
            factory_patch,
            patch.object(serve_coordexp_refinement, "call_command") as runserver,
        ):
            command.handle(**self.options(port=19001))

        runserver.assert_called_once_with(
            "runserver",
            "127.0.0.1:19001",
            use_reloader=False,
            use_ipv6=False,
        )
        self.assertEqual(FakeFactory.instances[0].starts, 1)
        self.assertEqual(FakeFactory.service.closes, 1)
        self.assertEqual(
            FakeFactory.instances[0].kwargs["repo_root"], Path("/data/CoordExp")
        )

    def test_runserver_exception_still_closes_runtime(self) -> None:
        command = serve_coordexp_refinement.Command()
        user_patch, org_patch, factory_patch = self.patches()
        with (
            user_patch,
            org_patch,
            factory_patch,
            patch.object(
                serve_coordexp_refinement,
                "call_command",
                side_effect=RuntimeError("server failed"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "server failed"):
                command.handle(**self.options())
        self.assertEqual(FakeFactory.service.closes, 1)

    def test_worker_startup_failure_never_invokes_runserver(self) -> None:
        command = serve_coordexp_refinement.Command()
        user_patch, org_patch, factory_patch = self.patches()
        with (
            user_patch,
            org_patch,
            factory_patch,
            patch.object(
                FakeFactory,
                "start",
                side_effect=RuntimeFactoryError("train worker initial recovery failed"),
            ),
            patch.object(serve_coordexp_refinement, "call_command") as runserver,
        ):
            with self.assertRaisesRegex(
                CommandError, "train worker initial recovery failed"
            ):
                command.handle(**self.options())

        runserver.assert_not_called()
        self.assertEqual(FakeFactory.service.closes, 0)

    def test_non_loopback_host_is_rejected_before_factory_start(self) -> None:
        command = serve_coordexp_refinement.Command()
        with self.assertRaisesRegex(CommandError, "exactly 127.0.0.1"):
            command.handle(**self.options(host="0.0.0.0"))
        self.assertEqual(FakeFactory.instances, [])

    def test_port_validation_is_strict(self) -> None:
        command = serve_coordexp_refinement.Command()
        for value in (True, 0, 65536, "18083"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(CommandError, "port must be"):
                    command.handle(**self.options(port=value))

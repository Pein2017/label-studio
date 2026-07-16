from __future__ import annotations

import json
import shutil
from pathlib import Path
from tempfile import mkdtemp
from types import SimpleNamespace
from typing import Any

from coordexp_refinement.registry import ProjectRuntimeRegistry, RuntimeBindingError
from coordexp_refinement.runtime_factory import (
    ProductionRuntimeFactory,
    ProductionRuntimeService,
    RuntimeFactoryError,
)
from coordexp_refinement.transition_fence import (
    DraftTransitionFence,
    ProjectMutationBindingRegistry,
)
from django.test import SimpleTestCase
from src.label_studio_coco_refinement.runtime import RefinementRuntime


class FakeContract:
    def __init__(self) -> None:
        self.applied = False

    def plan_instance_bootstrap(self, desired, adapter):
        del adapter
        action = 'reuse' if self.applied else 'create'
        return SimpleNamespace(
            runtime_layout=next(iter(desired.values())).runtime_layout,
            projects=tuple(
                SimpleNamespace(
                    action=SimpleNamespace(value=action),
                    project=desired[split],
                )
                for split in ('train', 'val')
            ),
        )


class FakeAdapter:
    vendor_revision = 'vendor-revision'

    def __init__(self, *, manifest_path: Path, desired_manifest: dict[str, Any], **kwargs) -> None:
        self.init_kwargs = kwargs
        self.runtime_manifest_path = manifest_path
        self.desired_manifest = desired_manifest
        self.contract = FakeContract()
        self.apply_calls = 0
        self.attest_calls = 0

    def apply(self, plan) -> None:
        del plan
        self.apply_calls += 1
        self.contract.applied = True

    def attest_bootstrap_manifest(self):
        self.attest_calls += 1
        return self.desired_manifest


class FakeRuntime:
    def __init__(self, *, catalog=None, stores=None, project_ids=None, events=None) -> None:
        self.catalog = catalog
        self.stores = stores or {}
        self.project_ids = project_ids or {'train': '101', 'val': '102'}
        self.events = events
        self.starts = 0
        self.stops = 0
        self.fail_start = False
        self.fail_stop = False
        self.fail_recovery_split = None
        self.fail_after_initial_health_split = None
        self.recovering_split = None
        self.started_splits = []
        self.health_calls = {'train': 0, 'val': 0}

    def capture_and_enqueue(self, **kwargs):
        del kwargs

    def batch_status(self, **kwargs):
        del kwargs

    def start_workers(self, split=None) -> None:
        self.starts += 1
        self.started_splits.append(split)
        if self.events is not None:
            self.events.append(f'workers:start:{split}')
        if self.fail_start:
            raise RuntimeError('start failed')

    def worker_health(self, split=None):
        self.health_calls[split] += 1
        if self.events is not None:
            self.events.append(f'workers:health:{split}')
        if split == self.fail_recovery_split or (
            split == self.fail_after_initial_health_split and self.health_calls[split] >= 2
        ):
            return SimpleNamespace(
                healthy=False,
                state=SimpleNamespace(value='failed'),
                thread_alive=False,
                error='RecoveryError: fixture failure',
            )
        if split == self.recovering_split:
            return SimpleNamespace(
                healthy=False,
                state=SimpleNamespace(value='recovering'),
                thread_alive=True,
                error=None,
            )
        return SimpleNamespace(
            healthy=True,
            state=SimpleNamespace(value='idle'),
            thread_alive=True,
            error=None,
        )

    def stop_workers(self) -> None:
        self.stops += 1
        if self.events is not None:
            self.events.append('workers:stop')
        if self.fail_stop:
            raise RuntimeError('stop failed')


class FakeReceiptStore:
    def resolve(self, receipt_id):
        del receipt_id
        return None

    def response(self, receipt_id):
        del receipt_id
        return None


class FakeLaunchManager:
    def __init__(self, config_path, *, current_targets) -> None:
        self.config_path = Path(config_path)
        self.current_targets = current_targets
        self.receipt_store = FakeReceiptStore()
        self.inference_receipt_resolver = self.receipt_store
        self.closes = 0

    def resolve_selected_profile(self, **kwargs):
        del kwargs

    def current_profile(self, **kwargs):
        del kwargs

    def profile_options(self):
        return ()

    def infer(self, **kwargs):
        del kwargs

    def close(self):
        self.closes += 1


class FakeFinalizer:
    def __init__(self, *, targets, receipt_store, fence) -> None:
        self.targets = targets
        self.receipt_store = receipt_store
        self.fence = fence

    def preflight_draft_result(self, **kwargs):
        del kwargs
        return ()

    def finalize_inserted(self, **kwargs):
        del kwargs

    def finalize_abandoned(self, **kwargs):
        del kwargs


class RecordingRegistry(ProjectRuntimeRegistry):
    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.events = events

    def register(self, *, project_pk, split, runtime, services=None, replace=False):
        binding = super().register(
            project_pk=project_pk,
            split=split,
            runtime=runtime,
            services=services,
            replace=replace,
        )
        self.events.append(f'register:{split}')
        return binding

    def unregister(self, project_pk: int) -> None:
        self.events.append(f'unregister:{project_pk}')
        super().unregister(project_pk)


class FailingSecondRegistry(RecordingRegistry):
    def register(self, *, project_pk, split, runtime, services=None, replace=False):
        if split == 'val':
            self.events.append('register:val:failed')
            raise RuntimeError('registry fixture failure')
        return super().register(
            project_pk=project_pk,
            split=split,
            runtime=runtime,
            services=services,
            replace=replace,
        )


class RecordingMutationRegistry(ProjectMutationBindingRegistry):
    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.events = events

    def register(self, *, project_id, fence, finalizer):
        binding = super().register(
            project_id=project_id,
            fence=fence,
            finalizer=finalizer,
        )
        self.events.append(f'mutation:register:{project_id}')
        return binding

    def unregister(self, project_id, *, expected=None):
        self.events.append(f'mutation:unregister:{project_id}')
        return super().unregister(project_id, expected=expected)


class ImmediateRecoveryFailureStore:
    def recover(self):
        raise RuntimeError('actual worker recovery fixture failure')


class RuntimeFactoryTest(SimpleTestCase):
    def make_factory(self, tmp_path: Path, *, manifest_mutator=None):
        runtime_root = tmp_path / 'runtime'
        image_root = tmp_path / 'images'
        runtime_root.mkdir()
        image_root.mkdir()
        desired_manifest = {'dataset_name': 'exact-source'}
        manifest = _runtime_manifest(desired_manifest)
        if manifest_mutator is not None:
            manifest_mutator(manifest)
        manifest_path = tmp_path / 'bootstrap-manifest.json'
        manifest_path.write_bytes(_canonical_bytes(manifest))
        desired = {
            split: _planned_split(
                split=split,
                tmp_path=tmp_path,
                runtime_root=runtime_root,
                image_root=image_root,
            )
            for split in ('train', 'val')
        }
        adapters: list[FakeAdapter] = []

        def adapter_factory(**kwargs):
            adapter = FakeAdapter(
                manifest_path=manifest_path,
                desired_manifest=desired_manifest,
                **kwargs,
            )
            adapters.append(adapter)
            return adapter

        specs = []
        resolvers = []
        stores = {}

        def store_bootstrap(spec, **kwargs):
            specs.append(spec)
            resolvers.append(kwargs['inference_receipt_resolver'])
            store = SimpleNamespace(
                split=spec.split,
                inference_receipt_resolver=kwargs['inference_receipt_resolver'],
            )
            stores[spec.split] = store
            return SimpleNamespace(store=store)

        verifier_args = []

        def verifier_factory(project_ids):
            verifier_args.append(dict(project_ids))
            return SimpleNamespace(verify_batch=lambda request: True)

        catalog_args = []

        def catalog_factory(observed_stores, project_ids):
            catalog_args.append((dict(observed_stores), dict(project_ids)))
            return SimpleNamespace()

        registry = ProjectRuntimeRegistry()
        managers = []

        def launch_manager_factory(config_path, *, current_targets):
            manager = FakeLaunchManager(config_path, current_targets=current_targets)
            managers.append(manager)
            return manager

        fence = DraftTransitionFence()
        mutation_registry = ProjectMutationBindingRegistry()
        factory = ProductionRuntimeFactory(
            repo_root=tmp_path,
            roi_launch_config_path=tmp_path / 'roi-launch.json',
            operator_user=SimpleNamespace(pk=7),
            organization=SimpleNamespace(pk=9),
            registry=registry,
            mutation_registry=mutation_registry,
            transition_fence=fence,
            adapter_factory=adapter_factory,
            desired_builder=lambda *args, **kwargs: desired,
            store_bootstrap=store_bootstrap,
            verifier_factory=verifier_factory,
            catalog_factory=catalog_factory,
            runtime_factory=FakeRuntime,
            launch_manager_factory=launch_manager_factory,
            roi_binding_factory=lambda **kwargs: SimpleNamespace(**kwargs),
            roi_target_catalog_factory=lambda bindings: SimpleNamespace(
                bindings=bindings,
                current_target=lambda frozen: frozen,
            ),
            roi_finalizer_factory=FakeFinalizer,
            roi_services_factory=lambda **kwargs: SimpleNamespace(
                **kwargs,
                close_admission=lambda: None,
            ),
        )
        return SimpleNamespace(
            factory=factory,
            adapters=adapters,
            specs=specs,
            resolvers=resolvers,
            stores=stores,
            verifier_args=verifier_args,
            catalog_args=catalog_args,
            registry=registry,
            managers=managers,
            fence=fence,
            mutation_registry=mutation_registry,
        )

    def test_factory_uses_attested_manifest_ids_for_both_split_bindings(self) -> None:
        with self.settings(DEBUG=False):
            fixture = self.make_factory(self._tempdir())
            service = fixture.factory.build()

        self.assertEqual([spec.split for spec in fixture.specs], ['train', 'val'])
        self.assertEqual(
            [(spec.project_id, spec.storage_id) for spec in fixture.specs],
            [('101', '201'), ('102', '202')],
        )
        self.assertEqual(service.runtime.project_ids, {'train': '101', 'val': '102'})
        self.assertEqual(fixture.verifier_args, [{'train': 101, 'val': 102}])
        self.assertEqual(fixture.catalog_args[0][1], {'train': 101, 'val': 102})
        self.assertEqual(fixture.adapters[0].apply_calls, 1)
        self.assertEqual(fixture.adapters[0].attest_calls, 1)
        self.assertIsNone(fixture.resolvers[0].resolve('unknown-receipt'))

    def test_factory_rejects_store_missing_shared_receipt_resolver_attribute(self) -> None:
        fixture = self.make_factory(self._tempdir())

        def missing_resolver(spec, **kwargs):
            del kwargs
            return SimpleNamespace(store=SimpleNamespace(split=spec.split))

        fixture.factory.store_bootstrap = missing_resolver
        with self.assertRaisesRegex(RuntimeFactoryError, 'did not retain'):
            fixture.factory.build()

        self.assertEqual(fixture.managers[0].closes, 1)

    def test_start_registers_two_bindings_and_close_stops_then_unregisters(
        self,
    ) -> None:
        fixture = self.make_factory(self._tempdir())
        service = fixture.factory.start()

        self.assertEqual(service.runtime.starts, 2)
        self.assertEqual(service.runtime.started_splits, ['train', 'val'])
        self.assertEqual(fixture.registry.resolve(101).split, 'train')
        self.assertEqual(fixture.registry.resolve(102).split, 'val')

        service.close()
        self.assertEqual(service.runtime.stops, 1)
        with self.assertRaises(RuntimeBindingError):
            fixture.registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            fixture.registry.resolve(102)

    def test_lifecycle_order_stops_http_admission_before_workers(self) -> None:
        events: list[str] = []
        registry = RecordingRegistry(events)
        runtime = FakeRuntime(events=events)
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        service.start()
        service.close()

        self.assertEqual(
            events,
            [
                'workers:start:train',
                'workers:health:train',
                'workers:start:val',
                'workers:health:val',
                'workers:health:train',
                'workers:health:val',
                'register:train',
                'register:val',
                'unregister:102',
                'unregister:101',
                'workers:stop',
            ],
        )

    def test_worker_start_exception_still_stops_and_unregisters(self) -> None:
        registry = ProjectRuntimeRegistry()
        runtime = FakeRuntime()
        runtime.fail_start = True
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        with self.assertRaisesRegex(RuntimeFactoryError, 'runtime worker startup failed'):
            service.start()

        self.assertEqual(runtime.stops, 1)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(102)

    def test_roi_registration_and_close_order_uses_shared_identities(self) -> None:
        events: list[str] = []
        registry = RecordingRegistry(events)
        mutation_registry = RecordingMutationRegistry(events)
        fence = DraftTransitionFence()
        runtime = FakeRuntime(events=events)
        receipt_store = object()

        class Manager:
            def close(self):
                events.append('manager:close')

        manager = Manager()
        finalizer = FakeFinalizer(
            targets=object(),
            receipt_store=receipt_store,
            fence=fence,
        )
        services = SimpleNamespace(
            manager=manager,
            targets=object(),
            finalizer=finalizer,
            receipt_store=receipt_store,
            close_admission=lambda: events.append('services:close-admission'),
        )
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
            roi_manager=manager,
            roi_services=services,
            mutation_registry=mutation_registry,
            transition_fence=fence,
        )

        service.start()
        train = registry.resolve(101)
        val = registry.resolve(102)
        self.assertIs(train.services, services)
        self.assertIs(val.services, services)
        self.assertIs(train.services.receipt_store, receipt_store)
        service.close()
        service.close()

        self.assertEqual(
            events[-8:],
            [
                'register:val',
                'unregister:102',
                'unregister:101',
                'services:close-admission',
                'mutation:unregister:102',
                'mutation:unregister:101',
                'manager:close',
                'workers:stop',
            ],
        )

    def test_worker_must_still_be_healthy_at_registration_boundary(self) -> None:
        events: list[str] = []
        registry = RecordingRegistry(events)
        runtime = FakeRuntime(events=events)
        runtime.fail_after_initial_health_split = 'train'
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        with self.assertRaisesRegex(
            RuntimeFactoryError,
            'train worker became unhealthy before registration: RecoveryError: fixture failure',
        ):
            service.start()

        self.assertEqual(
            events,
            [
                'workers:start:train',
                'workers:health:train',
                'workers:start:val',
                'workers:health:val',
                'workers:health:train',
                'workers:stop',
            ],
        )
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)

    def test_startup_cleanup_failure_is_surfaced_without_registry_leak(self) -> None:
        registry = ProjectRuntimeRegistry()
        runtime = FakeRuntime()
        runtime.fail_start = True
        runtime.fail_stop = True
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        with self.assertRaisesRegex(RuntimeFactoryError, 'runtime startup cleanup failed'):
            service.start()

        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(102)

    def test_second_split_recovery_failure_stops_all_before_registration(self) -> None:
        events: list[str] = []
        registry = RecordingRegistry(events)
        runtime = FakeRuntime(events=events)
        runtime.fail_recovery_split = 'val'
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        with self.assertRaisesRegex(
            RuntimeFactoryError,
            'val worker initial recovery failed: RecoveryError: fixture failure',
        ):
            service.start()

        self.assertEqual(runtime.started_splits, ['train', 'val'])
        self.assertEqual(runtime.stops, 1)
        self.assertEqual(
            events,
            [
                'workers:start:train',
                'workers:health:train',
                'workers:start:val',
                'workers:health:val',
                'workers:stop',
            ],
        )
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(102)

    def test_actual_worker_recovery_failure_cannot_escape_startup_handshake(
        self,
    ) -> None:
        registry = ProjectRuntimeRegistry()
        runtime = RefinementRuntime(
            catalog=SimpleNamespace(),
            stores={
                'train': ImmediateRecoveryFailureStore(),
                'val': ImmediateRecoveryFailureStore(),
            },
            project_ids={'train': '101', 'val': '102'},
        )
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
            startup_timeout=1.0,
            health_poll_interval=0.001,
        )

        with self.assertRaisesRegex(
            RuntimeFactoryError,
            'train worker initial recovery failed: RuntimeError: actual worker recovery fixture failure',
        ):
            service.start()

        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(102)

    def test_initial_recovery_timeout_is_stable_and_cleans_up(self) -> None:
        registry = ProjectRuntimeRegistry()
        runtime = FakeRuntime()
        runtime.recovering_split = 'train'
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
            startup_timeout=0.001,
            health_poll_interval=0.001,
        )

        with self.assertRaisesRegex(RuntimeFactoryError, 'train worker initial recovery timed out'):
            service.start()
        self.assertEqual(runtime.started_splits, ['train'])
        self.assertEqual(runtime.stops, 1)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)

    def test_partial_registry_failure_stops_workers_and_unregisters_first_binding(
        self,
    ) -> None:
        events: list[str] = []
        registry = FailingSecondRegistry(events)
        runtime = FakeRuntime(events=events)
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )

        with self.assertRaisesRegex(RuntimeFactoryError, 'runtime worker startup failed'):
            service.start()

        self.assertEqual(
            events,
            [
                'workers:start:train',
                'workers:health:train',
                'workers:start:val',
                'workers:health:val',
                'workers:health:train',
                'workers:health:val',
                'register:train',
                'register:val:failed',
                'unregister:101',
                'workers:stop',
            ],
        )
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)

    def test_startup_timing_configuration_rejects_non_finite_values(self) -> None:
        for kwargs, message in (
            ({'startup_timeout': float('nan')}, 'startup timeout'),
            ({'startup_timeout': float('inf')}, 'startup timeout'),
            ({'health_poll_interval': float('nan')}, 'health poll interval'),
            ({'health_poll_interval': float('inf')}, 'health poll interval'),
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(RuntimeFactoryError, message):
                    ProductionRuntimeService(
                        runtime=FakeRuntime(),
                        project_pks={'train': 101, 'val': 102},
                        registry=ProjectRuntimeRegistry(),
                        **kwargs,
                    )

    def test_stop_exception_does_not_leak_registry_bindings(self) -> None:
        registry = ProjectRuntimeRegistry()
        runtime = FakeRuntime()
        service = ProductionRuntimeService(
            runtime=runtime,
            project_pks={'train': 101, 'val': 102},
            registry=registry,
        )
        service.start()
        runtime.fail_stop = True

        with self.assertRaisesRegex(RuntimeFactoryError, 'lifecycle cleanup failed'):
            service.close()

        with self.assertRaises(RuntimeBindingError):
            registry.resolve(101)
        with self.assertRaises(RuntimeBindingError):
            registry.resolve(102)

    def test_manifest_drift_fails_before_store_or_runtime_construction(self) -> None:
        fixture = self.make_factory(
            self._tempdir(),
            manifest_mutator=lambda manifest: manifest['projects']['val'].__setitem__('project_id', 101),
        )

        with self.assertRaisesRegex(RuntimeFactoryError, 'reuses project'):
            fixture.factory.build()
        self.assertEqual(fixture.specs, [])
        self.assertEqual(fixture.managers[0].closes, 1)

    def test_manager_receipt_authority_is_shared_by_both_stores_and_services(self) -> None:
        fixture = self.make_factory(self._tempdir())
        service = fixture.factory.build()

        receipt_store = fixture.managers[0].receipt_store
        self.assertIs(fixture.resolvers[0], receipt_store)
        self.assertIs(fixture.resolvers[1], receipt_store)
        self.assertIs(service.roi_services.receipt_store, receipt_store)
        self.assertIs(service.roi_services.finalizer.receipt_store, receipt_store)

    def _tempdir(self) -> Path:
        path = Path(mkdtemp(prefix='coordexp-runtime-factory-'))
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return path


def _planned_split(*, split: str, tmp_path: Path, runtime_root: Path, image_root: Path):
    source = tmp_path / f'{split}.norm.jsonl'
    source.write_text('{}\n', encoding='utf-8')
    layout = SimpleNamespace(root=runtime_root, image_root=image_root)
    return SimpleNamespace(
        split=split,
        runtime_layout=layout,
        source_inspection=SimpleNamespace(source_path=str(source), sha256=f'{split}-sha'),
        manifest=SimpleNamespace(
            adapter_version='adapter-v1',
            vendor_revision='vendor-revision',
            category_registry_fingerprint='registry-fp',
            label_config_fingerprint='config-fp',
            authoritative_annotation_policy_fingerprint='policy-fp',
            fingerprint=f'{split}-project-fp',
        ),
        task_manifest=SimpleNamespace(fingerprint=f'{split}-task-fp'),
        storage_manifest=SimpleNamespace(
            storage_subdirectory=f'{split}2017',
            fingerprint=f'{split}-storage-fp',
        ),
    )


def _runtime_manifest(desired_manifest: dict[str, Any]) -> dict[str, Any]:
    projects = {}
    for split, project_id, storage_id in (
        ('train', 101, 201),
        ('val', 102, 202),
    ):
        projects[split] = {
            'project_identity': f'project:{split}',
            'project_id': project_id,
            'created_by_id': 7,
            'storage_id': storage_id,
            'project_manifest': {'split': split},
            'storage_manifest': {'split': split},
            'controls': {},
        }
    return {
        'schema_version': 1,
        'organization_id': 9,
        'desired_manifest': desired_manifest,
        'projects': projects,
        'fingerprint': 'runtime-manifest-fingerprint',
    }


def _canonical_bytes(payload: Any) -> bytes:
    return (json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')

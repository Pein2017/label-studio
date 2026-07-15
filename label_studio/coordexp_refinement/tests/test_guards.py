"""Authenticated API coverage for managed Annotation entity write guards."""

from __future__ import annotations

from coordexp_refinement.bootstrap import (
    PROJECT_MARKER_PREFIX as BOOTSTRAP_MARKER_PREFIX,
)
from coordexp_refinement.guards import (
    PROJECT_MARKER_PREFIX,
    ManagedProjectWriteConflict,
    is_managed_refinement_project,
    reject_managed_data_manager_action,
)
from data_import.models import FileUpload
from django.contrib.auth import get_user_model
from django.test import TestCase
from io_storages.localfiles.models import (
    LocalFilesExportStorage,
    LocalFilesImportStorage,
)
from organizations.models import Organization, OrganizationMember
from projects.models import Project
from rest_framework.test import APIClient
from tasks.models import Annotation, AnnotationDraft, Prediction, Task, TaskLock

CONFLICT_PAYLOAD = {
    "error": {
        "code": "managed_annotation_write_blocked",
        "message": (
            "Managed refinement projects allow Draft edits only; use the "
            "refinement Commit action to publish dataset changes."
        ),
    }
}

PROJECT_CONFLICT_PAYLOAD = {
    "error": {
        "code": "managed_project_write_blocked",
        "message": (
            "Managed refinement projects are immutable outside Draft edits and "
            "the refinement Commit workflow."
        ),
    }
}


class ManagedAnnotationWriteGuardTests(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            email="operator@example.test",
            username="operator",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            title="CoordExp", created_by=self.user
        )
        OrganizationMember.objects.create(
            user=self.user, organization=self.organization
        )
        self.user.active_organization = self.organization
        self.user.save(update_fields=["active_organization"])
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        self.managed_project = self._project(
            "managed",
            f"{PROJECT_MARKER_PREFIX}coco-refinement:fixture:train",
        )
        self.managed_task, self.managed_annotation = self._task_and_annotation(
            self.managed_project
        )

    def _project(self, title: str, description: str) -> Project:
        return Project.objects.create(
            title=title,
            description=description,
            organization=self.organization,
            created_by=self.user,
            is_published=True,
            label_config='<View><Text name="text" value="$text"/></View>',
        )

    def _task_and_annotation(self, project: Project) -> tuple[Task, Annotation]:
        task = Task.objects.create(
            project=project,
            data={"text": f"task-{project.pk}"},
            allow_skip=True,
            is_labeled=True,
            total_annotations=1,
        )
        annotation = Annotation.objects.create(
            task=task,
            project=project,
            completed_by=self.user,
            updated_by=self.user,
            result=[],
        )
        return task, annotation

    def _managed_state(self) -> dict:
        return {
            "project": list(
                Project.objects.filter(pk=self.managed_project.pk)
                .values("id", "description", "updated_at")
                .order_by("id")
            ),
            "tasks": list(
                Task.objects.filter(project=self.managed_project)
                .values(
                    "id",
                    "data",
                    "is_labeled",
                    "total_annotations",
                    "cancelled_annotations",
                    "updated_at",
                )
                .order_by("id")
            ),
            "annotations": list(
                Annotation.objects.filter(task__project=self.managed_project)
                .values(
                    "id",
                    "task_id",
                    "project_id",
                    "result",
                    "was_cancelled",
                    "completed_by_id",
                    "updated_by_id",
                    "updated_at",
                )
                .order_by("id")
            ),
            "drafts": list(
                AnnotationDraft.objects.filter(task__project=self.managed_project)
                .values(
                    "id", "task_id", "annotation_id", "user_id", "result", "updated_at"
                )
                .order_by("id")
            ),
            "task_locks": list(
                TaskLock.objects.filter(task__project=self.managed_project)
                .values("id", "task_id", "user_id", "expire_at")
                .order_by("id")
            ),
            "file_uploads": list(
                FileUpload.objects.filter(project=self.managed_project)
                .values("id", "project_id", "user_id", "file")
                .order_by("id")
            ),
        }

    def _assert_managed_conflict(
        self, method: str, path: str, data: dict | None = None
    ) -> None:
        before = self._managed_state()
        response = getattr(self.client, method)(path, data=data or {}, format="json")
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(response.json(), CONFLICT_PAYLOAD)
        self.assertEqual(self._managed_state(), before)

    def _assert_managed_project_conflict(
        self, method: str, path: str, data: object | None = None
    ) -> None:
        before = self._managed_state()
        response = getattr(self.client, method)(path, data=data or {}, format="json")
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(response.json(), PROJECT_CONFLICT_PAYLOAD)
        self.assertEqual(self._managed_state(), before)

    def test_marker_is_exact_and_shared_with_bootstrap(self) -> None:
        self.assertEqual(PROJECT_MARKER_PREFIX, BOOTSTRAP_MARKER_PREFIX)
        self.assertTrue(is_managed_refinement_project(self.managed_project))
        for description in (
            f"x{PROJECT_MARKER_PREFIX}identity",
            f" {PROJECT_MARKER_PREFIX}identity",
            "coordexp-refinement-project-identity",
            None,
        ):
            with self.subTest(description=description):
                self.managed_project.description = description
                self.assertFalse(is_managed_refinement_project(self.managed_project))

    def test_all_native_managed_annotation_writes_conflict_without_mutation(
        self,
    ) -> None:
        task_path = f"/api/tasks/{self.managed_task.pk}/annotations/"
        annotation_path = f"/api/annotations/{self.managed_annotation.pk}/"
        convert_path = f"/api/annotations/{self.managed_annotation.pk}/convert-to-draft"
        cases = (
            ("post", task_path, {"task": self.managed_task.pk, "result": []}),
            (
                "post",
                f"{task_path}?was_cancelled=true",
                {"task": self.managed_task.pk, "result": [], "was_cancelled": True},
            ),
            ("put", annotation_path, {"task": self.managed_task.pk, "result": []}),
            ("patch", annotation_path, {"result": [{"id": "blocked"}]}),
            ("delete", annotation_path, None),
            ("post", convert_path, {}),
        )
        for method, path, data in cases:
            with self.subTest(method=method, path=path):
                self._assert_managed_conflict(method, path, data)

    def test_managed_annotation_gets_remain_available(self) -> None:
        before = self._managed_state()

        detail = self.client.get(f"/api/annotations/{self.managed_annotation.pk}/")
        listing = self.client.get(f"/api/tasks/{self.managed_task.pk}/annotations/")

        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual(detail.json()["id"], self.managed_annotation.pk)
        self.assertEqual(
            [item["id"] for item in listing.json()], [self.managed_annotation.pk]
        )
        self.assertEqual(self._managed_state(), before)

    def test_managed_task_entity_and_import_writes_are_blocked(self) -> None:
        cases = (
            (
                "post",
                "/api/tasks/",
                {"project": self.managed_project.pk, "data": {"text": "new"}},
            ),
            (
                "patch",
                f"/api/tasks/{self.managed_task.pk}/",
                {"data": {"text": "changed"}},
            ),
            (
                "put",
                f"/api/tasks/{self.managed_task.pk}/",
                {"data": {"text": "changed"}},
            ),
            ("delete", f"/api/tasks/{self.managed_task.pk}/", None),
            (
                "post",
                f"/api/projects/{self.managed_project.pk}/import",
                [{"text": "new"}],
            ),
            (
                "post",
                f"/api/projects/{self.managed_project.pk}/tasks/bulk/",
                [{"text": "new"}],
            ),
            (
                "post",
                f"/api/projects/{self.managed_project.pk}/reimport",
                {"file_upload_ids": []},
            ),
            (
                "post",
                f"/api/projects/{self.managed_project.pk}/import/predictions",
                [{"task": self.managed_task.pk, "result": []}],
            ),
            (
                "post",
                f"/api/projects/{self.managed_project.pk}/tasks/",
                {"data": {"text": "new"}},
            ),
            ("delete", f"/api/projects/{self.managed_project.pk}/tasks/", None),
            (
                "delete",
                f"/api/projects/{self.managed_project.pk}/model-versions/",
                {"model_version": "fixture"},
            ),
        )
        for method, path, data in cases:
            with self.subTest(method=method, path=path):
                self._assert_managed_project_conflict(method, path, data)

    def test_managed_project_identity_cannot_be_changed_or_deleted_via_api(
        self,
    ) -> None:
        detail = self.client.get(f"/api/projects/{self.managed_project.pk}/")
        self.assertEqual(detail.status_code, 200, detail.content)
        for method, data in (
            ("patch", {"description": "ordinary"}),
            (
                "put",
                {
                    "title": "replaced",
                    "description": "ordinary",
                    "label_config": '<View><Text name="text" value="$text"/></View>',
                },
            ),
            ("delete", None),
        ):
            with self.subTest(method=method):
                self._assert_managed_project_conflict(
                    method,
                    f"/api/projects/{self.managed_project.pk}/",
                    data,
                )

    def test_native_api_cannot_mint_managed_project_identity(self) -> None:
        forged_description = f"{PROJECT_MARKER_PREFIX}forged"
        create = self.client.post(
            "/api/projects/",
            data={
                "title": "forged-managed-project",
                "description": forged_description,
                "label_config": '<View><Text name="text" value="$text"/></View>',
            },
            format="json",
        )
        self.assertEqual(create.status_code, 409, create.content)
        self.assertEqual(create.json(), PROJECT_CONFLICT_PAYLOAD)
        self.assertFalse(
            Project.objects.filter(title="forged-managed-project").exists()
        )

        ordinary = self._project("ordinary-marker-target", "ordinary")
        patch = self.client.patch(
            f"/api/projects/{ordinary.pk}/",
            data={"description": forged_description},
            format="json",
        )
        self.assertEqual(patch.status_code, 409, patch.content)
        self.assertEqual(patch.json(), PROJECT_CONFLICT_PAYLOAD)
        ordinary.refresh_from_db()
        self.assertEqual(ordinary.description, "ordinary")

    def test_managed_import_storage_cannot_create_mutate_delete_or_sync(
        self,
    ) -> None:
        self._assert_managed_project_conflict(
            "post",
            "/api/storages/localfiles/",
            {"project": self.managed_project.pk, "path": "/tmp/blocked-storage"},
        )

        storage = LocalFilesImportStorage.objects.create(
            project=self.managed_project,
            path="/tmp/managed-storage",
        )
        detail = self.client.get(f"/api/storages/localfiles/{storage.pk}")
        self.assertEqual(detail.status_code, 200, detail.content)

        for method, path, data in (
            (
                "patch",
                f"/api/storages/localfiles/{storage.pk}",
                {"path": "/tmp/changed-storage"},
            ),
            (
                "put",
                f"/api/storages/localfiles/{storage.pk}",
                {
                    "project": self.managed_project.pk,
                    "path": "/tmp/changed-storage",
                },
            ),
            ("delete", f"/api/storages/localfiles/{storage.pk}", None),
            ("post", f"/api/storages/localfiles/{storage.pk}/sync", {}),
        ):
            with self.subTest(method=method, path=path):
                self._assert_managed_project_conflict(method, path, data)

        storage.refresh_from_db()
        self.assertEqual(storage.path, "/tmp/managed-storage")

    def test_managed_export_storage_cannot_create_mutate_delete_or_sync(
        self,
    ) -> None:
        self._assert_managed_project_conflict(
            "post",
            "/api/storages/export/localfiles",
            {"project": self.managed_project.pk, "path": "/tmp/blocked-export"},
        )

        storage = LocalFilesExportStorage.objects.create(
            project=self.managed_project,
            path="/tmp/managed-export",
        )
        detail = self.client.get(f"/api/storages/export/localfiles/{storage.pk}")
        self.assertEqual(detail.status_code, 200, detail.content)

        for method, path, data in (
            (
                "patch",
                f"/api/storages/export/localfiles/{storage.pk}",
                {"path": "/tmp/changed-export"},
            ),
            (
                "put",
                f"/api/storages/export/localfiles/{storage.pk}",
                {
                    "project": self.managed_project.pk,
                    "path": "/tmp/changed-export",
                },
            ),
            ("delete", f"/api/storages/export/localfiles/{storage.pk}", None),
            ("post", f"/api/storages/export/localfiles/{storage.pk}/sync", {}),
        ):
            with self.subTest(method=method, path=path):
                self._assert_managed_project_conflict(method, path, data)

        storage.refresh_from_db()
        self.assertEqual(storage.path, "/tmp/managed-export")

    def test_managed_prediction_entity_writes_are_blocked_but_reads_remain(
        self,
    ) -> None:
        self._assert_managed_project_conflict(
            "post",
            "/api/predictions/",
            {
                "task": self.managed_task.pk,
                "project": self.managed_project.pk,
                "result": [],
                "model_version": "new",
            },
        )
        prediction = Prediction.objects.create(
            task=self.managed_task,
            project=self.managed_project,
            result=[],
            model_version="fixture",
        )
        before = self._managed_state()
        detail = self.client.get(f"/api/predictions/{prediction.pk}/")
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(self._managed_state(), before)

        for method, data in (
            ("patch", {"result": [{"id": "changed"}]}),
            ("put", {"task": self.managed_task.pk, "result": []}),
            ("delete", None),
        ):
            with self.subTest(method=method):
                self._assert_managed_project_conflict(
                    method,
                    f"/api/predictions/{prediction.pk}/",
                    data,
                )
        self.assertTrue(Prediction.objects.filter(pk=prediction.pk).exists())

    def test_prediction_create_cannot_smuggle_managed_project_binding(self) -> None:
        ordinary = self._project("ordinary-prediction", "ordinary")
        ordinary_task, _ = self._task_and_annotation(ordinary)

        for task_id, project_id, model_version in (
            (ordinary_task.pk, self.managed_project.pk, "smuggled-project"),
            (self.managed_task.pk, ordinary.pk, "smuggled-task"),
        ):
            with self.subTest(task_id=task_id, project_id=project_id):
                self._assert_managed_project_conflict(
                    "post",
                    "/api/predictions/",
                    {
                        "task": task_id,
                        "project": project_id,
                        "result": [],
                        "model_version": model_version,
                    },
                )
        self.assertFalse(
            Prediction.objects.filter(model_version__startswith="smuggled").exists()
        )

    def test_managed_file_upload_mutations_are_blocked(self) -> None:
        self._assert_managed_project_conflict(
            "delete",
            f"/api/projects/{self.managed_project.pk}/file-uploads",
            {"file_upload_ids": []},
        )

        upload = FileUpload.objects.create(
            user=self.user,
            project=self.managed_project,
            file="managed-fixture.jsonl",
        )
        detail_path = f"/api/import/file-upload/{upload.pk}"
        detail = self.client.get(detail_path)
        self.assertEqual(detail.status_code, 200, detail.content)
        for method, data in (
            ("patch", {}),
            ("put", {}),
            ("delete", None),
        ):
            with self.subTest(method=method):
                self._assert_managed_project_conflict(method, detail_path, data)
        self.assertTrue(FileUpload.objects.filter(pk=upload.pk).exists())

    def test_managed_data_manager_mutations_are_blocked_before_action_execution(
        self,
    ) -> None:
        action_data = {"selectedItems": {"all": True, "excluded": []}}
        for action_id in (
            "delete_tasks",
            "delete_tasks_annotations",
            "delete_tasks_predictions",
            "retrieve_tasks_predictions",
            "predictions_to_annotations",
            "remove_duplicates",
            "add_data_field",
            "propagate_annotations",
            "rename_labels",
            "cache_labels",
        ):
            with self.subTest(action_id=action_id):
                self._assert_managed_project_conflict(
                    "post",
                    f"/api/dm/actions/?project={self.managed_project.pk}&id={action_id}",
                    action_data,
                )

    def test_managed_action_listing_and_safe_next_task_remain_read_only(self) -> None:
        eligible = Task.objects.create(
            project=self.managed_project,
            data={"text": "eligible-managed-task"},
            allow_skip=True,
            is_labeled=False,
            total_annotations=0,
        )
        before = self._managed_state()
        listing = self.client.get(f"/api/dm/actions/?project={self.managed_project.pk}")
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual(listing.json(), [])

        response = self.client.post(
            f"/api/dm/actions/?project={self.managed_project.pk}&id=next_task",
            data={"selectedItems": {"all": True, "excluded": []}},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["id"], eligible.pk)
        self.assertEqual(TaskLock.objects.filter(task=eligible).count(), 0)
        self.assertEqual(self._managed_state(), before)

        direct = self.client.get(f"/api/projects/{self.managed_project.pk}/next/")
        self.assertEqual(direct.status_code, 200, direct.content)
        self.assertEqual(direct.json()["id"], eligible.pk)
        self.assertEqual(TaskLock.objects.filter(task=eligible).count(), 0)
        self.assertEqual(self._managed_state(), before)

    def test_managed_project_summary_reset_is_blocked(self) -> None:
        self._assert_managed_project_conflict(
            "post",
            f"/api/projects/{self.managed_project.pk}/summary/reset/",
            {},
        )

    def test_action_execution_fails_closed_on_mixed_project_scope(self) -> None:
        ordinary = self._project("ordinary-mixed", "ordinary")
        ordinary_task, _ = self._task_and_annotation(ordinary)
        mixed = Task.objects.filter(pk__in=[self.managed_task.pk, ordinary_task.pk])

        for action_id in ("next_task", "delete_tasks"):
            with self.subTest(action_id=action_id):
                with self.assertRaises(ManagedProjectWriteConflict):
                    reject_managed_data_manager_action(
                        action_id,
                        self.managed_project,
                        mixed,
                    )

    def test_annotation_write_fails_closed_on_project_binding_drift(self) -> None:
        ordinary = self._project("ordinary-binding", "ordinary")
        self.managed_annotation.project = ordinary
        self.managed_annotation.save(update_fields=["project", "updated_at"])

        self._assert_managed_conflict(
            "patch",
            f"/api/annotations/{self.managed_annotation.pk}/",
            {"result": [{"id": "blocked"}]},
        )

    def test_ordinary_entities_cannot_be_reparented_into_managed_scope(self) -> None:
        ordinary = self._project("ordinary-reparent", "ordinary")
        ordinary_task, ordinary_annotation = self._task_and_annotation(ordinary)

        for method in ("patch", "put"):
            with self.subTest(entity="task", method=method):
                self._assert_managed_project_conflict(
                    method,
                    f"/api/tasks/{ordinary_task.pk}/",
                    {"project": self.managed_project.pk},
                )
            with self.subTest(entity="annotation_project", method=method):
                self._assert_managed_project_conflict(
                    method,
                    f"/api/annotations/{ordinary_annotation.pk}/",
                    {"project": self.managed_project.pk},
                )
            with self.subTest(entity="annotation_task", method=method):
                self._assert_managed_project_conflict(
                    method,
                    f"/api/annotations/{ordinary_annotation.pk}/",
                    {"task": self.managed_task.pk},
                )

        ordinary_task.refresh_from_db()
        ordinary_annotation.refresh_from_db()
        self.assertEqual(ordinary_task.project_id, ordinary.pk)
        self.assertEqual(ordinary_annotation.project_id, ordinary.pk)
        self.assertEqual(ordinary_annotation.task_id, ordinary_task.pk)

        for field, value, version in (
            ("project", self.managed_project.pk, "prediction-project-target"),
            ("task", self.managed_task.pk, "prediction-task-target"),
        ):
            prediction = Prediction.objects.create(
                task=ordinary_task,
                project=ordinary,
                result=[],
                model_version=version,
            )
            with self.subTest(entity="prediction", field=field):
                self._assert_managed_project_conflict(
                    "patch",
                    f"/api/predictions/{prediction.pk}/",
                    {field: value},
                )
            prediction.refresh_from_db()
            self.assertEqual(prediction.project_id, ordinary.pk)
            self.assertEqual(prediction.task_id, ordinary_task.pk)

        import_storage = LocalFilesImportStorage.objects.create(
            project=ordinary,
            path="/tmp/ordinary-import",
        )
        export_storage = LocalFilesExportStorage.objects.create(
            project=ordinary,
            path="/tmp/ordinary-export",
        )
        for entity, path, storage in (
            (
                "import_storage",
                f"/api/storages/localfiles/{import_storage.pk}",
                import_storage,
            ),
            (
                "export_storage",
                f"/api/storages/export/localfiles/{export_storage.pk}",
                export_storage,
            ),
        ):
            for method in ("patch", "put"):
                with self.subTest(entity=entity, method=method):
                    self._assert_managed_project_conflict(
                        method,
                        path,
                        {"project": self.managed_project.pk},
                    )
            storage.refresh_from_db()
            self.assertEqual(storage.project_id, ordinary.pk)

    def test_managed_draft_create_update_and_delete_remain_available(self) -> None:
        create = self.client.post(
            f"/api/tasks/{self.managed_task.pk}/annotations/{self.managed_annotation.pk}/drafts",
            data={"result": [], "lead_time": 1.25},
            format="json",
        )
        self.assertEqual(create.status_code, 201, create.content)
        draft_id = create.json()["id"]
        draft = AnnotationDraft.objects.get(pk=draft_id)
        self.assertEqual(draft.annotation_id, self.managed_annotation.pk)
        self.assertEqual(draft.user_id, self.user.pk)

        update = self.client.patch(
            f"/api/drafts/{draft_id}/",
            data={"result": [{"id": "draft-region"}]},
            format="json",
        )
        self.assertEqual(update.status_code, 200, update.content)
        draft.refresh_from_db()
        self.assertEqual(draft.result, [{"id": "draft-region"}])

        delete = self.client.delete(f"/api/drafts/{draft_id}/")
        self.assertEqual(delete.status_code, 204, delete.content)
        self.assertFalse(AnnotationDraft.objects.filter(pk=draft_id).exists())
        self.assertTrue(
            Annotation.objects.filter(pk=self.managed_annotation.pk).exists()
        )

    def test_ordinary_projects_keep_native_annotation_write_behavior(self) -> None:
        ordinary = self._project("ordinary", f"not-{PROJECT_MARKER_PREFIX}fixture")

        task, _ = self._task_and_annotation(ordinary)
        create = self.client.post(
            f"/api/tasks/{task.pk}/annotations/",
            data={"task": task.pk, "result": []},
            format="json",
        )
        self.assertEqual(create.status_code, 201, create.content)

        skip_task, _ = self._task_and_annotation(ordinary)
        skip = self.client.post(
            f"/api/tasks/{skip_task.pk}/annotations/?was_cancelled=true",
            data={"task": skip_task.pk, "result": [], "was_cancelled": True},
            format="json",
        )
        self.assertEqual(skip.status_code, 201, skip.content)
        self.assertTrue(Annotation.objects.get(pk=skip.json()["id"]).was_cancelled)

        put_task, put_annotation = self._task_and_annotation(ordinary)
        put = self.client.put(
            f"/api/annotations/{put_annotation.pk}/",
            data={"task": put_task.pk, "result": [{"id": "put"}]},
            format="json",
        )
        self.assertEqual(put.status_code, 200, put.content)
        put_annotation.refresh_from_db()
        self.assertEqual(put_annotation.result, [{"id": "put"}])

        patch_task, patch_annotation = self._task_and_annotation(ordinary)
        patch = self.client.patch(
            f"/api/annotations/{patch_annotation.pk}/",
            data={"result": [{"id": "patch"}]},
            format="json",
        )
        self.assertEqual(patch.status_code, 200, patch.content)
        patch_annotation.refresh_from_db()
        self.assertEqual(patch_annotation.result, [{"id": "patch"}])

        delete_task, delete_annotation = self._task_and_annotation(ordinary)
        delete = self.client.delete(f"/api/annotations/{delete_annotation.pk}/")
        self.assertEqual(delete.status_code, 204, delete.content)
        self.assertFalse(Annotation.objects.filter(pk=delete_annotation.pk).exists())
        self.assertTrue(Task.objects.filter(pk=delete_task.pk).exists())

        convert_task, convert_annotation = self._task_and_annotation(ordinary)
        convert = self.client.post(
            f"/api/annotations/{convert_annotation.pk}/convert-to-draft"
        )
        self.assertEqual(convert.status_code, 201, convert.content)
        self.assertFalse(Annotation.objects.filter(pk=convert_annotation.pk).exists())
        converted_draft = AnnotationDraft.objects.get(pk=convert.json()["id"])
        self.assertEqual(converted_draft.task_id, convert_task.pk)
        self.assertIsNone(converted_draft.annotation_id)

    def test_ordinary_projects_keep_task_and_action_write_behavior(self) -> None:
        ordinary = self._project("ordinary-task", "ordinary")
        task, annotation = self._task_and_annotation(ordinary)

        patch = self.client.patch(
            f"/api/tasks/{task.pk}/",
            data={"data": {"text": "ordinary-updated"}},
            format="json",
        )
        self.assertEqual(patch.status_code, 200, patch.content)

        action = self.client.post(
            f"/api/dm/actions/?project={ordinary.pk}&id=delete_tasks_annotations",
            data={"selectedItems": {"all": True, "excluded": []}},
            format="json",
        )
        self.assertEqual(action.status_code, 200, action.content)
        self.assertFalse(Annotation.objects.filter(pk=annotation.pk).exists())

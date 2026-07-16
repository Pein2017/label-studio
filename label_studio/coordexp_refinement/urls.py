from django.urls import path

from .api import (
    RefinementCommitAPI,
    RefinementProjectStateAPI,
    RefinementSessionAPI,
    RefinementStatusAPI,
    RefinementTaskLifecycleAPI,
    RoiAbandonAPI,
    RoiInferAPI,
    RoiProfilesAPI,
    json_csrf_protect,
)

app_name = 'coordexp_refinement'

commit_view = json_csrf_protect(RefinementCommitAPI.as_view())
roi_infer_view = json_csrf_protect(RoiInferAPI.as_view())
roi_abandon_view = json_csrf_protect(RoiAbandonAPI.as_view())
task_lifecycle_view = json_csrf_protect(RefinementTaskLifecycleAPI.as_view())

urlpatterns = [
    path(
        'api/projects/<int:pk>/coordexp-refinement/commit/',
        commit_view,
        name='commit',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/status/',
        RefinementStatusAPI.as_view(),
        name='status',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/session/',
        RefinementSessionAPI.as_view(),
        name='session',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/project-state/',
        RefinementProjectStateAPI.as_view(),
        name='project-state',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/task-lifecycle/',
        task_lifecycle_view,
        name='task-lifecycle',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/roi/profiles/',
        RoiProfilesAPI.as_view(),
        name='roi-profiles',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/roi/infer/',
        roi_infer_view,
        name='roi-infer',
    ),
    path(
        'api/projects/<int:pk>/coordexp-refinement/roi/abandon/',
        roi_abandon_view,
        name='roi-abandon',
    ),
]

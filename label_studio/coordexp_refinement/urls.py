from django.urls import path

from .api import RefinementCommitAPI, RefinementSessionAPI, RefinementStatusAPI, json_csrf_protect

app_name = 'coordexp_refinement'

commit_view = json_csrf_protect(RefinementCommitAPI.as_view())

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
]

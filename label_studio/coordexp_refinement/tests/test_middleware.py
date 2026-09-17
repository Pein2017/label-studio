from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth.models import AnonymousUser
from django.test import RequestFactory, SimpleTestCase

from coordexp_refinement.middleware import CoordExpAutoLoginMiddleware


class AutoLoginMiddlewareTest(SimpleTestCase):
    def test_disabled_by_default(self) -> None:
        request = RequestFactory().get('/projects/3/data/')
        request.user = AnonymousUser()
        response = object()
        with patch.dict('os.environ', {}, clear=True):
            self.assertIs(CoordExpAutoLoginMiddleware(lambda _: response)(request), response)

    def test_local_login_redirects_to_requested_page(self) -> None:
        request = RequestFactory().get('/user/login/?next=/projects/3/data/')
        request.user = AnonymousUser()
        user = SimpleNamespace(pk=1, is_active=True)
        manager = SimpleNamespace(get=lambda **kwargs: user)
        user_model = SimpleNamespace(objects=manager, DoesNotExist=type('DoesNotExist', (Exception,), {}))
        response = object()

        with (
            patch.dict('os.environ', {'COORDEXP_AUTO_LOGIN_USER_ID': '1'}, clear=True),
            patch('coordexp_refinement.middleware.get_user_model', return_value=user_model),
            patch('coordexp_refinement.middleware.login') as login,
        ):
            result = CoordExpAutoLoginMiddleware(lambda _: response)(request)

        login.assert_called_once_with(request, user, backend='django.contrib.auth.backends.ModelBackend')
        self.assertEqual(result.status_code, 302)
        self.assertEqual(result['Location'], '/projects/3/data/')

    def test_remote_client_does_not_get_auto_login(self) -> None:
        request = RequestFactory().get('/projects/3/data/')
        request.user = AnonymousUser()
        request.META['REMOTE_ADDR'] = '10.0.0.8'
        response = object()

        with (
            patch.dict('os.environ', {'COORDEXP_AUTO_LOGIN_USER_ID': '1'}, clear=True),
            patch('coordexp_refinement.middleware.login') as login,
        ):
            result = CoordExpAutoLoginMiddleware(lambda _: response)(request)

        login.assert_not_called()
        self.assertIs(result, response)

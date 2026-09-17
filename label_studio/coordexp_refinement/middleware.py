"""Loopback-only conveniences for the managed CoordExp refinement service."""

from __future__ import annotations

import logging
import os

from django.contrib.auth import get_user_model, login
from django.http import HttpResponse
from django.shortcuts import redirect
from django.utils.http import url_has_allowed_host_and_scheme

logger = logging.getLogger(__name__)
AUTO_LOGIN_ENV = 'COORDEXP_AUTO_LOGIN_USER_ID'


class CoordExpAutoLoginMiddleware:
    """Authenticate the configured operator only on a local refinement server."""

    LOOPBACK_CLIENTS = {'127.0.0.1', '::1'}

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user_id = os.environ.get(AUTO_LOGIN_ENV)
        if not user_id or request.META.get('REMOTE_ADDR') not in self.LOOPBACK_CLIENTS:
            return self.get_response(request)

        if getattr(request.user, 'is_authenticated', False):
            return self.get_response(request)

        try:
            user = get_user_model().objects.get(pk=int(user_id), is_active=True)
        except (TypeError, ValueError, get_user_model().DoesNotExist):
            logger.error('CoordExp auto-login operator is unavailable: %s', user_id)
            return HttpResponse('CoordExp auto-login operator is unavailable', status=503)

        login(request, user, backend='django.contrib.auth.backends.ModelBackend')
        if request.path_info == '/user/login/':
            target = request.GET.get('next') or '/'
            if not url_has_allowed_host_and_scheme(
                target,
                allowed_hosts={request.get_host()},
                require_https=request.is_secure(),
            ):
                target = '/'
            return redirect(target)
        return self.get_response(request)

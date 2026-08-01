"""Who the key is.

``/auth/me`` doubles as the oracle for a key's REACH: ``deps._enforce_project_scope``
rejects any route without a ``slug`` path parameter for a project-bound key, so a
200 means instance-wide and a 403 means fenced to one project.
"""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

ME = "/auth/me"

ENDPOINTS: tuple[tuple[str, str], ...] = (("get", ME),)


def get_me() -> ApiRequest:
    return ApiRequest("GET", ME)

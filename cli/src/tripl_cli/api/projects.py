"""Project discovery."""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

LIST = "/projects"
DETAIL = "/projects/{slug}"

ENDPOINTS: tuple[tuple[str, str], ...] = (("get", LIST), ("get", DETAIL))


def list_projects() -> ApiRequest:
    """Every project the key can see. 403 by design for a project-scoped key."""
    return ApiRequest("GET", LIST)


def get_project(slug: str) -> ApiRequest:
    return ApiRequest("GET", DETAIL.format(slug=slug))

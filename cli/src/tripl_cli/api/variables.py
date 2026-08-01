"""Documented ``${variable}`` placeholders and their observed values."""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

LIST = "/projects/{slug}/variables"
VALUES = "/projects/{slug}/variables/{variable_id}/values"
EVENT_OVERRIDES = "/projects/{slug}/variables/{variable_id}/event-overrides"

ENDPOINTS: tuple[tuple[str, str], ...] = (
    ("get", LIST),
    ("get", VALUES),
    ("get", EVENT_OVERRIDES),
)


def list_variables(
    slug: str, *, branch: str | None = None, offset: int | None = None, limit: int | None = None
) -> ApiRequest:
    """Paged: answers ``{items, total}``."""
    return ApiRequest(
        "GET",
        LIST.format(slug=slug),
        params={"branch": branch, "offset": offset, "limit": limit},
    )


def get_values(slug: str, variable_id: str, *, branch: str | None = None) -> ApiRequest:
    return ApiRequest(
        "GET", VALUES.format(slug=slug, variable_id=variable_id), params={"branch": branch}
    )


def get_event_overrides(slug: str, variable_id: str, *, branch: str | None = None) -> ApiRequest:
    return ApiRequest(
        "GET",
        EVENT_OVERRIDES.format(slug=slug, variable_id=variable_id),
        params={"branch": branch},
    )

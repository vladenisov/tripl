"""The event catalog."""

from __future__ import annotations

from typing import Any

from tripl_cli.api.request import ApiRequest

LIST = "/projects/{slug}/events"
DETAIL = "/projects/{slug}/events/{event_id}"

ENDPOINTS: tuple[tuple[str, str], ...] = (
    ("get", LIST),
    ("get", DETAIL),
    ("post", LIST),
    ("patch", DETAIL),
)


def list_events(
    slug: str,
    *,
    search: str | None = None,
    status: list[str] | None = None,
    tag: str | None = None,
    meta_value: str | None = None,
    event_type_id: str | None = None,
    silent_since_days: int | None = None,
    offset: int | None = None,
    limit: int | None = None,
    branch: str | None = None,
) -> ApiRequest:
    return ApiRequest(
        "GET",
        LIST.format(slug=slug),
        params={
            "search": search,
            "status": status,
            "tag": tag,
            "meta_value": meta_value,
            "event_type_id": event_type_id,
            "silent_since_days": silent_since_days,
            "offset": offset,
            "limit": limit,
            "branch": branch,
        },
    )


def get_event(slug: str, event_id: str, *, branch: str | None = None) -> ApiRequest:
    return ApiRequest("GET", DETAIL.format(slug=slug, event_id=event_id), params={"branch": branch})


def create_event(slug: str, body: Any, *, branch: str | None = None) -> ApiRequest:
    return ApiRequest("POST", LIST.format(slug=slug), params={"branch": branch}, json_body=body)


def update_event(slug: str, event_id: str, patch: Any, *, branch: str | None = None) -> ApiRequest:
    return ApiRequest(
        "PATCH",
        DETAIL.format(slug=slug, event_id=event_id),
        params={"branch": branch},
        json_body=patch,
    )

"""The event catalog.

No projection for ``EventListItemResponse``. Its ``field_values`` and
``meta_values`` are the whole content of an event, and a CLI writes to a pipe
rather than into a model's context window — so ``tripl events list --json``
carries a row verbatim, exactly as ``scans.list_jobs`` does. The MCP's
``EVENT_LIST_FIELDS`` is a statement about an AGENT's context budget and stays
where its one consumer is (tripl-i1dt revisits that).
"""

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

# EventStatus, verbatim from the OpenAPI document. Spelled here rather than in
# the argparse `choices=` so the CLI's accepted values and the values the route
# accepts are one list, pinned against backend/openapi.json by
# cli/tests/test_contract.py rather than by whoever last read the enum.
STATUSES: tuple[str, ...] = (
    "draft",
    "in_review",
    "ready_for_dev",
    "implemented",
    "live",
    "deprecated",
    "archived",
)

# The route's own bounds: `limit` is Query(ge=1, le=10000) with a server default
# of 200, `silent_since_days` is Query(ge=0, le=3650). Reproduced here so a bad
# value costs no request, and pinned to the OpenAPI document by the contract
# test so the two can never state different ceilings (the 40-vs-200 trap).
LIMIT_DEFAULT = 200
LIMIT_MAX = 10_000
SILENT_SINCE_DAYS_MAX = 3650


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
    """Paged: answers ``{items, total}``."""
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

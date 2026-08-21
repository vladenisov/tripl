"""Event catalog tools: list, fetch, create, update."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from tripl_cli.api import events, page_items, page_total, send

from tripl_mcp.runtime import client_for, ensure_branch_not_main, require_branch_id
from tripl_mcp.tools._common import (
    EVENT_LIST_FIELDS,
    READ_ONLY,
    WRITE,
    WRITE_UPDATE,
    trim,
    with_mutation_warnings,
)


async def list_events(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
    search: str | None = None,
    status: list[str] | None = None,
    tag: str | None = None,
    field_value: str | None = None,
    meta_value: str | None = None,
    event_type_id: str | None = None,
    silent_since_days: int | None = None,
    reviewed: bool | None = None,
    offset: int | None = None,
    limit: int | None = None,
    order_by: str | None = None,
    branch_id: str | None = None,
) -> dict[str, Any]:
    client = client_for(ctx)
    data = await send(
        client,
        events.list_events(
            slug,
            search=search,
            status=status,
            tag=tag,
            field_value=field_value,
            meta_value=meta_value,
            event_type_id=event_type_id,
            silent_since_days=silent_since_days,
            reviewed=reviewed,
            offset=offset,
            limit=limit,
            order_by=order_by,
            branch=branch_id,
        ),
    )
    # The TRIM is this consumer's context budget and stays here — `tripl events
    # list --json` carries the same rows verbatim, because a pipe pays no
    # per-token cost. The ENVELOPE is not: `{items, total}` is what the route
    # answers, so it is read through the shared layer both surfaces share
    # (tripl-i1dt).
    return {
        "items": [trim(item, EVENT_LIST_FIELDS) for item in page_items(data)],
        "total": page_total(data),
        "note": "Items are trimmed; use get_event for field/meta values and full detail.",
    }


async def get_event(
    slug: str,
    event_id: str,
    ctx: Context,  # type: ignore[type-arg]
    branch_id: str | None = None,
) -> Any:
    client = client_for(ctx)
    return await send(client, events.get_event(slug, event_id, branch=branch_id))


async def create_event(
    slug: str,
    branch_id: str | None,
    event_type_id: str,
    name: str,
    ctx: Context,  # type: ignore[type-arg]
    description: str | None = None,
    status: str | None = None,
    tags: list[str] | None = None,
    field_values: list[dict[str, Any]] | None = None,
    meta_values: list[dict[str, Any]] | None = None,
) -> Any:
    require_branch_id(branch_id)
    client = client_for(ctx)
    await ensure_branch_not_main(client, slug, branch_id)
    body: dict[str, Any] = {"event_type_id": event_type_id, "name": name}
    for key, value in (
        ("description", description),
        ("status", status),
        ("tags", tags),
        ("field_values", field_values),
        ("meta_values", meta_values),
    ):
        if value is not None:
            body[key] = value
    data = await send(client, events.create_event(slug, body, branch=branch_id))
    return with_mutation_warnings(data)


async def update_event(
    slug: str,
    event_id: str,
    branch_id: str | None,
    patch: dict[str, Any],
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    require_branch_id(branch_id)
    client = client_for(ctx)
    await ensure_branch_not_main(client, slug, branch_id)
    data = await send(client, events.update_event(slug, event_id, patch, branch=branch_id))
    return with_mutation_warnings(data)


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="list_events",
        annotations=READ_ONLY,
        description=(
            "List catalog events with structured filters (substring 'search' over "
            "name/description, repeatable lifecycle 'status' values draft/in_review/"
            "ready_for_dev/implemented/live/deprecated/archived, exact 'tag', "
            "substring 'field_value' e.g. a screen name, substring 'meta_value' "
            "e.g. a ticket key, 'event_type_id', 'silent_since_days', "
            "'reviewed' true/false). 'reviewed' is an axis of its own, not a "
            "spelling of 'status' - an event can be reviewed and still sit at "
            "in_review - and omitting it means either. "
            "'order_by' is 'catalog' (the authored order, and what omitting it "
            "gets) or 'volume' (busiest-first by ingested volume over the last "
            "24h) - use 'volume' to triage a large catalog by traffic. "
            "Returns trimmed items + total; follow up with get_event for full detail. "
            "Requires a tk_r_ or tk_w_ key."
        ),
    )(list_events)
    mcp.tool(
        name="get_event",
        annotations=READ_ONLY,
        description=(
            "Fetch one event's full canonical detail by id: field values, meta values, "
            "tags, lifecycle state, event type brief, and variable value contexts. "
            "Use after search_plan/list_events; treat the returned name/id as "
            "canonical. Requires a tk_r_ or tk_w_ key."
        ),
    )(get_event)
    mcp.tool(
        name="create_event",
        annotations=WRITE,
        description=(
            "WRITE: create an event (needs a tk_w_ key backed by an editor/owner). "
            "branch_id is REQUIRED so the draft lands on a working branch, never on "
            "the live main plan by accident (list_branches to find one). Read the "
            "response: when a scan naming rule governs the event type, the server "
            "derives the canonical name from field values and may ignore yours with "
            "a warning — adopt the returned name/id. Dry-run mindset: read the "
            "catalog first and prefer updating an existing event over creating a "
            "near-duplicate."
        ),
    )(create_event)
    mcp.tool(
        name="update_event",
        annotations=WRITE_UPDATE,
        description=(
            "WRITE: partially update an event (needs a tk_w_ key backed by an "
            "editor/owner). branch_id is REQUIRED to avoid accidental edits to the "
            "live main plan. 'patch' takes any subset of: name, description, status, "
            "sunset_at, owner_id, reviewed, metric_breakdown_columns, tags, "
            "field_values, meta_values. WARNING: 'field_values' and 'meta_values' "
            "are FULL-LIST REPLACEMENTS — sending a partial list deletes the missing "
            "entries. For narrow edits patch only description/name/tags/state. Read "
            "response warnings and adopt the server-canonical name/id."
        ),
    )(update_event)

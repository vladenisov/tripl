"""Plan structure tools: event types, fields, variables, projects."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from tripl_mcp.runtime import client_for
from tripl_mcp.tools._common import (
    EVENT_TYPE_LIST_FIELDS,
    FIELD_DEFINITION_FIELDS,
    READ_ONLY,
    trim,
)


async def list_event_types(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
    branch_id: str | None = None,
) -> Any:
    """List a project's event types on ``branch_id`` (default: main).

    Branch-scoped like every other plan read — without ``branch`` the API
    resolves main, so an agent working on a branch was silently answered with
    main's event types (tripl-jfm3.126). Field definitions are NOT embedded
    here; call ``get_event_type_fields`` for one type's fields.
    """
    client = client_for(ctx)
    data = await client.get(
        f"/projects/{slug}/event-types",
        params={"branch": branch_id},
    )
    if not isinstance(data, list):
        return data
    return [_event_type_summary(item) for item in data]


def _event_type_summary(item: Any) -> Any:
    """Trim one event type, passing anything unexpected through untouched."""
    if not isinstance(item, dict):
        return item
    return {
        **trim(item, EVENT_TYPE_LIST_FIELDS),
        "field_count": len(item.get("field_definitions") or []),
    }


async def get_event_type_fields(
    slug: str,
    event_type_id: str,
    ctx: Context,  # type: ignore[type-arg]
    branch_id: str | None = None,
) -> dict[str, Any]:
    client = client_for(ctx)
    params = {"branch": branch_id}
    event_type = await client.get(
        f"/projects/{slug}/event-types/{event_type_id}",
        params=params,
    )
    fields = await client.get(
        f"/projects/{slug}/event-types/{event_type_id}/fields",
        params=params,
    )
    merged = (
        dict(trim(event_type, EVENT_TYPE_LIST_FIELDS))
        if isinstance(event_type, dict)
        else {"event_type": event_type}
    )
    merged["fields"] = (
        [trim(field, FIELD_DEFINITION_FIELDS) for field in fields]
        if isinstance(fields, list)
        else fields
    )
    return merged


async def list_variables(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
    branch_id: str | None = None,
    offset: int = 0,
    limit: int = 200,
) -> Any:
    """List a project's variables.

    The endpoint is paged and answers ``{"items": [...], "total": n}``; pass
    ``offset``/``limit`` to walk a catalog larger than one page (a real project
    can carry well over a thousand variables).
    """
    client = client_for(ctx)
    return await client.get(
        f"/projects/{slug}/variables",
        params={"branch": branch_id, "offset": offset, "limit": limit},
    )


async def get_variable_values(
    slug: str,
    variable_id: str,
    ctx: Context,  # type: ignore[type-arg]
    branch_id: str | None = None,
) -> dict[str, Any]:
    client = client_for(ctx)
    values = await client.get(
        f"/projects/{slug}/variables/{variable_id}/values",
        params={"branch": branch_id},
    )
    overrides = await client.get(
        f"/projects/{slug}/variables/{variable_id}/event-overrides",
        params={"branch": branch_id},
    )
    return {"values": values, "event_overrides": overrides}


async def list_projects(
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.get("/projects")


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="list_event_types",
        annotations=READ_ONLY,
        description=(
            "List the project's event types (schemas events belong to) with a "
            "field_count each — field definitions are NOT embedded; call "
            "get_event_type_fields for one type's fields. Use before creating events "
            "to pick the right event_type_id. Pass branch_id to read a plan branch "
            "instead of main. Requires a tk_r_ or tk_w_ key."
        ),
    )(list_event_types)
    mcp.tool(
        name="get_event_type_fields",
        annotations=READ_ONLY,
        description=(
            "Fetch one event type merged with its field definitions (name, "
            "display_name, field_type, is_required, enum_options, sensitivity) under "
            "a 'fields' key. Consult this before writing field_values so payloads "
            "validate. Pass branch_id to read a plan branch instead of main. "
            "Requires a tk_r_ or tk_w_ key."
        ),
    )(get_event_type_fields)
    mcp.tool(
        name="list_variables",
        annotations=READ_ONLY,
        description=(
            "List the project's variables (documented ${variable} placeholders) with "
            "allowed_values, bindings, usage summaries and open drift counts. Paged: "
            "answers {items, total}; pass offset/limit to reach beyond the first "
            "page. Requires a tk_r_ or tk_w_ key."
        ),
    )(list_variables)
    mcp.tool(
        name="get_variable_values",
        annotations=READ_ONLY,
        description=(
            "Fetch one variable's observed per-event value contexts plus its "
            "event-level overrides (overrides replace the global documented list for "
            "their event). High-cardinality contexts return bounded samples with an "
            "observed count. Requires a tk_r_ or tk_w_ key."
        ),
    )(get_variable_values)
    mcp.tool(
        name="list_projects",
        annotations=READ_ONLY,
        description=(
            "List projects visible to the API key: [{slug, name, ...}]. NOTE: a "
            "project-scoped key (bound to one project) gets 403 here BY DESIGN — "
            "that is expected, not an error; use the project slug you were given "
            "instead. Requires a tk_r_ or tk_w_ key without project scoping."
        ),
    )(list_projects)

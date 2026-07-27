"""Plan structure tools: event types, fields, variables, projects."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from tripl_mcp.runtime import client_for
from tripl_mcp.tools._common import READ_ONLY


async def list_event_types(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.get(f"/projects/{slug}/event-types")


async def get_event_type_fields(
    slug: str,
    event_type_id: str,
    ctx: Context,  # type: ignore[type-arg]
) -> dict[str, Any]:
    client = client_for(ctx)
    event_type = await client.get(f"/projects/{slug}/event-types/{event_type_id}")
    fields = await client.get(f"/projects/{slug}/event-types/{event_type_id}/fields")
    merged = dict(event_type) if isinstance(event_type, dict) else {"event_type": event_type}
    merged["fields"] = fields
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
            "List the project's event types (schemas events belong to), each with its "
            "embedded field definitions. Use before creating events to pick the right "
            "event_type_id. Requires a tk_r_ or tk_w_ key."
        ),
    )(list_event_types)
    mcp.tool(
        name="get_event_type_fields",
        annotations=READ_ONLY,
        description=(
            "Fetch one event type merged with its field definitions (name, "
            "display_name, field_type, required, enum options) under a 'fields' key. "
            "Consult this before writing field_values so payloads validate. Requires "
            "a tk_r_ or tk_w_ key."
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

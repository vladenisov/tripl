"""Project search — the recommended entry point for any catalog question."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from tripl_cli.api import page_items, page_total, search, send

from tripl_mcp.runtime import client_for
from tripl_mcp.tools._common import READ_ONLY, SEARCH_RESULT_FIELDS, trim


async def search_plan(
    slug: str,
    q: str,
    ctx: Context,  # type: ignore[type-arg]
    types: list[str] | None = None,
    limit: int | None = None,
    branch_id: str | None = None,
) -> dict[str, Any]:
    client = client_for(ctx)
    data = await send(
        client, search.search_plan(slug, q, types=types, limit=limit, branch=branch_id)
    )
    # Same split as list_events: the trim is an agent context budget and stays,
    # the envelope belongs to the route. `semantic_used` moved with it — both
    # surfaces publish it and both had their own `.get` for it, and it now reads
    # False rather than null on a body that omits the key, which is what the
    # backend's `bool = False` default actually means (tripl-i1dt).
    return {
        "items": [trim(item, SEARCH_RESULT_FIELDS) for item in page_items(data)],
        "total": page_total(data),
        "semantic_used": search.semantic_used(data),
    }


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="search_plan",
        annotations=READ_ONLY,
        description=(
            "Search the tripl tracking plan with a natural-language phrase or partial "
            "event name. ALWAYS search first, then fetch the canonical entity by id "
            "(get_event etc.) before making decisions or edits. 'types' restricts to "
            "entity kinds, spelled the way a hit's entity_type is spelled — plan "
            "content (event, event_type, field, ...) and project configuration "
            "(scan_config, alert_rule) alike; an unfiltered search shows which kinds "
            "this plan holds. Each hit carries a confidence in [0,1]. "
            "Requires a tk_r_ or tk_w_ tripl API key."
        ),
    )(search_plan)

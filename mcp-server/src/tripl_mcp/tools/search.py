"""Project search — the recommended entry point for any catalog question."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

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
    data = await client.get(
        f"/projects/{slug}/search",
        params={"q": q, "types": types, "limit": limit, "branch": branch_id},
    )
    items = data.get("items", []) if isinstance(data, dict) else []
    return {
        "items": [trim(item, SEARCH_RESULT_FIELDS) for item in items],
        "total": data.get("total") if isinstance(data, dict) else None,
        "semantic_used": data.get("semantic_used") if isinstance(data, dict) else None,
    }


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="search_plan",
        annotations=READ_ONLY,
        description=(
            "Search the tripl tracking plan with a natural-language phrase or partial "
            "event name. ALWAYS search first, then fetch the canonical entity by id "
            "(get_event etc.) before making decisions or edits. 'types' restricts to "
            "entity kinds: event, event_type, field, meta_field, variable, relation, "
            "tag, metric, fact_table. Each hit carries a confidence in [0,1]. "
            "Requires a tk_r_ or tk_w_ tripl API key."
        ),
    )(search_plan)

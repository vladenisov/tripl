"""Plan branch tools: discovery and diff review (merge/revert are not exposed)."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from tripl_mcp.runtime import client_for
from tripl_mcp.tools._common import READ_ONLY


async def list_branches(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.get(f"/projects/{slug}/branches")


async def get_branch_diff(
    slug: str,
    branch_id: str,
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.get(f"/projects/{slug}/branches/{branch_id}/diff")


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="list_branches",
        annotations=READ_ONLY,
        description=(
            "List the project's plan branches: id, name, kind, status. Use a working "
            "branch id as branch_id on write tools so edits never land on the live "
            "main plan by accident. Requires a tk_r_ or tk_w_ key."
        ),
    )(list_branches)
    mcp.tool(
        name="get_branch_diff",
        annotations=READ_ONLY,
        description=(
            "Review what a working branch changed versus its base: one entry per "
            "changed entity with entity_type, kind (added/changed/removed), name, "
            "parent, entity_id and field_changes. Use to verify your edits before a "
            "human merges. Merging, reverting and branch transitions are NOT exposed "
            "through this MCP server — hand off to a human in the tripl UI. Requires "
            "a tk_r_ or tk_w_ key."
        ),
    )(get_branch_diff)

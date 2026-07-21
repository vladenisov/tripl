"""Warehouse scan tools: list configs, trigger runs, poll job status."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from tripl_mcp.runtime import client_for
from tripl_mcp.tools._common import READ_ONLY, WRITE, summarize_collection


async def list_scans(
    slug: str,
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.get(f"/projects/{slug}/scans")


async def trigger_scan(
    slug: str,
    scan_id: str,
    ctx: Context,  # type: ignore[type-arg]
) -> Any:
    client = client_for(ctx)
    return await client.post(f"/projects/{slug}/scans/{scan_id}/run")


async def get_scan_status(
    slug: str,
    scan_id: str,
    ctx: Context,  # type: ignore[type-arg]
    job_id: str | None = None,
) -> Any:
    client = client_for(ctx)
    if job_id is not None:
        return await client.get(f"/projects/{slug}/scans/{scan_id}/jobs/{job_id}")
    jobs = await client.get(f"/projects/{slug}/scans/{scan_id}/jobs")
    return summarize_collection(jobs)


def register(mcp: FastMCP) -> None:
    mcp.tool(
        name="list_scans",
        annotations=READ_ONLY,
        description=(
            "List the project's warehouse scan configurations (id, name, schedule, "
            "governed event types). Requires a tk_r_ or tk_w_ key."
        ),
    )(list_scans)
    mcp.tool(
        name="trigger_scan",
        annotations=WRITE,
        description=(
            "WRITE: trigger a warehouse scan run now (needs a tk_w_ key). Kicks off "
            "an async job — it does NOT edit the plan directly, but its results can "
            "update observed traffic and drift state. Poll progress with "
            "get_scan_status using the returned job id."
        ),
    )(trigger_scan)
    mcp.tool(
        name="get_scan_status",
        annotations=READ_ONLY,
        description=(
            "Check scan job status. With job_id: that job's detail. Without: recent "
            "jobs for the scan (count + latest sample). Requires a tk_r_ or tk_w_ "
            "key."
        ),
    )(get_scan_status)

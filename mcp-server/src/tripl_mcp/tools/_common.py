"""Shared helpers for tool implementations."""

from __future__ import annotations

from typing import Any

from mcp.types import ToolAnnotations

READ_ONLY = ToolAnnotations(readOnlyHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)
WRITE_UPDATE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False)

EVENT_LIST_FIELDS = (
    "id",
    "name",
    "description",
    "status",
    "reviewed",
    "event_type_id",
    "tags",
    "sunset_at",
    "owner_id",
)

SEARCH_RESULT_FIELDS = (
    "entity_type",
    "entity_id",
    "title",
    "subtitle",
    "description",
    "snippet",
    "route_path",
    "score",
    "confidence",
    "event_id",
    "name",
    "implemented",
)


def trim(item: Any, fields: tuple[str, ...]) -> Any:
    """Keep only ``fields`` of a dict item; pass anything else through."""
    if not isinstance(item, dict):
        return item
    return {k: item[k] for k in fields if k in item}


def summarize_collection(data: Any, sample_size: int = 10) -> dict[str, Any]:
    """Reduce a possibly-huge list / {items,total} payload to count + sample."""
    if isinstance(data, dict) and "items" in data:
        items = data.get("items") or []
        total = data.get("total", len(items))
        return {"total": total, "sample": items[:sample_size]}
    if isinstance(data, list):
        return {"total": len(data), "sample": data[:sample_size]}
    return {"data": data}

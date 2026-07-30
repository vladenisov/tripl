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

# An event type's own attributes, WITHOUT the embedded field_definitions: a
# project with 40 event types × 25 fields returns the entire field catalogue on
# every list call, which is the bulk of the payload and almost never what the
# caller is after at that point. get_event_type_fields fetches one type's fields
# on demand (tripl-jfm3.126).
EVENT_TYPE_LIST_FIELDS = (
    "id",
    "name",
    "display_name",
    "description",
    "color",
    "order",
)

# What an agent needs to write a valid field value. The contract_* thresholds are
# a data-quality concern for the scanner, not for composing a payload, and
# event_type_id repeats the parent.
FIELD_DEFINITION_FIELDS = (
    "id",
    "name",
    "display_name",
    "field_type",
    "is_required",
    "enum_options",
    "description",
    "order",
    "sensitivity",
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

"""The REST endpoints each MCP tool wraps.

Single source of truth for the contract test: every (method, path) here must
exist in ``backend/openapi.json``. Paths are relative to the ``/api/v1`` prefix
and use the backend's own placeholder names.
"""

from __future__ import annotations

TOOL_ENDPOINTS: dict[str, tuple[tuple[str, str], ...]] = {
    "search_plan": (("get", "/projects/{slug}/search"),),
    "list_events": (("get", "/projects/{slug}/events"),),
    "get_event": (("get", "/projects/{slug}/events/{event_id}"),),
    "create_event": (("post", "/projects/{slug}/events"),),
    "update_event": (("patch", "/projects/{slug}/events/{event_id}"),),
    "list_event_types": (("get", "/projects/{slug}/event-types"),),
    "get_event_type_fields": (
        ("get", "/projects/{slug}/event-types/{event_type_id}"),
        ("get", "/projects/{slug}/event-types/{event_type_id}/fields"),
    ),
    "list_variables": (("get", "/projects/{slug}/variables"),),
    "get_variable_values": (
        ("get", "/projects/{slug}/variables/{variable_id}/values"),
        ("get", "/projects/{slug}/variables/{variable_id}/event-overrides"),
    ),
    "list_branches": (("get", "/projects/{slug}/branches"),),
    "get_branch_diff": (("get", "/projects/{slug}/branches/{branch_id}/diff"),),
    "list_scans": (("get", "/projects/{slug}/scans"),),
    "trigger_scan": (("post", "/projects/{slug}/scans/{scan_id}/run"),),
    "get_scan_status": (
        ("get", "/projects/{slug}/scans/{scan_id}/jobs"),
        ("get", "/projects/{slug}/scans/{scan_id}/jobs/{job_id}"),
    ),
    "monitors_summary": (
        ("get", "/projects/{slug}/monitors-summary"),
        ("get", "/projects/{slug}/anomalies/signals"),
    ),
    "reconciliation_status": (
        ("get", "/projects/{slug}/reconciliation/coverage"),
        ("get", "/projects/{slug}/reconciliation/dead-events"),
        ("get", "/projects/{slug}/reconciliation/shadow-events"),
    ),
    "list_projects": (("get", "/projects"),),
}

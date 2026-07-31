"""Every REST endpoint the diagnostics read, in one place.

Single source of truth for the contract test: every (method, path) here must
exist in ``backend/openapi.json``. Paths are relative to the ``/api/v1`` prefix
and use the backend's own placeholder names - the same shape as
``tripl_mcp.contract.TOOL_ENDPOINTS``, deliberately, because the two packages
call the same API and a rename should break both loudly rather than one loudly
and the other silently.

``HEALTH_PATH`` is NOT here: it lives outside ``/api/v1`` and is declared
``include_in_schema=False``, so it is absent from the OpenAPI document by design
and cannot be checked against it. ``tests/test_doctor.py`` pins its location and
its unauthenticated-ness directly instead.
"""

from __future__ import annotations

# What each collector reads, keyed by the snapshot section it fills - so a
# contract failure names the check that would have gone blind, not just a URL.
DOCTOR_ENDPOINTS: dict[str, tuple[tuple[str, str], ...]] = {
    "auth": (("get", "/auth/me"),),
    "selection": (
        ("get", "/projects"),
        ("get", "/projects/{slug}"),
    ),
    "data_sources": (("get", "/data-sources"),),
    "scans": (("get", "/projects/{slug}/scans"),),
    "jobs": (("get", "/projects/{slug}/scans/{scan_id}/jobs"),),
    "event_types": (("get", "/projects/{slug}/event-types"),),
    "drifts": (("get", "/projects/{slug}/event-types/{event_type_id}/drifts"),),
}

STATUS_ENDPOINTS: dict[str, tuple[tuple[str, str], ...]] = {
    "selection": (
        ("get", "/projects"),
        ("get", "/projects/{slug}"),
    ),
    "coverage": (("get", "/projects/{slug}/reconciliation/coverage"),),
}

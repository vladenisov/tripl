from typing import Any

import pytest
from httpx import AsyncClient

from tripl.services.plan_revision_service import (
    _public_snapshot_payload,
    compute_plan_diff_entries,
)


async def _setup_project(client: AsyncClient, slug: str = "rev-proj"):
    await client.post("/api/v1/projects", json={"name": "R", "slug": slug})
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et_resp.json()["id"]
    f_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={
            "name": "screen",
            "display_name": "Screen",
            "field_type": "string",
            "is_required": True,
        },
    )
    field_id = f_resp.json()["id"]
    ev_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et_id,
            "name": "Home View",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    return et_id, field_id, ev_resp.json()["id"]


def test_public_snapshot_redacts_internal_merge_fingerprints() -> None:
    payload = {
        "events": [
            {
                "photos": [
                    {
                        "storage_key_fingerprint": "secret-hash",
                        "comments": [
                            {
                                "user_fingerprint": "user-hash",
                                "body_fingerprint": "body-hash",
                            }
                        ],
                    }
                ]
            }
        ]
    }

    public = _public_snapshot_payload(payload)

    photo = public["events"][0]["photos"][0]
    assert photo["storage_key_fingerprint"] == "<redacted>"
    assert photo["comments"][0] == {
        "user_fingerprint": "<redacted>",
        "body_fingerprint": "<redacted>",
    }
    assert payload["events"][0]["photos"][0]["storage_key_fingerprint"] == "secret-hash"


# --- snapshot version skew (tripl-avrs) -------------------------------------
# Branches frozen before the PLAN_SNAPSHOT_VERSION 2 bump hold v1 base payloads
# whose events lack source_name / owner_id / reviewed / metric_breakdown_columns /
# field_values / meta_values / tags / photos and whose variables lack
# excluded_from_scans and store event_value_overrides as a dict instead of a
# list. The diff must not report those missing keys as changes.


def _v1_event(name: str, *, description: str | None = None) -> dict[str, Any]:
    return {
        "id": f"v1-{name}",
        "event_type_id": "et-1",
        "event_type_name": "pv",
        "name": name,
        "description": description,
        "order": 0,
        "status": "draft",
        "sunset_at": None,
    }


def _v2_event(name: str, *, description: str | None = None) -> dict[str, Any]:
    return {
        "id": f"v2-{name}",
        "event_type_id": "et-1",
        "event_type_name": "pv",
        "name": name,
        "source_name": None,
        "description": description,
        "order": 0,
        "status": "draft",
        "sunset_at": None,
        "owner_id": None,
        "reviewed": False,
        "metric_breakdown_columns": [],
        "field_values": [],
        "meta_values": [],
        "tags": [],
        "photos": [],
    }


def _v1_variable(name: str) -> dict[str, Any]:
    return {
        "id": f"v1-var-{name}",
        "name": name,
        "source_name": None,
        "variable_type": "string",
        "description": None,
        "allowed_values": [],
        "bindings": [],
        "event_value_overrides": {},
    }


def _v2_variable(name: str) -> dict[str, Any]:
    return {
        "id": f"v2-var-{name}",
        "name": name,
        "source_name": None,
        "variable_type": "string",
        "description": None,
        "allowed_values": [],
        "bindings": [],
        "excluded_from_scans": False,
        "event_value_overrides": [],
    }


def _payload(
    version: int, events: list[dict[str, Any]], variables: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "snapshot_version": version,
        "event_types": [],
        "events": events,
        "variables": variables,
        "meta_fields": [],
        "relations": [],
    }


def test_diff_tolerates_v1_base_payload_missing_v2_keys() -> None:
    """A v1 base compared against a v2 snapshot must not flood "changed"."""
    v1_base = _payload(
        1,
        events=[_v1_event("Home View"), _v1_event("Checkout", description="pay")],
        variables=[_v1_variable("user_id")],
    )
    v2_snapshot = _payload(
        2,
        events=[
            _v2_event("Home View"),
            _v2_event("Checkout", description="pay"),
            _v2_event("Brand New"),
        ],
        variables=[_v2_variable("user_id")],
    )

    entries = compute_plan_diff_entries(v1_base, v2_snapshot)

    assert [(e.kind, e.entity_type, e.name) for e in entries] == [("added", "event", "Brand New")]


def test_diff_from_v1_base_still_reports_genuine_changes() -> None:
    v1_base = _payload(1, events=[_v1_event("Home View", description="old")], variables=[])
    v2_snapshot = _payload(2, events=[_v2_event("Home View", description="new")], variables=[])

    entries = compute_plan_diff_entries(v1_base, v2_snapshot)

    assert len(entries) == 1
    entry = entries[0]
    assert (entry.kind, entry.entity_type, entry.name) == ("changed", "event", "Home View")
    assert [fc.field for fc in entry.field_changes] == ["description"]
    assert any("description" in change for change in entry.changes)


@pytest.mark.asyncio
async def test_create_revision_captures_full_plan_snapshot(client: AsyncClient) -> None:
    et_id, _field_id, _event_id = await _setup_project(client, "rev-snap")
    resp = await client.post(
        "/api/v1/projects/rev-snap/revisions",
        json={"summary": "initial baseline"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["summary"] == "initial baseline"
    assert body["entity_counts"]["event_types"] == 1
    assert body["entity_counts"]["fields"] == 1
    assert body["entity_counts"]["events"] == 1

    payload = body["payload"]
    assert payload["event_types"][0]["id"] == et_id
    assert payload["event_types"][0]["field_definitions"][0]["name"] == "screen"
    assert payload["events"][0]["name"] == "Home View"


@pytest.mark.asyncio
async def test_list_revisions_orders_by_created_at_desc(client: AsyncClient) -> None:
    await _setup_project(client, "rev-list")
    for summary in ("first", "second", "third"):
        r = await client.post("/api/v1/projects/rev-list/revisions", json={"summary": summary})
        assert r.status_code == 201

    resp = await client.get("/api/v1/projects/rev-list/revisions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    summaries = [item["summary"] for item in body["items"]]
    assert summaries == ["third", "second", "first"]


@pytest.mark.asyncio
async def test_diff_reports_added_removed_and_changed_entities(
    client: AsyncClient,
) -> None:
    et_id, field_id, event_id = await _setup_project(client, "rev-diff")

    baseline = await client.post(
        "/api/v1/projects/rev-diff/revisions", json={"summary": "baseline"}
    )
    baseline_id = baseline.json()["id"]

    # Mutate the plan: add a new field, mark the event implemented,
    # delete the original field by removing it from the field_values payload
    # (the field itself stays; the diff is across declared schema).
    new_field = await client.post(
        f"/api/v1/projects/rev-diff/event-types/{et_id}/fields",
        json={
            "name": "platform",
            "display_name": "Platform",
            "field_type": "enum",
            "is_required": False,
            "enum_options": ["web", "ios", "android"],
        },
    )
    assert new_field.status_code == 201
    # Flip required → False AND tag the field as PII to drive a "changed"
    # entry covering both kinds of field-level edits.
    patch = await client.patch(
        f"/api/v1/projects/rev-diff/event-types/{et_id}/fields/{field_id}",
        json={"is_required": False, "sensitivity": "pii"},
    )
    assert patch.status_code == 200
    # Move the event through the lifecycle to drive an event-level change.
    ev_patch = await client.patch(
        f"/api/v1/projects/rev-diff/events/{event_id}",
        json={"status": "implemented"},
    )
    assert ev_patch.status_code == 200

    after = await client.post("/api/v1/projects/rev-diff/revisions", json={"summary": "after"})
    after_id = after.json()["id"]

    diff_resp = await client.get(
        f"/api/v1/projects/rev-diff/revisions/{after_id}/diff?compare_to={baseline_id}"
    )
    assert diff_resp.status_code == 200
    diff = diff_resp.json()

    kinds_by_name = {(entry["entity_type"], entry["name"]): entry for entry in diff["entries"]}
    assert kinds_by_name[("field_definition", "platform")]["kind"] == "added"
    assert kinds_by_name[("field_definition", "screen")]["kind"] == "changed"
    assert any(
        "is_required" in change
        for change in kinds_by_name[("field_definition", "screen")]["changes"]
    )
    assert any(
        "sensitivity" in change
        for change in kinds_by_name[("field_definition", "screen")]["changes"]
    )
    assert kinds_by_name[("event", "Home View")]["kind"] == "changed"
    assert any("status" in change for change in kinds_by_name[("event", "Home View")]["changes"])
    assert diff["summary"]["added"] >= 1
    assert diff["summary"]["changed"] >= 2

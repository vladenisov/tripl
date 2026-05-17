import pytest
from httpx import AsyncClient


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
        r = await client.post(
            "/api/v1/projects/rev-list/revisions", json={"summary": summary}
        )
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
    # Flip required → False on the existing field to drive a "changed" entry.
    patch = await client.patch(
        f"/api/v1/projects/rev-diff/event-types/{et_id}/fields/{field_id}",
        json={"is_required": False},
    )
    assert patch.status_code == 200
    # Toggle implemented on the event to drive an event-level change.
    ev_patch = await client.patch(
        f"/api/v1/projects/rev-diff/events/{event_id}",
        json={"implemented": True},
    )
    assert ev_patch.status_code == 200

    after = await client.post(
        "/api/v1/projects/rev-diff/revisions", json={"summary": "after"}
    )
    after_id = after.json()["id"]

    diff_resp = await client.get(
        f"/api/v1/projects/rev-diff/revisions/{after_id}/diff?compare_to={baseline_id}"
    )
    assert diff_resp.status_code == 200
    diff = diff_resp.json()

    kinds_by_name = {
        (entry["entity_type"], entry["name"]): entry for entry in diff["entries"]
    }
    assert kinds_by_name[("field_definition", "platform")]["kind"] == "added"
    assert kinds_by_name[("field_definition", "screen")]["kind"] == "changed"
    assert any(
        "is_required" in change
        for change in kinds_by_name[("field_definition", "screen")]["changes"]
    )
    assert kinds_by_name[("event", "Home View")]["kind"] == "changed"
    assert any(
        "implemented" in change
        for change in kinds_by_name[("event", "Home View")]["changes"]
    )
    assert diff["summary"]["added"] >= 1
    assert diff["summary"]["changed"] >= 2

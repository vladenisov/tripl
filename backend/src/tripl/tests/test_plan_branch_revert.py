"""Reverting one change in a plan branch (tripl-mzsb.2).

A revert restores the entity — or one field of it — to the branch's base
snapshot: the state the plan was in when the branch was opened. These tests
drive it through the API, since that is where the guards (branch status, missing
base, unsupported kinds) live.
"""

import uuid

import pytest
from httpx import AsyncClient


async def _seed(client: AsyncClient, slug: str) -> tuple[str, str, str]:
    """A project on main with one event type, one field and one event."""
    project = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert project.status_code == 201
    event_type = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    et_id = event_type.json()["id"]
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "currency", "display_name": "Currency", "field_type": "string"},
    )
    field_id = field.json()["id"]
    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et_id,
            "name": "purchase:success",
            "description": "on main",
            "field_values": [{"field_definition_id": field_id, "value": "USD"}],
        },
    )
    assert event.status_code == 201
    return et_id, field_id, event.json()["id"]


async def _branch(client: AsyncClient, slug: str, name: str = "feature") -> str:
    resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _branch_event(client: AsyncClient, slug: str, branch_id: str, name: str) -> dict:
    events = await client.get(f"/api/v1/projects/{slug}/events?branch={branch_id}")
    return next(e for e in events.json()["items"] if e["name"] == name)


async def _revert(client: AsyncClient, slug: str, branch_id: str, **body):
    return await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/revert", json=body)


async def _diff(client: AsyncClient, slug: str, branch_id: str) -> dict:
    resp = await client.get(f"/api/v1/projects/{slug}/branches/{branch_id}/diff")
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.asyncio
async def test_revert_undoes_one_field_and_leaves_the_others(client: AsyncClient) -> None:
    slug = "revert-field"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    edit = await client.patch(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}",
        json={"description": "edited on branch", "tags": ["revenue"]},
    )
    assert edit.status_code == 200
    diff = await _diff(client, slug, branch_id)
    assert {fc["field"] for fc in diff["entries"][0]["field_changes"]} == {"description", "tags"}

    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="event",
        name="purchase:success",
        parent="track",
        field="description",
    )
    assert resp.status_code == 200, resp.text

    # The response is the branch's diff after the revert: description is back to
    # its base value, the untouched edit survives.
    entries = resp.json()["entries"]
    assert [fc["field"] for fc in entries[0]["field_changes"]] == ["tags"]
    reverted = await _branch_event(client, slug, branch_id, "purchase:success")
    assert reverted["description"] == "on main"
    assert [tag["name"] for tag in reverted["tags"]] == ["revenue"]


@pytest.mark.asyncio
async def test_revert_without_a_field_restores_the_whole_entity(client: AsyncClient) -> None:
    slug = "revert-entity"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    branch_field_id = event["field_values"][0]["field_definition_id"]
    await client.patch(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}",
        json={
            "description": "edited",
            "tags": ["revenue"],
            "reviewed": True,
            "field_values": [{"field_definition_id": branch_field_id, "value": "EUR"}],
        },
    )

    resp = await _revert(
        client, slug, branch_id, entity_type="event", name="purchase:success", parent="track"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["summary"] == {"added": 0, "removed": 0, "changed": 0}
    assert resp.json()["entries"] == []


@pytest.mark.asyncio
async def test_revert_restores_a_changed_field_value(client: AsyncClient) -> None:
    """An event's field values are the change reviewers most often want to undo."""
    slug = "revert-values"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    branch_field_id = event["field_values"][0]["field_definition_id"]
    edit = await client.patch(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}",
        json={"field_values": [{"field_definition_id": branch_field_id, "value": "EUR"}]},
    )
    assert edit.status_code == 200

    diff = await _diff(client, slug, branch_id)
    change = next(fc for fc in diff["entries"][0]["field_changes"] if fc["field"] == "field_values")
    assert [(item["key"], item["kind"]) for item in change["items"]] == [("currency", "changed")]

    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="event",
        name="purchase:success",
        parent="track",
        field="field_values",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["entries"] == []
    restored = await _branch_event(client, slug, branch_id, "purchase:success")
    assert [fv["value"] for fv in restored["field_values"]] == ["USD"]


@pytest.mark.asyncio
async def test_revert_deletes_an_entity_the_branch_added(client: AsyncClient) -> None:
    slug = "revert-added"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event_types = await client.get(f"/api/v1/projects/{slug}/event-types?branch={branch_id}")
    branch_et_id = next(et["id"] for et in event_types.json() if et["name"] == "track")
    added = await client.post(
        f"/api/v1/projects/{slug}/events?branch={branch_id}",
        json={"event_type_id": branch_et_id, "name": "checkout:started"},
    )
    assert added.status_code == 201

    resp = await _revert(
        client, slug, branch_id, entity_type="event", name="checkout:started", parent="track"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["entries"] == []
    events = await client.get(f"/api/v1/projects/{slug}/events?branch={branch_id}")
    assert [e["name"] for e in events.json()["items"]] == ["purchase:success"]


@pytest.mark.asyncio
async def test_revert_rejects_a_single_field_of_an_added_entity(client: AsyncClient) -> None:
    slug = "revert-added-field"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event_types = await client.get(f"/api/v1/projects/{slug}/event-types?branch={branch_id}")
    branch_et_id = next(et["id"] for et in event_types.json() if et["name"] == "track")
    await client.post(
        f"/api/v1/projects/{slug}/events?branch={branch_id}",
        json={"event_type_id": branch_et_id, "name": "checkout:started"},
    )

    # An added entity has no base state, so there is no value to put back.
    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="event",
        name="checkout:started",
        parent="track",
        field="description",
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_revert_of_a_deleted_entity_is_refused_not_faked(client: AsyncClient) -> None:
    slug = "revert-removed"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    deleted = await client.delete(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}"
    )
    assert deleted.status_code == 204

    resp = await _revert(
        client, slug, branch_id, entity_type="event", name="purchase:success", parent="track"
    )
    assert resp.status_code == 409
    assert "not supported yet" in resp.json()["detail"]
    # The deletion is still in the diff — nothing was half-applied.
    assert (await _diff(client, slug, branch_id))["summary"]["removed"] == 1


@pytest.mark.asyncio
async def test_revert_rejects_a_change_that_is_not_in_the_diff(client: AsyncClient) -> None:
    slug = "revert-unknown"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    resp = await _revert(
        client, slug, branch_id, entity_type="event", name="purchase:success", parent="track"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_revert_rejects_an_unchanged_field(client: AsyncClient) -> None:
    slug = "revert-unchanged-field"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    await client.patch(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}",
        json={"description": "edited on branch"},
    )

    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="event",
        name="purchase:success",
        parent="track",
        field="source_name",
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_revert_rejects_a_merged_branch(client: AsyncClient) -> None:
    slug = "revert-merged"
    await _seed(client, slug)
    branch_id = await _branch(client, slug)

    event = await _branch_event(client, slug, branch_id, "purchase:success")
    await client.patch(
        f"/api/v1/projects/{slug}/events/{event['id']}?branch={branch_id}",
        json={"description": "edited on branch"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition", json={"action": "submit"}
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition", json={"action": "approve"}
    )
    merged = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merged.status_code == 200

    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="event",
        name="purchase:success",
        parent="track",
        field="description",
    )
    assert resp.status_code == 409
    assert "merged" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_revert_rejects_the_main_branch(client: AsyncClient) -> None:
    slug = "revert-main"
    await _seed(client, slug)
    branches = await client.get(f"/api/v1/projects/{slug}/branches")
    main_id = next(b for b in branches.json()["items"] if b["kind"] == "main")["id"]

    resp = await _revert(
        client, slug, main_id, entity_type="event", name="purchase:success", parent="track"
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_revert_rejects_an_unknown_branch(client: AsyncClient) -> None:
    slug = "revert-404"
    await _seed(client, slug)

    resp = await _revert(
        client,
        slug,
        str(uuid.uuid4()),
        entity_type="event",
        name="purchase:success",
        parent="track",
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_revert_restores_a_variables_documented_values(client: AsyncClient) -> None:
    slug = "revert-variable"
    await _seed(client, slug)
    created = await client.post(
        f"/api/v1/projects/{slug}/variables",
        json={"name": "currency", "variable_type": "string", "allowed_values": ["USD"]},
    )
    assert created.status_code == 201
    branch_id = await _branch(client, slug)

    variables = await client.get(f"/api/v1/projects/{slug}/variables?branch={branch_id}")
    branch_var = next(v for v in variables.json() if v["name"] == "currency")
    await client.patch(
        f"/api/v1/projects/{slug}/variables/{branch_var['id']}?branch={branch_id}",
        json={"allowed_values": ["USD", "EUR"]},
    )

    resp = await _revert(
        client,
        slug,
        branch_id,
        entity_type="variable",
        name="currency",
        field="allowed_values",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["entries"] == []
    variables = await client.get(f"/api/v1/projects/{slug}/variables?branch={branch_id}")
    restored = next(v for v in variables.json() if v["name"] == "currency")
    assert restored["allowed_values"] == ["USD"]

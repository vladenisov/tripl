"""API tests for variable value drift listing and actions."""

import uuid

import pytest
from httpx import AsyncClient

from tripl.models.variable import Variable
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.tests.conftest import TestSessionLocal


async def _seed(client: AsyncClient, slug: str) -> tuple[str, str]:
    """Project + event type + event + variable with documented values."""
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et.json()["id"], "name": "Onboarding"},
    )
    variable = await client.post(
        f"/api/v1/projects/{slug}/variables",
        json={"name": "variant", "allowed_values": ["a", "b"]},
    )
    return variable.json()["id"], event.json()["id"]


async def _insert_drift(variable_id: str, event_id: str, observed: list[str]) -> str:
    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, uuid.UUID(variable_id))
        drift = VariableValueDrift(
            project_id=variable.project_id,
            variable_id=uuid.UUID(variable_id),
            event_id=uuid.UUID(event_id),
            observed_values=observed,
        )
        session.add(drift)
    return str(drift.id)


@pytest.mark.asyncio
async def test_list_value_drifts_and_open_count(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-list")
    await _insert_drift(var_id, event_id, ["x", "y"])

    resp = await client.get("/api/v1/projects/vvd-list/variables/drifts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["variable_name"] == "variant"
    assert item["event_name"] == "Onboarding"
    assert item["observed_values"] == ["x", "y"]
    assert item["status"] == "open"

    filtered = await client.get(f"/api/v1/projects/vvd-list/variables/drifts?variable_id={var_id}")
    assert filtered.json()["total"] == 1
    other = await client.get(
        f"/api/v1/projects/vvd-list/variables/drifts?variable_id={uuid.uuid4()}"
    )
    assert other.json()["total"] == 0

    variables = await client.get("/api/v1/projects/vvd-list/variables")
    assert variables.json()["items"][0]["open_drift_count"] == 1


@pytest.mark.asyncio
async def test_accept_global_appends_to_allowed_values(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-accept")
    drift_id = await _insert_drift(var_id, event_id, ["x"])

    resp = await client.post(
        f"/api/v1/projects/vvd-accept/variables/drifts/{drift_id}/action",
        json={"action": "accept", "scope": "global"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"

    variables = await client.get("/api/v1/projects/vvd-accept/variables")
    var = variables.json()["items"][0]
    assert var["allowed_values"] == ["a", "b", "x"]
    # Accepted drift no longer counts as open.
    assert var["open_drift_count"] == 0


@pytest.mark.asyncio
async def test_accept_event_scope_seeds_override(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-accept-ev")
    drift_id = await _insert_drift(var_id, event_id, ["x"])

    resp = await client.post(
        f"/api/v1/projects/vvd-accept-ev/variables/drifts/{drift_id}/action",
        json={"action": "accept", "scope": "event"},
    )
    assert resp.status_code == 200

    # Global list untouched; the override is seeded from it plus the novel value.
    variables = await client.get("/api/v1/projects/vvd-accept-ev/variables")
    assert variables.json()["items"][0]["allowed_values"] == ["a", "b"]
    overrides = await client.get(
        f"/api/v1/projects/vvd-accept-ev/variables/{var_id}/event-overrides"
    )
    assert len(overrides.json()) == 1
    assert overrides.json()[0]["values"] == ["a", "b", "x"]


@pytest.mark.asyncio
async def test_snooze_requires_until_then_resolve_and_reopen(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-snooze")
    drift_id = await _insert_drift(var_id, event_id, ["x"])

    missing = await client.post(
        f"/api/v1/projects/vvd-snooze/variables/drifts/{drift_id}/action",
        json={"action": "snooze"},
    )
    assert missing.status_code == 422

    snoozed = await client.post(
        f"/api/v1/projects/vvd-snooze/variables/drifts/{drift_id}/action",
        json={"action": "snooze", "snoozed_until": "2030-01-01T00:00:00Z"},
    )
    assert snoozed.status_code == 200
    assert snoozed.json()["status"] == "snoozed"
    variables = await client.get("/api/v1/projects/vvd-snooze/variables")
    # Snoozed into the future -> not open.
    assert variables.json()["items"][0]["open_drift_count"] == 0

    fp = await client.post(
        f"/api/v1/projects/vvd-snooze/variables/drifts/{drift_id}/action",
        json={"action": "false_positive", "note": "test data"},
    )
    assert fp.status_code == 200
    assert fp.json()["status"] == "false_positive"
    assert fp.json()["resolution_note"] == "test data"

    reopened = await client.post(
        f"/api/v1/projects/vvd-snooze/variables/drifts/{drift_id}/action",
        json={"action": "reopen"},
    )
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "open"


@pytest.mark.asyncio
async def test_drift_action_scoped_to_project(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-scope-a")
    drift_id = await _insert_drift(var_id, event_id, ["x"])
    await client.post("/api/v1/projects", json={"name": "vvd-scope-b", "slug": "vvd-scope-b"})

    resp = await client.post(
        f"/api/v1/projects/vvd-scope-b/variables/drifts/{drift_id}/action",
        json={"action": "reopen"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_value_drifts_filters_by_event(client: AsyncClient):
    var_id, event_id = await _seed(client, "vvd-evfilter")
    await _insert_drift(var_id, event_id, ["x"])

    hit = await client.get(f"/api/v1/projects/vvd-evfilter/variables/drifts?event_id={event_id}")
    assert hit.json()["total"] == 1
    miss = await client.get(
        f"/api/v1/projects/vvd-evfilter/variables/drifts?event_id={uuid.uuid4()}"
    )
    assert miss.json()["total"] == 0

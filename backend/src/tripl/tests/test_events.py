import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from tripl.main import app
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_change import create_event_change
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.search_document import SearchDocument
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.tests.conftest import TestSessionLocal


async def _setup_events(client: AsyncClient, slug: str = "ev-proj"):
    await client.post("/api/v1/projects", json={"name": "E", "slug": slug})
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
    await client.post(
        f"/api/v1/projects/{slug}/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "url"},
    )
    meta_resp = await client.get(f"/api/v1/projects/{slug}/meta-fields")
    meta_id = meta_resp.json()[0]["id"]
    return et_id, field_id, meta_id


def test_create_event_change_sets_timestamps_before_flush():
    event_id = uuid.uuid4()
    user_id = uuid.uuid4()

    change = create_event_change(
        event_id=event_id,
        user_id=user_id,
        field="description",
        old_value="old",
        new_value="new",
    )

    assert change.event_id == event_id
    assert change.user_id == user_id
    assert change.created_at is not None
    assert change.updated_at == change.created_at
    assert change.created_at.tzinfo is UTC


@pytest.mark.asyncio
async def test_create_event(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client)
    resp = await client.post(
        "/api/v1/projects/ev-proj/events",
        json={
            "event_type_id": et_id,
            "name": "Home Page View",
            "metric_breakdown_columns": ["country", "country", " platform "],
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
            "meta_values": [
                {"meta_field_definition_id": meta_id, "value": "https://jira.example.com/TICK-1"}
            ],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Home Page View"
    assert data["order"] == 0
    assert data["metric_breakdown_columns"] == ["country", "platform"]
    assert len(data["field_values"]) == 1
    assert len(data["meta_values"]) == 1


@pytest.mark.asyncio
async def test_user_authored_field_values_are_marked_on_create_and_update(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-authored-values")
    create_response = await client.post(
        "/api/v1/projects/ev-authored-values/events",
        json={
            "event_type_id": et_id,
            "name": "Home Page View",
            "field_values": [{"field_definition_id": field_id, "value": "${variant}"}],
        },
    )
    assert create_response.status_code == 201
    event_id = uuid.UUID(create_response.json()["id"])
    field_definition_id = uuid.UUID(field_id)

    async with TestSessionLocal() as session:
        created_value = (
            await session.execute(
                select(EventFieldValue).where(
                    EventFieldValue.event_id == event_id,
                    EventFieldValue.field_definition_id == field_definition_id,
                )
            )
        ).scalar_one()
    assert created_value.is_authored is True

    update_response = await client.patch(
        f"/api/v1/projects/ev-authored-values/events/{event_id}",
        json={"field_values": [{"field_definition_id": field_id, "value": "${experiment}"}]},
    )
    assert update_response.status_code == 200

    async with TestSessionLocal() as session:
        updated_value = (
            await session.execute(
                select(EventFieldValue).where(
                    EventFieldValue.event_id == event_id,
                    EventFieldValue.field_definition_id == field_definition_id,
                )
            )
        ).scalar_one()
    assert updated_value.value == "${experiment}"
    assert updated_value.is_authored is True


@pytest.mark.asyncio
async def test_event_mutations_warn_for_unknown_template_tokens(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-template-warnings")
    variable_response = await client.post(
        "/api/v1/projects/ev-template-warnings/variables",
        json={"name": "variant", "bindings": ["payload.variant"]},
    )
    assert variable_response.status_code == 201

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, uuid.UUID(variable_response.json()["id"]))
        assert variable is not None
        variable.source_name = "legacy.variant"

    create_response = await client.post(
        "/api/v1/projects/ev-template-warnings/events",
        json={
            "event_type_id": et_id,
            "name": "Checkout",
            "field_values": [
                {
                    "field_definition_id": field_id,
                    "value": "${variant}:${legacy.variant}:${payload.variant}"
                    ":${missing}:${missing}",
                }
            ],
            "meta_values": [{"meta_field_definition_id": meta_id, "value": "${variant}"}],
        },
    )
    assert create_response.status_code == 201
    assert create_response.json()["warnings"] == ["Unknown variable token: ${missing}"]

    event_id = create_response.json()["id"]
    update_response = await client.patch(
        f"/api/v1/projects/ev-template-warnings/events/{event_id}",
        json={
            "field_values": [{"field_definition_id": field_id, "value": "${unknown_after_update}"}],
            "meta_values": [{"meta_field_definition_id": meta_id, "value": "literal ${"}],
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["warnings"] == ["Unknown variable token: ${unknown_after_update}"]


@pytest.mark.asyncio
async def test_event_responses_include_variable_value_contexts(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-var-values")
    variable_resp = await client.post(
        "/api/v1/projects/ev-var-values/variables",
        json={"name": "user_id", "variable_type": "string"},
    )
    event_resp = await client.post(
        "/api/v1/projects/ev-var-values/events",
        json={
            "event_type_id": et_id,
            "name": "Profile View",
            "field_values": [{"field_definition_id": field_id, "value": "${user_id}"}],
        },
    )
    assert event_resp.status_code == 201
    variable_id = uuid.UUID(variable_resp.json()["id"])
    event_id = uuid.UUID(event_resp.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        event = await session.get(Event, event_id)
        assert variable is not None
        assert event is not None
        session.add(
            VariableValue(
                project_id=variable.project_id,
                branch_id=variable.branch_id,
                variable_id=variable.id,
                event_id=event.id,
                field_definition_id=uuid.UUID(field_id),
                source_column="user_id",
                value_kind="low",
                observed_count=2,
                values=["u1", "u2"],
            )
        )

    list_resp = await client.get("/api/v1/projects/ev-var-values/events")
    assert list_resp.status_code == 200
    field_contexts = list_resp.json()["items"][0]["field_values"][0]["variable_values"]
    assert field_contexts[0]["variable_name"] == "user_id"
    assert field_contexts[0]["value_kind"] == "low"
    assert field_contexts[0]["values"] == ["u1", "u2"]

    detail_resp = await client.get(f"/api/v1/projects/ev-var-values/events/{event_id}")
    assert detail_resp.status_code == 200
    detail_contexts = detail_resp.json()["field_values"][0]["variable_values"]
    assert detail_contexts == field_contexts


@pytest.mark.asyncio
async def test_update_event_preserves_variable_value_contexts(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-var-keep")
    variable_resp = await client.post(
        "/api/v1/projects/ev-var-keep/variables",
        json={"name": "user_id", "variable_type": "string"},
    )
    event_resp = await client.post(
        "/api/v1/projects/ev-var-keep/events",
        json={
            "event_type_id": et_id,
            "name": "Profile View",
            "field_values": [{"field_definition_id": field_id, "value": "${user_id}"}],
        },
    )
    assert event_resp.status_code == 201
    variable_id = uuid.UUID(variable_resp.json()["id"])
    event_id = uuid.UUID(event_resp.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        event = await session.get(Event, event_id)
        assert variable is not None
        assert event is not None
        session.add(
            VariableValue(
                project_id=variable.project_id,
                branch_id=variable.branch_id,
                variable_id=variable.id,
                event_id=event.id,
                field_definition_id=uuid.UUID(field_id),
                source_column="user_id",
                value_kind="low",
                observed_count=2,
                values=["u1", "u2"],
            )
        )

    update_resp = await client.patch(
        f"/api/v1/projects/ev-var-keep/events/{event_id}",
        json={
            "name": "Profile View Edited",
            "field_values": [{"field_definition_id": field_id, "value": "${user_id} v2"}],
        },
    )
    assert update_resp.status_code == 200
    contexts = update_resp.json()["field_values"][0]["variable_values"]
    assert contexts[0]["variable_name"] == "user_id"
    assert contexts[0]["values"] == ["u1", "u2"]

    detail_resp = await client.get(f"/api/v1/projects/ev-var-keep/events/{event_id}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["field_values"][0]["variable_values"] == contexts


@pytest.mark.asyncio
async def test_event_history_records_tracked_changes(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-history")
    event_resp = await client.post(
        "/api/v1/projects/ev-history/events",
        json={
            "event_type_id": et_id,
            "name": "History Event",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert event_resp.status_code == 201
    event_id = event_resp.json()["id"]

    update_resp = await client.patch(
        f"/api/v1/projects/ev-history/events/{event_id}",
        json={"name": "History Event Renamed", "status": "implemented"},
    )
    assert update_resp.status_code == 200

    history_resp = await client.get(f"/api/v1/projects/ev-history/events/{event_id}/history")
    assert history_resp.status_code == 200
    entries = history_resp.json()
    by_field = {entry["field"]: entry for entry in entries}

    assert by_field["name"]["old_value"] == "History Event"
    assert by_field["name"]["new_value"] == "History Event Renamed"
    assert by_field["status"]["new_value"] == "implemented"
    # Manual edits are attributed to the acting user.
    assert by_field["status"]["user_email"] == "test@example.com"


@pytest.mark.asyncio
async def test_create_event_missing_required_field(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-req")
    resp = await client.post(
        "/api/v1/projects/ev-req/events",
        json={
            "event_type_id": et_id,
            "name": "No Screen",
            "field_values": [],
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_list_events(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-list")
    await client.post(
        "/api/v1/projects/ev-list/events",
        json={
            "event_type_id": et_id,
            "name": "Event 1",
            "field_values": [{"field_definition_id": field_id, "value": "screen1"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-list/events",
        json={
            "event_type_id": et_id,
            "name": "Event 2",
            "field_values": [{"field_definition_id": field_id, "value": "screen2"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-list/events")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    assert [item["order"] for item in data["items"]] == [0, 1]
    # With no alert rules configured, no event is monitored.
    assert all(item["monitored"] is False for item in data["items"])


@pytest.mark.asyncio
async def test_list_events_hides_archived_unless_asked_for(client: AsyncClient):
    """An unfiltered listing must not carry archived events.

    Archiving is the user saying "put this out of the way", but only the web app
    honoured that, and by accident — it sends an explicit six-status filter that
    happens to omit `archived`. The CLI, the MCP server's `list_events` tool and
    any direct API call all still received archived events, so the property lived
    in one client rather than in the plan (tripl-mhhi).
    """
    et_id, field_id, _ = await _setup_events(client, "ev-archived-hidden")

    async def _make(name: str, status: str) -> str:
        resp = await client.post(
            "/api/v1/projects/ev-archived-hidden/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "status": status,
                "field_values": [{"field_definition_id": field_id, "value": "screen"}],
            },
        )
        assert resp.status_code == 201, resp.text
        return str(resp.json()["id"])

    await _make("Still Live", "live")
    await _make("Put Away", "archived")

    default = await client.get("/api/v1/projects/ev-archived-hidden/events")

    assert default.status_code == 200
    body = default.json()
    assert [item["name"] for item in body["items"]] == ["Still Live"]
    # `total` drives pagination, so it has to agree with the rows or the UI
    # renders a page count for events it will never show.
    assert body["total"] == 1

    # Asking for them explicitly still works — this hides them, it does not
    # make them unreachable.
    archived = await client.get(
        "/api/v1/projects/ev-archived-hidden/events", params={"status": "archived"}
    )

    assert archived.status_code == 200
    assert [item["name"] for item in archived.json()["items"]] == ["Put Away"]


async def test_list_events_volume_sort_orders_by_24h_metrics(client: AsyncClient):
    """`order_by=volume` ranks events by their summed EventMetric.count over the
    last 24h (busiest first). Metrics outside the 24h window are ignored, and the
    default (catalog) ordering is unchanged."""
    et_id, field_id, _ = await _setup_events(client, "ev-volume")

    async def _make_event(name: str, value: str) -> str:
        resp = await client.post(
            "/api/v1/projects/ev-volume/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "field_values": [{"field_definition_id": field_id, "value": value}],
            },
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    quiet_id = await _make_event("Quiet", "s1")  # catalog order 0
    busiest_id = await _make_event("Busiest", "s2")  # catalog order 1
    middle_id = await _make_event("Middle", "s3")  # catalog order 2

    now = datetime.now(UTC)
    async with TestSessionLocal() as session, session.begin():
        project = (
            await session.execute(select(Project).where(Project.slug == "ev-volume"))
        ).scalar_one()
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Vol DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
        )
        session.add(data_source)
        await session.flush()
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Vol Scan",
            base_query="SELECT ts FROM events",
            time_column="ts",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add(scan_config)
        await session.flush()

        def _metric(event_id: str, count: int, hours_ago: float) -> EventMetric:
            return EventMetric(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                event_id=uuid.UUID(event_id),
                bucket=now - timedelta(hours=hours_ago),
                count=count,
            )

        session.add_all(
            [
                _metric(busiest_id, 500, 1),
                _metric(busiest_id, 300, 5),  # busiest window total = 800
                _metric(middle_id, 100, 2),
                _metric(middle_id, 50, 10),  # middle window total = 150
                _metric(quiet_id, 5, 3),  # quiet window total = 5
                # Outside the 24h window — must NOT count toward the ranking.
                _metric(quiet_id, 100_000, 30),
            ]
        )

    volume_resp = await client.get("/api/v1/projects/ev-volume/events?order_by=volume")
    assert volume_resp.status_code == 200
    assert [item["id"] for item in volume_resp.json()["items"]] == [
        busiest_id,
        middle_id,
        quiet_id,
    ]

    # Default (catalog) ordering is unchanged: creation order 0, 1, 2.
    default_resp = await client.get("/api/v1/projects/ev-volume/events")
    assert default_resp.status_code == 200
    assert [item["id"] for item in default_resp.json()["items"]] == [
        quiet_id,
        busiest_id,
        middle_id,
    ]

    # An unknown order_by value is rejected by the endpoint.
    bad_resp = await client.get("/api/v1/projects/ev-volume/events?order_by=nope")
    assert bad_resp.status_code == 422


@pytest.mark.asyncio
async def test_list_events_monitored_reflects_alert_rule_coverage(client: AsyncClient):
    """The catalog's Monitor column is fed by alert-rule coverage: an event is
    ``monitored`` when an enabled, event-scoped rule watches it. A rule with an
    ``event`` filter narrows coverage to just the referenced events."""
    et_id, field_id, _ = await _setup_events(client, "ev-monitored")
    covered_resp = await client.post(
        "/api/v1/projects/ev-monitored/events",
        json={
            "event_type_id": et_id,
            "name": "Covered",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    covered_id = covered_resp.json()["id"]
    other_resp = await client.post(
        "/api/v1/projects/ev-monitored/events",
        json={
            "event_type_id": et_id,
            "name": "Uncovered",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    other_id = other_resp.json()["id"]

    destination_resp = await client.post(
        "/api/v1/projects/ev-monitored/alert-destinations",
        json={
            "type": "slack",
            "name": "Main Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    destination_id = destination_resp.json()["id"]

    def monitored_by_id(items: list[dict]) -> dict[str, bool]:
        return {item["id"]: item["monitored"] for item in items}

    # An event-scoped rule with no filters covers every event.
    broad_rule = await client.post(
        f"/api/v1/projects/ev-monitored/alert-destinations/{destination_id}/rules",
        json={"name": "All events", "enabled": True, "include_events": True},
    )
    assert broad_rule.status_code == 201
    listed = monitored_by_id(
        (await client.get("/api/v1/projects/ev-monitored/events")).json()["items"]
    )
    assert listed[covered_id] is True
    assert listed[other_id] is True

    # Narrow that rule to a single event via an `event` filter → only it stays
    # covered.
    rule_id = broad_rule.json()["id"]
    narrow = await client.patch(
        f"/api/v1/projects/ev-monitored/alert-destinations/{destination_id}/rules/{rule_id}",
        json={
            "filters": [
                {"field": "event", "operator": "eq", "values": [covered_id]},
            ],
        },
    )
    assert narrow.status_code == 200
    listed = monitored_by_id(
        (await client.get("/api/v1/projects/ev-monitored/events")).json()["items"]
    )
    assert listed[covered_id] is True
    assert listed[other_id] is False

    # Disabling event scope drops coverage for all events.
    await client.patch(
        f"/api/v1/projects/ev-monitored/alert-destinations/{destination_id}/rules/{rule_id}",
        json={"include_events": False},
    )
    listed = monitored_by_id(
        (await client.get("/api/v1/projects/ev-monitored/events")).json()["items"]
    )
    assert all(value is False for value in listed.values())


@pytest.mark.asyncio
async def test_list_events_search(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-search")
    await client.post(
        "/api/v1/projects/ev-search/events",
        json={
            "event_type_id": et_id,
            "name": "Alpha Page",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-search/events",
        json={
            "event_type_id": et_id,
            "name": "Beta Click",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-search/events?search=Alpha")
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_list_events_search_matches_description(client: AsyncClient):
    """``search`` covers the description, not only the name — so an agent can
    find an event by a word that only appears in its prose."""
    et_id, field_id, _ = await _setup_events(client, "ev-desc")
    await client.post(
        "/api/v1/projects/ev-desc/events",
        json={
            "event_type_id": et_id,
            "name": "Generic Name",
            "description": "Fires on successful checkout completion",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-desc/events",
        json={
            "event_type_id": et_id,
            "name": "Another Name",
            "description": "Unrelated prose",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-desc/events?search=checkout")
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Generic Name"


@pytest.mark.asyncio
async def test_list_events_filter_by_field_value(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-fv")
    await client.post(
        "/api/v1/projects/ev-fv/events",
        json={
            "event_type_id": et_id,
            "name": "Home",
            "field_values": [{"field_definition_id": field_id, "value": "home_screen"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-fv/events",
        json={
            "event_type_id": et_id,
            "name": "Settings",
            "field_values": [{"field_definition_id": field_id, "value": "settings_screen"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-fv/events?field_value=home")
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Home"


@pytest.mark.asyncio
async def test_list_events_filter_by_meta_value(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-mv")
    await client.post(
        "/api/v1/projects/ev-mv/events",
        json={
            "event_type_id": et_id,
            "name": "Tracked",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
            "meta_values": [
                {"meta_field_definition_id": meta_id, "value": "https://jira.example.com/TICK-42"}
            ],
        },
    )
    await client.post(
        "/api/v1/projects/ev-mv/events",
        json={
            "event_type_id": et_id,
            "name": "Untracked",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-mv/events?meta_value=TICK-42")
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Tracked"


@pytest.mark.asyncio
async def test_update_event(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-upd")
    create = await client.post(
        "/api/v1/projects/ev-upd/events",
        json={
            "event_type_id": et_id,
            "name": "Old Name",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/ev-upd/events/{event_id}",
        json={"name": "New Name", "metric_breakdown_columns": ["country"]},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"
    assert resp.json()["metric_breakdown_columns"] == ["country"]


@pytest.mark.asyncio
async def test_update_event_records_change_history_with_timestamps(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-upd-history")
    create = await client.post(
        "/api/v1/projects/ev-upd-history/events",
        json={
            "event_type_id": et_id,
            "name": "Forecast Model",
            "description": "Old description",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]

    resp = await client.patch(
        f"/api/v1/projects/ev-upd-history/events/{event_id}",
        json={"description": "New description"},
    )

    assert resp.status_code == 200
    history_resp = await client.get(f"/api/v1/projects/ev-upd-history/events/{event_id}/history")
    assert history_resp.status_code == 200
    history = history_resp.json()
    assert len(history) == 1
    assert history[0]["field"] == "description"
    assert history[0]["old_value"] == "Old description"
    assert history[0]["new_value"] == "New description"
    assert history[0]["created_at"] is not None


@pytest.mark.asyncio
async def test_delete_event(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-del")
    create = await client.post(
        "/api/v1/projects/ev-del/events",
        json={
            "event_type_id": et_id,
            "name": "To Delete",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.delete(f"/api/v1/projects/ev-del/events/{event_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_bulk_delete_events(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk-del")
    first = await client.post(
        "/api/v1/projects/ev-bulk-del/events",
        json={
            "event_type_id": et_id,
            "name": "First",
            "field_values": [{"field_definition_id": field_id, "value": "a"}],
        },
    )
    second = await client.post(
        "/api/v1/projects/ev-bulk-del/events",
        json={
            "event_type_id": et_id,
            "name": "Second",
            "field_values": [{"field_definition_id": field_id, "value": "b"}],
        },
    )

    resp = await client.post(
        "/api/v1/projects/ev-bulk-del/events/bulk-delete",
        json={"event_ids": [first.json()["id"], second.json()["id"]]},
    )
    assert resp.status_code == 204

    list_resp = await client.get("/api/v1/projects/ev-bulk-del/events")
    assert list_resp.status_code == 200
    assert list_resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_bulk_update_events_state(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk-update")
    first = await client.post(
        "/api/v1/projects/ev-bulk-update/events",
        json={
            "event_type_id": et_id,
            "name": "First",
            "status": "ready_for_dev",
            "field_values": [{"field_definition_id": field_id, "value": "a"}],
        },
    )
    second = await client.post(
        "/api/v1/projects/ev-bulk-update/events",
        json={
            "event_type_id": et_id,
            "name": "Second",
            "status": "ready_for_dev",
            "field_values": [{"field_definition_id": field_id, "value": "b"}],
        },
    )

    resp = await client.post(
        "/api/v1/projects/ev-bulk-update/events/bulk-update",
        json={
            "event_ids": [first.json()["id"], second.json()["id"]],
            "status": "in_review",
        },
    )

    assert resp.status_code == 204
    review_resp = await client.get("/api/v1/projects/ev-bulk-update/events?status=in_review")
    assert review_resp.status_code == 200
    assert review_resp.json()["total"] == 2

    archive_resp = await client.post(
        "/api/v1/projects/ev-bulk-update/events/bulk-update",
        json={
            "event_ids": [first.json()["id"], second.json()["id"]],
            "status": "archived",
        },
    )

    assert archive_resp.status_code == 204
    archived_list = await client.get("/api/v1/projects/ev-bulk-update/events?status=archived")
    assert archived_list.status_code == 200
    assert archived_list.json()["total"] == 2


@pytest.mark.asyncio
async def test_bulk_update_events_requires_state_field(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk-update-empty")
    event = await client.post(
        "/api/v1/projects/ev-bulk-update-empty/events",
        json={
            "event_type_id": et_id,
            "name": "First",
            "field_values": [{"field_definition_id": field_id, "value": "a"}],
        },
    )

    resp = await client.post(
        "/api/v1/projects/ev-bulk-update-empty/events/bulk-update",
        json={"event_ids": [event.json()["id"]]},
    )

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_event_with_tags_and_status(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-tags")
    resp = await client.post(
        "/api/v1/projects/ev-tags/events",
        json={
            "event_type_id": et_id,
            "name": "Tagged Event",
            "status": "implemented",
            "tags": ["mobile", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "implemented"
    assert sorted([t["name"] for t in data["tags"]]) == ["mobile", "v2"]


@pytest.mark.asyncio
async def test_filter_by_status(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-impl")
    await client.post(
        "/api/v1/projects/ev-impl/events",
        json={
            "event_type_id": et_id,
            "name": "Done",
            "status": "implemented",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-impl/events",
        json={
            "event_type_id": et_id,
            "name": "Not Done",
            "status": "draft",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-impl/events?status=implemented")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Done"

    resp = await client.get("/api/v1/projects/ev-impl/events?status=draft")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Not Done"


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["active", "proposed", "review", "zzz", ""])
async def test_filter_by_out_of_enum_status_returns_422(client: AsyncClient, value: str):
    """A status outside EventStatus is user input, not a server fault.

    The column is a native Postgres enum, so an unvalidated value reached the
    driver and surfaced as a 500 with an unusable request_id (tripl-jfm3.24).
    """
    await _setup_events(client, f"ev-badstatus-{value or 'empty'}")
    resp = await client.get(
        f"/api/v1/projects/ev-badstatus-{value or 'empty'}/events?limit=1&status={value}"
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    status_errors = [error for error in detail if "status" in error["loc"]]
    assert status_errors, detail
    # The error names the accepted members so an API consumer can self-correct.
    assert "live" in str(status_errors[0])


@pytest.mark.asyncio
async def test_filter_by_multiple_statuses(client: AsyncClient):
    """Repeated status params still union — the enum type keeps list semantics."""
    et_id, field_id, _ = await _setup_events(client, "ev-multistatus")
    for name, status in (("Live One", "live"), ("Draft One", "draft"), ("Gone", "archived")):
        await client.post(
            "/api/v1/projects/ev-multistatus/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "status": status,
                "field_values": [{"field_definition_id": field_id, "value": "s"}],
            },
        )
    resp = await client.get("/api/v1/projects/ev-multistatus/events?status=live&status=draft")
    assert resp.status_code == 200
    assert {item["name"] for item in resp.json()["items"]} == {"Live One", "Draft One"}


@pytest.mark.asyncio
async def test_filter_by_tag(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-ftag")
    await client.post(
        "/api/v1/projects/ev-ftag/events",
        json={
            "event_type_id": et_id,
            "name": "Mobile Event",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-ftag/events",
        json={
            "event_type_id": et_id,
            "name": "Web Event",
            "tags": ["web"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-ftag/events?tag=mobile")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Mobile Event"


@pytest.mark.asyncio
async def test_list_tags(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-ltag")
    await client.post(
        "/api/v1/projects/ev-ltag/events",
        json={
            "event_type_id": et_id,
            "name": "E1",
            "tags": ["mobile", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-ltag/events",
        json={
            "event_type_id": et_id,
            "name": "E2",
            "tags": ["web", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-ltag/events/tags")
    assert resp.status_code == 200
    assert sorted(resp.json()) == ["mobile", "v2", "web"]


@pytest.mark.asyncio
async def test_update_tags_and_status(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-utag")
    create = await client.post(
        "/api/v1/projects/ev-utag/events",
        json={
            "event_type_id": et_id,
            "name": "E",
            "tags": ["old"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/ev-utag/events/{event_id}",
        json={"status": "implemented", "tags": ["new1", "new2"]},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "implemented"
    assert sorted([t["name"] for t in data["tags"]]) == ["new1", "new2"]


@pytest.mark.asyncio
async def test_move_event_reorders_visible_list(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-move")
    created_ids: list[str] = []
    for name in ("Event A", "Event B", "Event C"):
        create = await client.post(
            "/api/v1/projects/ev-move/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "field_values": [{"field_definition_id": field_id, "value": name}],
            },
        )
        created_ids.append(create.json()["id"])

    move_resp = await client.patch(
        f"/api/v1/projects/ev-move/events/{created_ids[2]}/move",
        json={"direction": "up", "visible_event_ids": created_ids},
    )
    assert move_resp.status_code == 200

    list_resp = await client.get("/api/v1/projects/ev-move/events")
    assert list_resp.status_code == 200
    assert [item["name"] for item in list_resp.json()["items"]] == [
        "Event A",
        "Event C",
        "Event B",
    ]


@pytest.mark.asyncio
async def test_reorder_events_assigns_new_sequence(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-reorder")
    created_ids: list[str] = []
    for name in ("Event A", "Event B", "Event C"):
        create = await client.post(
            "/api/v1/projects/ev-reorder/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "field_values": [{"field_definition_id": field_id, "value": name}],
            },
        )
        created_ids.append(create.json()["id"])

    new_sequence = [created_ids[2], created_ids[0], created_ids[1]]
    reorder_resp = await client.patch(
        "/api/v1/projects/ev-reorder/events/reorder",
        json={"event_ids": new_sequence},
    )
    assert reorder_resp.status_code == 200

    list_resp = await client.get("/api/v1/projects/ev-reorder/events")
    assert list_resp.status_code == 200
    assert [item["name"] for item in list_resp.json()["items"]] == [
        "Event C",
        "Event A",
        "Event B",
    ]


@pytest.mark.asyncio
async def test_event_response_carries_null_last_seen_initially(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-lastseen")
    create = await client.post(
        "/api/v1/projects/ev-lastseen/events",
        json={
            "event_type_id": et_id,
            "name": "Hello",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert create.status_code == 201
    assert create.json()["last_seen_at"] is None

    listed = await client.get("/api/v1/projects/ev-lastseen/events")
    assert listed.status_code == 200
    assert all(item["last_seen_at"] is None for item in listed.json()["items"])


@pytest.mark.asyncio
async def test_filter_silent_since_days(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-silent")
    fresh = await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Fresh",
            "field_values": [{"field_definition_id": field_id, "value": "s1"}],
        },
    )
    stale = await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Stale",
            "field_values": [{"field_definition_id": field_id, "value": "s2"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Silent",
            "field_values": [{"field_definition_id": field_id, "value": "s3"}],
        },
    )
    fresh_id = fresh.json()["id"]
    stale_id = stale.json()["id"]

    # Backfill last_seen_at out-of-band — the column is normally written by the
    # metrics pipeline, but the API filter has its own surface that we want to
    # cover here.
    now = datetime.now(UTC)
    async with TestSessionLocal() as session, session.begin():
        fresh_row = await session.get(Event, uuid.UUID(fresh_id))
        stale_row = await session.get(Event, uuid.UUID(stale_id))
        assert fresh_row is not None
        assert stale_row is not None
        fresh_row.last_seen_at = now - timedelta(hours=1)
        stale_row.last_seen_at = now - timedelta(days=10)

    resp = await client.get("/api/v1/projects/ev-silent/events?silent_since_days=7")
    assert resp.status_code == 200
    names = {item["name"] for item in resp.json()["items"]}
    # Stale (10 days ago) and Silent (never) match silent > 7d. Fresh (1h) does not.
    assert names == {"Stale", "Silent"}


@pytest.mark.asyncio
async def test_bulk_create_events(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk")
    resp = await client.post(
        "/api/v1/projects/ev-bulk/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "Bulk 1",
                "field_values": [{"field_definition_id": field_id, "value": "s1"}],
            },
            {
                "event_type_id": et_id,
                "name": "Bulk 2",
                "field_values": [{"field_definition_id": field_id, "value": "s2"}],
            },
        ],
    )
    assert resp.status_code == 201
    event_ids = [uuid.UUID(event["id"]) for event in resp.json()]
    assert len(event_ids) == 2

    async with TestSessionLocal() as session:
        field_values = (
            (
                await session.execute(
                    select(EventFieldValue).where(EventFieldValue.event_id.in_(event_ids))
                )
            )
            .scalars()
            .all()
        )
    assert len(field_values) == 2
    assert all(field_value.is_authored for field_value in field_values)


@pytest.mark.asyncio
async def test_event_owner_and_reviewed(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, slug="ev-owner")
    users = (await client.get("/api/v1/users")).json()
    owner_id = users[0]["id"]

    created = await client.post(
        "/api/v1/projects/ev-owner/events",
        json={
            "event_type_id": et_id,
            "name": "Checkout",
            "field_values": [{"field_definition_id": field_id, "value": "x"}],
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["reviewed"] is False
    assert body["owner_id"] is None
    event_id = body["id"]

    # Assign owner + mark reviewed via single-event PATCH.
    patched = await client.patch(
        f"/api/v1/projects/ev-owner/events/{event_id}",
        json={"owner_id": owner_id, "reviewed": True},
    )
    assert patched.status_code == 200
    pbody = patched.json()
    assert pbody["owner_id"] == owner_id
    assert pbody["reviewed"] is True

    # Bulk un-review; owner must be left untouched by a reviewed-only bulk update.
    bulk = await client.post(
        "/api/v1/projects/ev-owner/events/bulk-update",
        json={"event_ids": [event_id], "reviewed": False},
    )
    assert bulk.status_code == 204

    listed = (await client.get("/api/v1/projects/ev-owner/events")).json()
    item = next(e for e in listed["items"] if e["id"] == event_id)
    assert item["reviewed"] is False
    assert item["owner_id"] == owner_id


@pytest.mark.asyncio
async def test_list_events_filters_by_reviewed_flag(client: AsyncClient):
    """`reviewed` narrows by the review FLAG, independent of `status`.

    Without it, "Mark reviewed" wrote a boolean the UI could neither show nor
    isolate, so bulk-reviewing a queue looked like it did nothing (tripl-invv).
    """
    et_id, field_id, _ = await _setup_events(client, slug="ev-reviewed-filter")

    ids = {}
    for name in ("Checkout", "Signup"):
        created = await client.post(
            "/api/v1/projects/ev-reviewed-filter/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "status": "in_review",
                "field_values": [{"field_definition_id": field_id, "value": "x"}],
            },
        )
        assert created.status_code == 201
        ids[name] = created.json()["id"]

    marked = await client.post(
        "/api/v1/projects/ev-reviewed-filter/events/bulk-update",
        json={"event_ids": [ids["Checkout"]], "reviewed": True},
    )
    assert marked.status_code == 204

    reviewed = (await client.get("/api/v1/projects/ev-reviewed-filter/events?reviewed=true")).json()
    assert reviewed["total"] == 1
    assert [item["id"] for item in reviewed["items"]] == [ids["Checkout"]]

    # The pairing the review tab needs: still-unreviewed rows inside the queue.
    unreviewed = (
        await client.get(
            "/api/v1/projects/ev-reviewed-filter/events?status=in_review&reviewed=false"
        )
    ).json()
    assert unreviewed["total"] == 1
    assert [item["id"] for item in unreviewed["items"]] == [ids["Signup"]]

    # Omitting the param keeps every row, reviewed or not.
    unfiltered = (await client.get("/api/v1/projects/ev-reviewed-filter/events")).json()
    assert unfiltered["total"] == 2


async def _count_search_docs(slug: str, *, title: str | None = None) -> int:
    async with TestSessionLocal() as session:
        statement = (
            select(func.count(SearchDocument.id))
            .join_from(SearchDocument, Event, SearchDocument.parent_event_id == Event.id)
            .where(SearchDocument.entity_type == "event")
        )
        if title is not None:
            statement = statement.where(SearchDocument.title == title)
        return int((await session.execute(statement)).scalar() or 0)


@pytest.mark.asyncio
async def test_create_event_indexes_synchronously(client: AsyncClient):
    """A freshly created event is immediately searchable — the reindex runs
    inline (not deferred to Celery), so the global search reflects it at once."""
    et_id, field_id, _ = await _setup_events(client, "ev-sync-index")
    create = await client.post(
        "/api/v1/projects/ev-sync-index/events",
        json={
            "event_type_id": et_id,
            "name": "Immediately Searchable",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert create.status_code == 201

    found = await client.get("/api/v1/projects/ev-sync-index/search?q=Immediately Searchable")
    assert found.status_code == 200
    titles = [item["title"] for item in found.json()["items"]]
    assert "Immediately Searchable" in titles


@pytest.mark.asyncio
async def test_update_then_delete_reflected_in_search_immediately(client: AsyncClient):
    """Update and delete each rebuild the index in the same transaction, so the
    new/removed state is visible to search right away."""
    et_id, field_id, _ = await _setup_events(client, "ev-sync-mut")
    create = await client.post(
        "/api/v1/projects/ev-sync-mut/events",
        json={
            "event_type_id": et_id,
            "name": "Before Rename",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    event_id = create.json()["id"]

    await client.patch(
        f"/api/v1/projects/ev-sync-mut/events/{event_id}",
        json={"name": "After Rename"},
    )
    renamed = await client.get("/api/v1/projects/ev-sync-mut/search?q=After Rename")
    titles = [item["title"] for item in renamed.json()["items"]]
    assert "After Rename" in titles
    assert "Before Rename" not in titles

    await client.delete(f"/api/v1/projects/ev-sync-mut/events/{event_id}")
    gone = await client.get("/api/v1/projects/ev-sync-mut/search?q=After Rename")
    assert all(item["title"] != "After Rename" for item in gone.json()["items"])


@pytest.mark.asyncio
async def test_create_event_is_atomic_with_reindex(client: AsyncClient, monkeypatch):
    """If the reindex raises, the whole request rolls back: the event row is NOT
    persisted and no orphan search document is left behind. This proves the data
    write and the index rebuild share a single transaction."""
    et_id, field_id, _ = await _setup_events(client, "ev-atomic")

    from tripl.services import event_service

    async def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("reindex failed")

    monkeypatch.setattr(event_service, "_reindex_branch_documents", _boom)

    before = await _count_search_docs("ev-atomic")
    # The shared `client` fixture's transport re-raises app exceptions, so issue
    # this request through a transport that lets the global handler turn the
    # injected reindex error into a 500 (same pattern as test_error_handling).
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies=client.cookies,
    ) as boom_client:
        resp = await boom_client.post(
            "/api/v1/projects/ev-atomic/events",
            json={
                "event_type_id": et_id,
                "name": "Should Roll Back",
                "field_values": [{"field_definition_id": field_id, "value": "home"}],
            },
        )
    # The reindex failure surfaces as a 500 (caught by the global handler) and
    # the whole request rolls back — there is no committed half-state.
    assert resp.status_code == 500

    # Neither the event nor any search document survived the failed reindex.
    async with TestSessionLocal() as session:
        events = (
            await session.execute(
                select(func.count(Event.id)).where(Event.name == "Should Roll Back")
            )
        ).scalar()
        assert events == 0
    assert await _count_search_docs("ev-atomic") == before


@pytest.mark.asyncio
async def test_bulk_create_across_multiple_event_types_validates_per_type(client: AsyncClient):
    """Bulk create groups field definitions per event type from a single IN-list
    SELECT: each event is still validated against its OWN type's required
    fields, so a required field missing for one type is rejected even when other
    events of a different type are valid."""
    slug = "ev-bulk-multi"
    await client.post("/api/v1/projects", json={"name": "BM", "slug": slug})

    # Type A has a required "screen" field; type B has an optional "label".
    et_a = (
        await client.post(
            f"/api/v1/projects/{slug}/event-types",
            json={"name": "type_a", "display_name": "Type A"},
        )
    ).json()["id"]
    field_a = (
        await client.post(
            f"/api/v1/projects/{slug}/event-types/{et_a}/fields",
            json={
                "name": "screen",
                "display_name": "Screen",
                "field_type": "string",
                "is_required": True,
            },
        )
    ).json()["id"]
    et_b = (
        await client.post(
            f"/api/v1/projects/{slug}/event-types",
            json={"name": "type_b", "display_name": "Type B"},
        )
    ).json()["id"]
    await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_b}/fields",
        json={"name": "label", "display_name": "Label", "field_type": "string"},
    )

    # Valid mixed-type batch: A provides its required field, B needs none.
    ok = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_a,
                "name": "A Event",
                "field_values": [{"field_definition_id": field_a, "value": "home"}],
            },
            {"event_type_id": et_b, "name": "B Event", "field_values": []},
        ],
    )
    assert ok.status_code == 201
    assert {e["name"] for e in ok.json()} == {"A Event", "B Event"}

    # A's required field omitted -> rejected, even though B is valid.
    bad = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {"event_type_id": et_a, "name": "A Missing", "field_values": []},
            {"event_type_id": et_b, "name": "B Ok", "field_values": []},
        ],
    )
    assert bad.status_code == 422


async def _seed_scan_name_rule(slug: str, event_type_id: str, name_format: str) -> None:
    from tripl.models.data_source import DataSource
    from tripl.models.project import Project
    from tripl.models.scan_config import ScanConfig

    async with TestSessionLocal() as session, session.begin():
        project = (await session.execute(select(Project).where(Project.slug == slug))).scalar_one()
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"wh-{slug}",
            db_type="clickhouse",
            host="localhost",
            port=9000,
            database_name="db",
            username="u",
            password_encrypted="x",
        )
        session.add(data_source)
        await session.flush()
        session.add(
            ScanConfig(
                id=uuid.uuid4(),
                project_id=project.id,
                data_source_id=data_source.id,
                event_type_id=uuid.UUID(event_type_id),
                name="scan",
                base_query="SELECT * FROM events",
                event_name_format=name_format,
            )
        )


@pytest.mark.asyncio
async def test_create_event_name_generated_from_scan_rule(client: AsyncClient):
    slug = "ev-namegen"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et.json()["id"]
    screen = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    payload_field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "payload", "display_name": "Payload", "field_type": "json"},
    )
    await _seed_scan_name_rule(slug, et_id, "pv:{screen}:{payload.extra.variant}")

    resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et_id,
            "name": "my crooked name",
            "field_values": [
                {"field_definition_id": screen.json()["id"], "value": "onboarding"},
                {
                    "field_definition_id": payload_field.json()["id"],
                    "value": '{"extra": {"variant": "b2"}}',
                },
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    # The template decides the identity; the provided name is ignored with a warning.
    assert body["name"] == "pv:onboarding:b2"
    assert any("generated from the scan rule" in w for w in body["warnings"])

    async with TestSessionLocal() as session:
        event = await session.get(Event, uuid.UUID(body["id"]))
        assert event.source_name == "pv:onboarding:b2"


@pytest.mark.asyncio
async def test_create_event_refuses_an_identity_another_event_already_holds(client: AsyncClient):
    """A scan matches ONE event per identity, so the second one could only rot."""
    slug = "ev-identity-taken"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "action", "display_name": "Action", "field_type": "string"},
    )
    action_id = action.json()["id"]
    await _seed_scan_name_rule(slug, et_id, "{action}")

    payload = {
        "event_type_id": et_id,
        "name": "ignored",
        "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
    }
    first = await client.post(f"/api/v1/projects/{slug}/events", json=payload)
    assert first.status_code == 201, first.text
    assert first.json()["name"] == "sign_up"

    second = await client.post(f"/api/v1/projects/{slug}/events", json=payload)
    assert second.status_code == 409, second.text
    detail = second.json()["detail"]
    # Names the identity AND the event holding it, so the reader can go there.
    assert "sign_up" in detail
    assert first.json()["id"] in detail


@pytest.mark.asyncio
async def test_create_event_refuses_an_identity_a_row_with_no_source_name_will_adopt(
    client: AsyncClient,
):
    """The pre-rule event is not free: the next scan adopts its name as the identity.

    Sequence taken from real projects — someone authors an event before any scan
    config names that type, a scan is configured later, and the generator's
    ``source_name = ev.name`` backfill hands the older row the very identity the
    new one is trying to claim.
    """
    slug = "ev-identity-adopted"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "action", "display_name": "Action", "field_type": "string"},
    )
    action_id = action.json()["id"]

    # No scan rule yet: the name is the user's and source_name stays NULL.
    early = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "sign_up", "field_values": []},
    )
    assert early.status_code == 201, early.text
    async with TestSessionLocal() as session:
        stored = await session.get(Event, uuid.UUID(early.json()["id"]))
        assert stored.source_name is None

    await _seed_scan_name_rule(slug, et_id, "{action}")
    clash = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et_id,
            "name": "whatever",
            "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
        },
    )
    assert clash.status_code == 409, clash.text
    assert early.json()["id"] in clash.json()["detail"]


@pytest.mark.asyncio
async def test_create_event_allows_a_different_identity_under_the_same_rule(client: AsyncClient):
    """The guard refuses collisions, not second events."""
    slug = "ev-identity-free"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "action", "display_name": "Action", "field_type": "string"},
    )
    action_id = action.json()["id"]
    await _seed_scan_name_rule(slug, et_id, "{action}")

    for value in ("sign_up", "sign_out"):
        created = await client.post(
            f"/api/v1/projects/{slug}/events",
            json={
                "event_type_id": et_id,
                "name": "x",
                "field_values": [{"field_definition_id": action_id, "value": value}],
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["name"] == value


@pytest.mark.asyncio
async def test_bulk_create_events_applies_the_scan_naming_rule(client: AsyncClient):
    """Both create doors must author the same event for the same payload."""
    slug = "ev-bulk-namegen"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "action", "display_name": "Action", "field_type": "string"},
    )
    action_id = action.json()["id"]
    await _seed_scan_name_rule(slug, et_id, "se:{action}")

    created = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "whatever the caller typed",
                "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
            },
            {
                "event_type_id": et_id,
                "name": "also ignored",
                "field_values": [{"field_definition_id": action_id, "value": "sign_out"}],
            },
        ],
    )
    assert created.status_code == 201, created.text
    assert [event["name"] for event in created.json()] == ["se:sign_up", "se:sign_out"]

    async with TestSessionLocal() as session:
        for event_payload in created.json():
            stored = await session.get(Event, uuid.UUID(event_payload["id"]))
            # The identity is what makes an authored event merge with its
            # scanned counterpart; bulk used to leave it NULL.
            assert stored.source_name == event_payload["name"]


@pytest.mark.asyncio
async def test_bulk_create_events_refuses_two_items_claiming_one_identity(client: AsyncClient):
    """The sibling is not in the database yet, so only an in-batch check can see it."""
    slug = "ev-bulk-clash"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "action", "display_name": "Action", "field_type": "string"},
    )
    action_id = action.json()["id"]
    await _seed_scan_name_rule(slug, et_id, "{action}")

    clash = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "a",
                "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
            },
            {
                "event_type_id": et_id,
                "name": "b",
                "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
            },
        ],
    )
    assert clash.status_code == 409, clash.text
    detail = clash.json()["detail"]
    assert "1 and 2 of 2" in detail
    assert "sign_up" in detail

    listed = await client.get(f"/api/v1/projects/{slug}/events")
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_bulk_create_events_names_the_item_that_failed(client: AsyncClient):
    """'Required field action is missing' is unusable when thirty events were posted."""
    slug = "ev-bulk-which"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "se", "display_name": "Structured"}
    )
    et_id = et.json()["id"]
    action = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={
            "name": "action",
            "display_name": "Action",
            "field_type": "string",
            "is_required": True,
        },
    )
    action_id = action.json()["id"]

    bad = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "ok",
                "field_values": [{"field_definition_id": action_id, "value": "sign_up"}],
            },
            {"event_type_id": et_id, "name": "broken", "field_values": []},
        ],
    )
    assert bad.status_code == 422, bad.text
    assert bad.json()["detail"].startswith("Event 2 of 2: ")


@pytest.mark.asyncio
async def test_bulk_create_events_normalizes_json_like_the_single_create(client: AsyncClient):
    """The batched door restated the field checks and dropped the normalisation."""
    slug = "ev-bulk-json"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types", json={"name": "pv", "display_name": "Page View"}
    )
    et_id = et.json()["id"]
    payload_field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "payload", "display_name": "Payload", "field_type": "json"},
    )
    field_id = payload_field.json()["id"]

    created = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "one",
                "field_values": [{"field_definition_id": field_id, "value": '{"a":1}'}],
            }
        ],
    )
    assert created.status_code == 201, created.text
    stored = created.json()[0]["field_values"][0]["value"]
    single = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et_id,
            "name": "two",
            "field_values": [{"field_definition_id": field_id, "value": '{"a":1}'}],
        },
    )
    assert stored == single.json()["field_values"][0]["value"]

    malformed = await client.post(
        f"/api/v1/projects/{slug}/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "three",
                "field_values": [{"field_definition_id": field_id, "value": "{oops"}],
            }
        ],
    )
    assert malformed.status_code == 422, malformed.text


@pytest.mark.asyncio
async def test_event_json_field_values_are_validated_and_normalized_with_variables(
    client: AsyncClient,
):
    """JSON fields keep template tokens, but malformed values never reach storage."""
    slug = "ev-json-values"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    event_type = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    event_type_id = event_type.json()["id"]
    payload_field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{event_type_id}/fields",
        json={"name": "payload", "display_name": "Payload", "field_type": "json"},
    )
    field_id = payload_field.json()["id"]

    malformed = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "bad-json",
            "field_values": [
                {"field_definition_id": field_id, "value": '{"variant":"${variant}",}'},
            ],
        },
    )
    assert malformed.status_code == 422
    assert "Payload" in malformed.json()["detail"]
    assert "valid JSON" in malformed.json()["detail"]

    blank = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "blank-json",
            "field_values": [{"field_definition_id": field_id, "value": "   "}],
        },
    )
    assert blank.status_code == 422
    assert "valid JSON" in blank.json()["detail"]

    omitted_optional = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": event_type_id, "name": "without-json"},
    )
    assert omitted_optional.status_code == 201

    created = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "templated-json",
            "field_values": [
                {
                    "field_definition_id": field_id,
                    "value": (
                        '{ "literal": "\\u005f_TRIPL_JSON_TEMPLATE_0__", '
                        '"variant" : "${variant}", "nested": {"id":"${user_id}"} }'
                    ),
                },
            ],
        },
    )
    assert created.status_code == 201, created.text
    event_id = created.json()["id"]
    expected_value = (
        '{"literal": "__TRIPL_JSON_TEMPLATE_0__", "variant": "${variant}", '
        '"nested": {"id": "${user_id}"}}'
    )
    assert created.json()["field_values"][0]["value"] == expected_value

    invalid_update = await client.patch(
        f"/api/v1/projects/{slug}/events/{event_id}",
        json={"field_values": [{"field_definition_id": field_id, "value": '{"nested":}'}]},
    )
    assert invalid_update.status_code == 422
    assert "Payload" in invalid_update.json()["detail"]

    persisted = await client.get(f"/api/v1/projects/{slug}/events/{event_id}")
    assert persisted.status_code == 200
    assert persisted.json()["field_values"][0]["value"] == expected_value

    invalid_template = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "invalid-template",
            "field_values": [
                {"field_definition_id": field_id, "value": '{"variant": ${bad"token}}'},
            ],
        },
    )
    assert invalid_template.status_code == 422
    assert "invalid variable token" in invalid_template.json()["detail"]

    empty_template = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "empty-template",
            "field_values": [{"field_definition_id": field_id, "value": '{"variant": "${}"}'}],
        },
    )
    assert empty_template.status_code == 422
    assert "invalid variable token" in empty_template.json()["detail"]

    templated_key = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "templated-key",
            "field_values": [
                {"field_definition_id": field_id, "value": '{"${key}": "value"}'},
            ],
        },
    )
    assert templated_key.status_code == 422
    assert "cannot be JSON object keys" in templated_key.json()["detail"]

    nonstandard_number = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "nan-json",
            "field_values": [{"field_definition_id": field_id, "value": '{"ratio": NaN}'}],
        },
    )
    assert nonstandard_number.status_code == 422
    assert "valid JSON" in nonstandard_number.json()["detail"]

    overflow_number = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "overflow-json",
            "field_values": [{"field_definition_id": field_id, "value": '{"ratio": 1e400}'}],
        },
    )
    assert overflow_number.status_code == 422
    assert "valid JSON" in overflow_number.json()["detail"]


@pytest.mark.asyncio
async def test_create_event_scan_rule_requires_template_fields(client: AsyncClient):
    slug = "ev-namegen-422"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et.json()["id"]
    await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    await _seed_scan_name_rule(slug, et_id, "pv:{screen}")

    resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "whatever", "field_values": []},
    )
    assert resp.status_code == 422
    assert "fill field values for: screen" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_event_free_name_without_scan_rule(client: AsyncClient):
    slug = "ev-freename"
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et.json()["id"], "name": "hand written"},
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "hand written"

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import insert
from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg

from tripl.models.event import Event
from tripl.models.search_document import SearchDocument
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.search import SearchResult
from tripl.services.search_service import _finalize_results, _token_boundary_regex
from tripl.tests.conftest import TestSessionLocal


def _result(
    *,
    entity_type: str,
    title: str,
    score: float,
    subtitle: str = "",
) -> SearchResult:
    return SearchResult(
        id=uuid.uuid4(),
        entity_type=entity_type,  # type: ignore[arg-type]
        entity_id=uuid.uuid4(),
        title=title,
        subtitle=subtitle,
        route_path="/",
        score=score,
    )


def test_event_type_match_boosts_member_events_above_unrelated_ones() -> None:
    # A query that resolves to the "Pageviews" event type should lift events of
    # that type above an event of a different type with a similar base score.
    items = [
        _result(entity_type="event_type", title="Pageviews", score=5.0),
        _result(entity_type="event", title="Spot Screen", subtitle="Pageviews", score=2.0),
        _result(entity_type="event", title="Order Placed", subtitle="Checkout", score=2.5),
    ]

    finalized = _finalize_results(items, limit=10)

    titles = [item.title for item in finalized]
    assert titles.index("Spot Screen") < titles.index("Order Placed")
    # Confidence is normalized to the top hit and stays within [0, 1].
    assert finalized[0].confidence == 1.0
    assert all(0.0 <= item.confidence <= 1.0 for item in finalized)


def test_finalize_assigns_confidence_without_event_type_match() -> None:
    items = [
        _result(entity_type="event", title="Alpha", score=8.0),
        _result(entity_type="event", title="Beta", score=4.0),
    ]

    finalized = _finalize_results(items, limit=10)

    assert finalized[0].confidence == 1.0
    assert finalized[1].confidence == 0.5


def test_search_document_insert_does_not_write_generated_text_vector() -> None:
    statement = insert(SearchDocument).values(
        project_id=uuid.uuid4(),
        branch_id=uuid.uuid4(),
        entity_type="event",
        entity_id=uuid.uuid4(),
        title="Checkout Completed",
        route_path="/p/demo/events/detail/event-1",
        content_hash="0" * 64,
    )

    compiled = str(statement.compile(dialect=PGDialect_asyncpg()))

    columns = compiled.split(" VALUES ", maxsplit=1)[0]
    assert "text_vector" not in columns


def test_token_boundary_regex_uses_single_postgres_escapes() -> None:
    assert _token_boundary_regex("ecmwf") == r"\mecmwf\M"
    assert _token_boundary_regex("vip_segment") == r"\mvip_segment\M"
    assert _token_boundary_regex("ecmwf model") is None


async def _create_event_type(
    client: AsyncClient,
    slug: str,
    *,
    name: str,
    display_name: str,
    description: str = "",
) -> tuple[str, str]:
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": name, "display_name": display_name, "description": description},
    )
    assert et_resp.status_code == 201
    event_type_id = et_resp.json()["id"]
    field_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types/{event_type_id}/fields",
        json={
            "name": "screen",
            "display_name": "Экран",
            "field_type": "string",
            "description": "Screen or page identifier",
        },
    )
    assert field_resp.status_code == 201
    return event_type_id, field_resp.json()["id"]


@pytest.mark.asyncio
async def test_global_search_matches_multilingual_plan_content(client: AsyncClient) -> None:
    await client.post("/api/v1/projects", json={"name": "Search", "slug": "search-ml"})
    event_type_id, field_id = await _create_event_type(
        client,
        "search-ml",
        name="checkout",
        display_name="Checkout / Покупка",
        description="Финальные шаги оформления заказа",
    )
    secret_field_resp = await client.post(
        f"/api/v1/projects/search-ml/event-types/{event_type_id}/fields",
        json={
            "name": "api_token",
            "display_name": "API Token",
            "field_type": "string",
            "sensitivity": "secret",
        },
    )
    assert secret_field_resp.status_code == 201
    secret_field_id = secret_field_resp.json()["id"]
    variable_create = await client.post(
        "/api/v1/projects/search-ml/variables",
        json={"name": "user_id", "description": "Идентификатор пользователя"},
    )
    secret_variable_create = await client.post(
        "/api/v1/projects/search-ml/variables",
        json={"name": "api_token", "description": "Sensitive token"},
    )
    assert variable_create.status_code == 201
    assert secret_variable_create.status_code == 201
    variable_id = uuid.UUID(variable_create.json()["id"])
    secret_variable_id = uuid.UUID(secret_variable_create.json()["id"])
    event_resp = await client.post(
        "/api/v1/projects/search-ml/events",
        json={
            "event_type_id": event_type_id,
            "name": "Checkout Completed",
            "description": "Fires when покупка успешно завершена",
            "tags": ["покупка"],
            "field_values": [
                {"field_definition_id": field_id, "value": "завершение покупки"},
                {"field_definition_id": secret_field_id, "value": "${api_token}"},
            ],
        },
    )
    assert event_resp.status_code == 201
    event_id = uuid.UUID(event_resp.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        secret_variable = await session.get(Variable, secret_variable_id)
        event = await session.get(Event, event_id)
        assert variable is not None
        assert secret_variable is not None
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
                observed_count=1,
                values=["vip_segment"],
            )
        )
        session.add(
            VariableValue(
                project_id=secret_variable.project_id,
                branch_id=secret_variable.branch_id,
                variable_id=secret_variable.id,
                event_id=event.id,
                field_definition_id=uuid.UUID(secret_field_id),
                source_column="api_token",
                value_kind="low",
                observed_count=1,
                values=["sk_live_should_not_leak"],
            )
        )
    await client.patch(
        f"/api/v1/projects/search-ml/variables/{variable_id}",
        json={"description": "Идентификатор пользователя с контекстом"},
    )

    ru_resp = await client.get("/api/v1/projects/search-ml/search?q=завершение покупки")
    assert ru_resp.status_code == 200
    ru_items = ru_resp.json()["items"]
    event_hit = next(
        (
            item
            for item in ru_items
            if item["entity_type"] == "event" and item["title"] == "Checkout Completed"
        ),
        None,
    )
    assert event_hit is not None
    # The event's own description is returned verbatim for display, and every
    # result carries a confidence normalized to the top hit.
    assert event_hit["event_id"] == str(event_id)
    assert event_hit["name"] == "Checkout Completed"
    assert event_hit["implemented"] is False
    variable_contexts = event_hit["variable_values"]
    assert len(variable_contexts) == 1
    assert variable_contexts[0]["variable_id"] == str(variable_id)
    assert variable_contexts[0]["variable_name"] == "user_id"
    assert variable_contexts[0]["field_definition_id"] == field_id
    assert variable_contexts[0]["field_name"] == "screen"
    assert variable_contexts[0]["field_display_name"] == "Экран"
    assert variable_contexts[0]["source_column"] == "user_id"
    assert variable_contexts[0]["value_kind"] == "low"
    assert variable_contexts[0]["observed_count"] == 1
    assert variable_contexts[0]["values"] == ["vip_segment"]
    assert event_hit["description"] == "Fires when покупка успешно завершена"
    assert 0.0 <= event_hit["confidence"] <= 1.0
    assert ru_items[0]["confidence"] == 1.0

    en_resp = await client.get("/api/v1/projects/search-ml/search?q=checkout")
    assert en_resp.status_code == 200
    assert {item["entity_type"] for item in en_resp.json()["items"]} >= {"event", "event_type"}

    var_resp = await client.get("/api/v1/projects/search-ml/search?q=Идентификатор&types=variable")
    assert var_resp.status_code == 200
    assert [item["entity_type"] for item in var_resp.json()["items"]] == ["variable"]

    value_resp = await client.get("/api/v1/projects/search-ml/search?q=vip_segment&types=variable")
    assert value_resp.status_code == 200
    assert [item["title"] for item in value_resp.json()["items"]] == ["${user_id}"]

    # Querying a concrete observed property/context value should also surface
    # the owning event (not only the variable document).
    event_value_resp = await client.get("/api/v1/projects/search-ml/search?q=vip_segment")
    assert event_value_resp.status_code == 200
    event_value_items = event_value_resp.json()["items"]
    assert any(
        item["entity_type"] == "event" and item["title"] == "Checkout Completed"
        for item in event_value_items
    )


@pytest.mark.asyncio
async def test_event_list_search_is_plain_column_ilike(client: AsyncClient) -> None:
    """The list ``search`` is a plain substring filter over the event's own text
    columns (name/description/source_name) — NOT the semantic/hybrid search,
    which lives only in the global command palette. Field-value content is
    reachable via the dedicated ``field_value`` column filter instead."""
    await client.post("/api/v1/projects", json={"name": "Event Search", "slug": "search-events"})
    event_type_id, field_id = await _create_event_type(
        client,
        "search-events",
        name="page",
        display_name="Page",
    )
    await client.post(
        "/api/v1/projects/search-events/events",
        json={
            "event_type_id": event_type_id,
            "name": "Generic Event",
            "field_values": [{"field_definition_id": field_id, "value": "home_screen"}],
        },
    )
    await client.post(
        "/api/v1/projects/search-events/events",
        json={
            "event_type_id": event_type_id,
            "name": "Other Event",
            "field_values": [{"field_definition_id": field_id, "value": "settings_screen"}],
        },
    )

    # Free-text search matches the event name column...
    by_name = await client.get("/api/v1/projects/search-events/events?search=Generic")
    assert by_name.status_code == 200
    assert by_name.json()["total"] == 1
    assert by_name.json()["items"][0]["name"] == "Generic Event"

    # ...but NOT a field value (that is not one of the event's text columns).
    by_value = await client.get("/api/v1/projects/search-events/events?search=home_screen")
    assert by_value.status_code == 200
    assert by_value.json()["total"] == 0

    # Field-value content is filtered through the dedicated field_value param.
    by_field = await client.get("/api/v1/projects/search-events/events?field_value=home_screen")
    assert by_field.status_code == 200
    assert by_field.json()["total"] == 1
    assert by_field.json()["items"][0]["name"] == "Generic Event"


@pytest.mark.asyncio
async def test_search_filters_archived_and_excludes_sensitive_values(client: AsyncClient) -> None:
    await client.post("/api/v1/projects", json={"name": "Safety", "slug": "search-safe"})
    event_type_id, field_id = await _create_event_type(
        client,
        "search-safe",
        name="security",
        display_name="Security",
    )
    secret_resp = await client.post(
        f"/api/v1/projects/search-safe/event-types/{event_type_id}/fields",
        json={
            "name": "api_secret",
            "display_name": "API Secret",
            "field_type": "string",
            "sensitivity": "secret",
        },
    )
    assert secret_resp.status_code == 201
    secret_field_id = secret_resp.json()["id"]
    await client.post(
        "/api/v1/projects/search-safe/events",
        json={
            "event_type_id": event_type_id,
            "name": "Archived Secret",
            "archived": True,
            "field_values": [
                {"field_definition_id": field_id, "value": "archived_marker"},
                {"field_definition_id": secret_field_id, "value": "sk_live_should_not_index"},
            ],
        },
    )

    hidden_resp = await client.get("/api/v1/projects/search-safe/search?q=archived_marker")
    assert hidden_resp.status_code == 200
    assert hidden_resp.json()["items"] == []

    archived_resp = await client.get(
        "/api/v1/projects/search-safe/search?q=archived_marker&include_archived=true"
    )
    assert archived_resp.status_code == 200
    assert [item["title"] for item in archived_resp.json()["items"]] == ["Archived Secret"]

    secret_resp = await client.get(
        "/api/v1/projects/search-safe/search?q=sk_live_should_not_index&include_archived=true"
    )
    assert secret_resp.status_code == 200
    assert secret_resp.json()["items"] == []


def test_finalize_confidence_prefers_exact_token_value_matches() -> None:
    # Emulates the "ecmwf exists in property values" case:
    # the event that contains an exact token value should rank above
    # near/fuzzy matches when scores reflect exact-token boost.
    items = [
        _result(entity_type="event", title="spot:choose:models", score=6.5),
        _result(entity_type="event", title="map_model_selected_ecmwf", score=5.9),
        _result(entity_type="event", title="ecmwf_model_popup_shown", score=5.6),
    ]

    finalized = _finalize_results(items, limit=10)

    assert finalized[0].title == "spot:choose:models"
    assert finalized[0].confidence == 1.0
    assert finalized[1].confidence < 1.0

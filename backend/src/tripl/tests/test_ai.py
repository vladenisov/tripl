import json
import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.services import llm_service
from tripl.services.ai_service import _parse_describe_response, _strip_markdown_fences
from tripl.worker.tasks import alerts as alerts_task

# Importing metrics first initializes the worker task graph in dependency
# order; importing alerts directly would hit the celery_app ↔ metrics ↔ alerts
# import cycle (same pattern as test_alerting.py).
from tripl.worker.tasks import metrics as _metrics  # noqa: F401


async def _setup_event(client: AsyncClient, slug: str = "ai-proj") -> tuple[str, str]:
    await client.post("/api/v1/projects", json={"name": "AI", "slug": slug})
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et_resp.json()["id"]
    await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={
            "name": "screen",
            "display_name": "Screen",
            "field_type": "string",
        },
    )
    ev_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "Home Page View"},
    )
    return et_id, ev_resp.json()["id"]


# --- status / disabled gating ---


@pytest.mark.asyncio
async def test_ai_status_disabled_by_default(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "AI", "slug": "ai-status"})
    resp = await client.get("/api/v1/projects/ai-status/ai/status")
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False}


@pytest.mark.asyncio
async def test_describe_event_returns_503_when_disabled(client: AsyncClient):
    _, event_id = await _setup_event(client, "ai-503")
    resp = await client.post(
        "/api/v1/projects/ai-503/ai/describe-event",
        json={"event_id": event_id},
    )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_ask_returns_503_when_disabled(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "AI", "slug": "ai-ask-503"})
    resp = await client.post(
        "/api/v1/projects/ai-ask-503/ai/ask",
        json={"question": "which events exist?"},
    )
    assert resp.status_code == 503


# --- llm_service ---


def test_llm_complete_returns_none_when_disabled():
    assert llm_service.is_enabled() is False
    assert llm_service.complete("system", "user") is None


def test_llm_is_enabled_requires_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(llm_service.settings, "ai_enabled", True)
    monkeypatch.setattr(llm_service.settings, "ai_api_key", "")
    monkeypatch.setattr(llm_service.settings, "openai_api_key", "")
    assert llm_service.is_enabled() is False
    monkeypatch.setattr(llm_service.settings, "ai_api_key", "sk-test")
    assert llm_service.is_enabled() is True


# --- describe response parsing ---


def test_strip_markdown_fences_plain_passthrough():
    assert _strip_markdown_fences('{"a": 1}') == '{"a": 1}'


def test_strip_markdown_fences_removes_json_fence():
    fenced = '```json\n{"a": 1}\n```'
    assert _strip_markdown_fences(fenced) == '{"a": 1}'


def test_parse_describe_response_valid_json():
    raw = json.dumps(
        {
            "description": "Fires when the home page renders.",
            "field_suggestions": [{"field_name": "screen", "description": "Screen slug."}],
        }
    )
    parsed = _parse_describe_response(raw)
    assert parsed.description == "Fires when the home page renders."
    assert len(parsed.field_suggestions) == 1
    assert parsed.field_suggestions[0].field_name == "screen"


def test_parse_describe_response_invalid_json_falls_back_to_raw_text():
    parsed = _parse_describe_response("Just a plain sentence.")
    assert parsed.description == "Just a plain sentence."
    assert parsed.field_suggestions == []


def test_parse_describe_response_skips_malformed_suggestions():
    raw = json.dumps({"description": "d", "field_suggestions": ["oops", {"field_name": "x"}]})
    parsed = _parse_describe_response(raw)
    assert [s.field_name for s in parsed.field_suggestions] == ["x"]


# --- enabled API paths (LLM mocked) ---


def _enable_env_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_service.settings, "ai_enabled", True)
    monkeypatch.setattr(llm_service.settings, "ai_api_key", "sk-test")
    monkeypatch.setattr(llm_service.settings, "openai_api_key", "")


@pytest.mark.asyncio
async def test_describe_event_returns_suggestion(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    _, event_id = await _setup_event(client, "ai-describe")
    captured: dict[str, str] = {}

    def fake_complete(system_prompt: str, user_prompt: str, **kwargs: object) -> str:
        captured["user_prompt"] = user_prompt
        return json.dumps(
            {
                "description": "Home page render event.",
                "field_suggestions": [{"field_name": "screen", "description": "Screen slug."}],
            }
        )

    _enable_env_ai(monkeypatch)
    monkeypatch.setattr("tripl.services.llm_service.complete", fake_complete)

    resp = await client.post(
        "/api/v1/projects/ai-describe/ai/describe-event",
        json={"event_id": event_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["description"] == "Home page render event."
    assert data["field_suggestions"] == [
        {"field_name": "screen", "description": "Screen slug."}
    ]
    # The prompt carries the event identity and its fields.
    assert "Home Page View" in captured["user_prompt"]
    assert "screen" in captured["user_prompt"]


@pytest.mark.asyncio
async def test_describe_event_404_for_unknown_event(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    await _setup_event(client, "ai-404")
    _enable_env_ai(monkeypatch)
    resp = await client.post(
        "/api/v1/projects/ai-404/ai/describe-event",
        json={"event_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_describe_event_type_returns_suggestion(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    et_id, _ = await _setup_event(client, "ai-describe-et")
    _enable_env_ai(monkeypatch)
    monkeypatch.setattr(
        "tripl.services.llm_service.complete",
        lambda *a, **k: json.dumps({"description": "Page view family.", "field_suggestions": []}),
    )
    resp = await client.post(
        "/api/v1/projects/ai-describe-et/ai/describe-event-type",
        json={"event_type_id": et_id},
    )
    assert resp.status_code == 200
    assert resp.json()["description"] == "Page view family."


@pytest.mark.asyncio
async def test_ask_returns_answer_with_sources(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    await _setup_event(client, "ai-ask")
    # Reindex so the search context has documents to cite.
    await client.post("/api/v1/projects/ai-ask/search/reindex")
    _enable_env_ai(monkeypatch)
    monkeypatch.setattr(
        "tripl.services.llm_service.complete",
        lambda *a, **k: "Home Page View fires on home render [1].",
    )
    resp = await client.post(
        "/api/v1/projects/ai-ask/ai/ask",
        json={"question": "what page view events exist?"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "Home Page View" in data["answer"]
    assert isinstance(data["sources"], list)
    assert all({"title", "entity_type", "route_path"} <= set(s) for s in data["sources"])


@pytest.mark.asyncio
async def test_ask_degrades_gracefully_when_llm_returns_none(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    await _setup_event(client, "ai-ask-degrade")
    _enable_env_ai(monkeypatch)
    monkeypatch.setattr("tripl.services.llm_service.complete", lambda *a, **k: None)
    resp = await client.post(
        "/api/v1/projects/ai-ask-degrade/ai/ask",
        json={"question": "what events exist?"},
    )
    assert resp.status_code == 200
    assert "unavailable" in resp.json()["answer"]


# --- worker alert explanation ---


def _delivery_with_item() -> AlertDelivery:
    delivery = AlertDelivery(
        project_id=uuid.uuid4(),
        scan_config_id=uuid.uuid4(),
        destination_id=uuid.uuid4(),
        rule_id=uuid.uuid4(),
        matched_count=1,
    )
    item = AlertDeliveryItem(
        id=uuid.uuid4(),
        scope_type="event",
        scope_ref=str(uuid.uuid4()),
        scope_name="Home Page View",
        bucket=datetime(2026, 6, 10, 12, 0, tzinfo=UTC),
        direction="drop",
        actual_count=10,
        expected_count=100,
        absolute_delta=-90,
        percent_delta=-90.0,
    )
    delivery.items = [item]
    return delivery


def test_build_ai_explanation_returns_none_when_disabled():
    delivery = _delivery_with_item()
    result = alerts_task._build_ai_explanation(
        delivery,
        scan_name="main",
        project_name="AI",
        item_context_cache={},
    )
    assert result is None


def test_build_ai_explanation_includes_item_context(monkeypatch: pytest.MonkeyPatch):
    delivery = _delivery_with_item()
    item = delivery.items[0]
    captured: dict[str, str] = {}

    def fake_complete(system_prompt: str, user_prompt: str, **kwargs: object) -> str:
        captured["user_prompt"] = user_prompt
        return "The drop is isolated to the home screen."

    monkeypatch.setattr("tripl.services.llm_service.is_enabled", lambda: True)
    monkeypatch.setattr("tripl.services.llm_service.complete", fake_complete)

    result = alerts_task._build_ai_explanation(
        delivery,
        scan_name="main",
        project_name="AI",
        item_context_cache={item.id: ("▁▂▃", "platform=ios −90%")},
    )
    assert result == "The drop is isolated to the home screen."
    assert "Home Page View" in captured["user_prompt"]
    assert "drop" in captured["user_prompt"]
    assert "▁▂▃" in captured["user_prompt"]
    assert "platform=ios" in captured["user_prompt"]


def test_build_ai_explanation_swallows_llm_errors(monkeypatch: pytest.MonkeyPatch):
    delivery = _delivery_with_item()
    monkeypatch.setattr("tripl.services.llm_service.is_enabled", lambda: True)

    def boom(*args: object, **kwargs: object) -> str:
        raise RuntimeError("provider down")

    monkeypatch.setattr("tripl.services.llm_service.complete", boom)
    result = alerts_task._build_ai_explanation(
        delivery,
        scan_name="main",
        project_name="AI",
        item_context_cache={},
    )
    assert result is None


def test_append_ai_explanation_escapes_for_format():
    text = alerts_task._append_ai_explanation("body", "a<b & c", "telegram_html")
    assert text.startswith("body\n\nAI: ")
    assert "<b" not in text.split("AI: ", 1)[1]

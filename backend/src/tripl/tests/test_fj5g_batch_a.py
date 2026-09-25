"""Backend + contract slices of the tripl-fj5g leftovers, batch A.

* tripl-0zpq.371 — the dialect lint runs on metric save, not only in the preview;
* tripl-fj5g.8 — ``GET /metrics/{id}/generated-sql`` has the metric read's gate;
* tripl-fj5g.4 — ``ProjectResponse.can_mutate`` answers the editor gate per caller;
* tripl-fj5g.11 — ``GET /projects/{slug}/scans/activity`` is exact over all jobs;
* tripl-fj5g.17 — the realtime ``hello`` carries the current sequence number;
* tripl-fj5g.9 — the shared definition-change case table, run through the service.
"""

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter

from tripl import realtime
from tripl.api.deps import get_current_user
from tripl.main import app
from tripl.models.domain_enums import UserRole
from tripl.models.metric_definition import MetricDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob
from tripl.models.user import User
from tripl.schemas.metric_definition import MetricDefinitionConfigUpdate
from tripl.services.metric_definition_service import _definition_values_changed
from tripl.tests.conftest import TestSessionLocal

PASSWORD = "Password123!"

# A query only ClickHouse can run: ``toStartOfInterval`` does not exist on PostgreSQL.
CLICKHOUSE_ONLY_SQL = (
    "SELECT toStartOfInterval(ts, INTERVAL 1 hour) AS t, count(*) AS value FROM events GROUP BY 1"
)
PORTABLE_SQL = "SELECT ts AS t, count(*) AS value FROM events GROUP BY 1"


def _metrics_url(slug: str) -> str:
    return f"/api/v1/projects/{slug}/metrics"


async def _create_project(client: AsyncClient, slug: str) -> dict[str, Any]:
    resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_data_source(client: AsyncClient, db_type: str, name: str) -> dict[str, Any]:
    """A workspace-global data source no project scans: bindable from every project."""
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": name,
            "db_type": db_type,
            "host": "localhost",
            "port": 5432 if db_type == "postgres" else 8123,
            "database_name": "analytics",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sql_metric(name: str, data_source_id: str, metric_sql: str) -> dict[str, Any]:
    return {
        "kind": "sql",
        "name": name,
        "display_name": name,
        "data_source_id": data_source_id,
        "interval": "1h",
        "config": {"metric_sql": metric_sql, "time_column": "t"},
    }


# ── tripl-0zpq.371: dialect lint on save ────────────────────────────────────


async def test_sql_metric_save_refuses_sql_the_warehouse_cannot_run(client: AsyncClient) -> None:
    project = await _create_project(client, "lint-save")
    postgres = await _create_data_source(client, "postgres", "PG")

    resp = await client.post(
        _metrics_url(project["slug"]),
        json=_sql_metric("hourly", postgres["id"], CLICKHOUSE_ONLY_SQL),
    )

    assert resp.status_code == 422, resp.text
    # The preview's own sentence, naming the function and the warehouse.
    assert "toStartOfInterval is a ClickHouse function" in resp.json()["detail"]
    assert "PostgreSQL" in resp.json()["detail"]


async def test_sql_metric_save_accepts_sql_for_its_own_dialect(client: AsyncClient) -> None:
    project = await _create_project(client, "lint-ok")
    clickhouse = await _create_data_source(client, "clickhouse", "CH")

    resp = await client.post(
        _metrics_url(project["slug"]),
        json=_sql_metric("hourly", clickhouse["id"], CLICKHOUSE_ONLY_SQL),
    )

    assert resp.status_code == 201, resp.text


async def test_update_lints_only_sql_that_changed(client: AsyncClient) -> None:
    project = await _create_project(client, "lint-update")
    postgres = await _create_data_source(client, "postgres", "PG")
    created = await client.post(
        _metrics_url(project["slug"]),
        json=_sql_metric("legacy", postgres["id"], PORTABLE_SQL),
    )
    assert created.status_code == 201, created.text
    metric_id = created.json()["id"]
    # A metric stored before the save-time lint existed, with SQL it now refuses.
    async with TestSessionLocal() as session:
        row = await session.get(MetricDefinition, uuid.UUID(metric_id))
        assert row is not None
        row.config = {**dict(row.config or {}), "metric_sql": CLICKHOUSE_ONLY_SQL}
        await session.commit()
    url = f"{_metrics_url(project['slug'])}/{metric_id}"

    renamed = await client.patch(url, json={"display_name": "Legacy, renamed"})
    assert renamed.status_code == 200, renamed.text

    # The form resends the unchanged definition with every save.
    resent = await client.patch(
        url,
        json={
            "display_name": "Legacy, renamed again",
            "definition": {
                "kind": "sql",
                "data_source_id": postgres["id"],
                "interval": "1h",
                "config": {"metric_sql": CLICKHOUSE_ONLY_SQL, "time_column": "t"},
            },
        },
    )
    assert resent.status_code == 200, resent.text

    edited = await client.patch(
        url,
        json={
            "definition": {
                "kind": "sql",
                "data_source_id": postgres["id"],
                "interval": "1h",
                "config": {
                    "metric_sql": CLICKHOUSE_ONLY_SQL.replace("count(*)", "count(1)"),
                    "time_column": "t",
                },
            },
        },
    )
    assert edited.status_code == 422, edited.text
    assert "toStartOfInterval" in edited.json()["detail"]


async def test_update_lints_unchanged_sql_moved_to_another_dialect(client: AsyncClient) -> None:
    project = await _create_project(client, "lint-move")
    clickhouse = await _create_data_source(client, "clickhouse", "CH")
    postgres = await _create_data_source(client, "postgres", "PG")
    created = await client.post(
        _metrics_url(project["slug"]),
        json=_sql_metric("moved", clickhouse["id"], CLICKHOUSE_ONLY_SQL),
    )
    assert created.status_code == 201, created.text

    moved = await client.patch(
        f"{_metrics_url(project['slug'])}/{created.json()['id']}",
        json={
            "definition": {
                "kind": "sql",
                "data_source_id": postgres["id"],
                "interval": "1h",
                "config": {"metric_sql": CLICKHOUSE_ONLY_SQL, "time_column": "t"},
            },
        },
    )

    assert moved.status_code == 422, moved.text


async def test_fact_metric_save_lints_filter_sql_against_the_fact_tables_warehouse(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, "lint-fact")
    postgres = await _create_data_source(client, "postgres", "PG")
    fact_table = await client.post(
        f"/api/v1/projects/{project['slug']}/fact-tables",
        json={
            "name": "orders",
            "display_name": "Orders",
            "sql": "SELECT created_at, amount FROM orders",
            "timestamp_column": "created_at",
            "data_source_id": postgres["id"],
            "columns": [
                {"name": "created_at", "type": "timestamp"},
                {"name": "amount", "type": "number"},
            ],
        },
    )
    assert fact_table.status_code == 201, fact_table.text

    resp = await client.post(
        _metrics_url(project["slug"]),
        json={
            "kind": "fact",
            "name": "big_orders",
            "display_name": "Big orders",
            "composition": "single",
            "fact_table_id": fact_table.json()["id"],
            "aggregation": "count",
            "interval": "1h",
            "filter_sql": "countIf(amount > 10) > 0",
        },
    )

    assert resp.status_code == 422, resp.text
    assert "countIf" in resp.json()["detail"]


# ── tripl-fj5g.8: generated SQL is readable by anyone who reads the metric ──


async def test_viewer_reads_generated_sql(client: AsyncClient) -> None:
    project = await _create_project(client, "gen-sql-viewer")
    clickhouse = await _create_data_source(client, "clickhouse", "CH")
    fact_table = await client.post(
        f"/api/v1/projects/{project['slug']}/fact-tables",
        json={
            "name": "orders",
            "display_name": "Orders",
            "sql": "SELECT created_at, amount FROM orders",
            "timestamp_column": "created_at",
            "data_source_id": clickhouse["id"],
            "columns": [
                {"name": "created_at", "type": "timestamp"},
                {"name": "amount", "type": "number"},
            ],
        },
    )
    assert fact_table.status_code == 201, fact_table.text
    metric = await client.post(
        _metrics_url(project["slug"]),
        json={
            "kind": "fact",
            "name": "orders_count",
            "display_name": "Orders",
            "composition": "single",
            "fact_table_id": fact_table.json()["id"],
            "aggregation": "count",
            "interval": "1d",
        },
    )
    assert metric.status_code == 201, metric.text
    url = f"{_metrics_url(project['slug'])}/{metric.json()['id']}"

    async def _viewer() -> User:
        return User(
            id=uuid.uuid4(),
            email="viewer@example.com",
            name="Viewer",
            password_hash="x",
            role=UserRole.viewer.value,
        )

    app.dependency_overrides[get_current_user] = _viewer
    try:
        definition = await client.get(url)
        generated = await client.get(f"{url}/generated-sql")
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    # Same gate as the metric read itself: the SQL is built from config that
    # read already returns.
    assert definition.status_code == 200, definition.text
    assert generated.status_code == 200, generated.text
    assert generated.json()["queries"], generated.text


# ── tripl-fj5g.4: can_mutate on ProjectResponse ─────────────────────────────


def _new_client() -> AsyncClient:
    """A client with its own cookie jar, so several roles can act interleaved."""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _register(client: AsyncClient, email: str) -> dict[str, Any]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "name": email.split("@")[0]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _can_mutate(client: AsyncClient, slug: str, **kwargs: Any) -> bool:
    resp = await client.get(f"/api/v1/projects/{slug}", **kwargs)
    assert resp.status_code == 200, resp.text
    return bool(resp.json()["can_mutate"])


async def test_can_mutate_follows_the_editor_gate_per_caller() -> None:
    owner, editor, other_editor, viewer = (_new_client() for _ in range(4))
    try:
        # The first registered user is the instance owner; later ones are editors.
        await _register(owner, "owner@example.com")
        await _register(editor, "editor@example.com")
        await _register(other_editor, "other@example.com")
        viewer_user = await _register(viewer, "viewer@example.com")
        demote = await owner.patch(f"/api/v1/users/{viewer_user['id']}", json={"role": "viewer"})
        assert demote.status_code == 200, demote.text
        relogin = await viewer.post(
            "/api/v1/auth/login", json={"email": "viewer@example.com", "password": PASSWORD}
        )
        assert relogin.status_code == 200, relogin.text

        await _create_project(owner, "shared")
        created = await _create_project(other_editor, "theirs")
        # The creating editor's own response already says so.
        assert created["can_mutate"] is True

        # A project another EDITOR created: the role alone says yes, the gate no.
        assert await _can_mutate(editor, "theirs") is False
        assert await _can_mutate(other_editor, "theirs") is True
        assert await _can_mutate(owner, "theirs") is True
        # The shared workspace project an owner created is open to every editor.
        assert await _can_mutate(editor, "shared") is True
        assert await _can_mutate(viewer, "shared") is False

        # The list answers per project, for the caller asking.
        listed = await editor.get("/api/v1/projects")
        assert listed.status_code == 200, listed.text
        by_slug = {item["slug"]: item["can_mutate"] for item in listed.json()}
        assert by_slug == {"shared": True, "theirs": False}

        # The mutation itself agrees with the flag.
        refused = await editor.post(
            "/api/v1/projects/theirs/event-types", json={"name": "pv", "display_name": "PV"}
        )
        assert refused.status_code == 403, refused.text
    finally:
        for c in (owner, editor, other_editor, viewer):
            await c.aclose()


async def test_can_mutate_is_false_for_a_read_scope_api_key(client: AsyncClient) -> None:
    await _create_project(client, "keyed")
    minted = await client.post("/api/v1/me/api-keys", json={"name": "reader", "scope": "read"})
    assert minted.status_code == 201, minted.text
    headers = {"Authorization": f"Bearer {minted.json()['token']}"}

    async with _new_client() as bearer_only:
        # The owner's own session can write; the owner's read key cannot.
        assert await _can_mutate(client, "keyed") is True
        assert await _can_mutate(bearer_only, "keyed", headers=headers) is False


# ── tripl-fj5g.11: exact scan activity ─────────────────────────────────────


async def test_scan_activity_is_exact_over_the_whole_history(client: AsyncClient) -> None:
    project = await _create_project(client, "activity")
    data_source = await _create_data_source(client, "clickhouse", "CH")
    now = datetime.now(UTC)
    async with TestSessionLocal() as session:
        busy = ScanConfig(
            project_id=uuid.UUID(project["id"]),
            data_source_id=uuid.UUID(data_source["id"]),
            name="busy",
            base_query="SELECT 1",
        )
        mixed = ScanConfig(
            project_id=uuid.UUID(project["id"]),
            data_source_id=uuid.UUID(data_source["id"]),
            name="mixed",
            base_query="SELECT 1",
        )
        idle = ScanConfig(
            project_id=uuid.UUID(project["id"]),
            data_source_id=uuid.UUID(data_source["id"]),
            name="idle",
            base_query="SELECT 1",
        )
        session.add_all([busy, mixed, idle])
        await session.flush()

        def job(
            config: ScanConfig, status: str, age: timedelta, summary: dict[str, object] | None
        ) -> ScanJob:
            stamp = now - age
            return ScanJob(
                scan_config_id=config.id,
                status=status,
                created_at=stamp,
                updated_at=stamp,
                started_at=None if status == "pending" else stamp,
                completed_at=None if status in {"pending", "running"} else stamp,
                result_summary=summary,
            )

        # busy: an old success outside the window, then 12 failures inside it —
        # more than the list's 10-job page — and a queued retry on top.
        session.add(job(busy, "completed", timedelta(hours=30), {"query_rows_scanned": 1000}))
        for index in range(12):
            session.add(
                job(
                    busy,
                    "failed",
                    timedelta(hours=12, minutes=-index),
                    {"query_rows_scanned": 10},
                )
            )
        session.add(job(busy, "pending", timedelta(minutes=1), None))
        # mixed: a cancelled run ends a streak; rows fall back to scan_rows_processed.
        session.add(job(mixed, "failed", timedelta(hours=5), None))
        session.add(job(mixed, "cancelled", timedelta(hours=4), None))
        session.add(job(mixed, "completed", timedelta(hours=3), {"scan_rows_processed": 500}))
        session.add(job(mixed, "failed", timedelta(hours=2), None))
        await session.commit()
        ids = {"busy": str(busy.id), "mixed": str(mixed.id), "idle": str(idle.id)}

    resp = await client.get(f"/api/v1/projects/{project['slug']}/scans/activity")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    items = {item["scan_config_id"]: item for item in body["items"]}
    assert set(items) == set(ids.values())

    busy_item = items[ids["busy"]]
    assert busy_item["failing_streak"] == 12
    assert busy_item["rows_read_24h"] == 120
    assert busy_item["latest_job"]["status"] == "pending"

    mixed_item = items[ids["mixed"]]
    assert mixed_item["failing_streak"] == 1
    assert mixed_item["rows_read_24h"] == 500
    assert mixed_item["latest_job"]["status"] == "failed"

    idle_item = items[ids["idle"]]
    assert idle_item == {
        "scan_config_id": ids["idle"],
        "latest_job": None,
        "failing_streak": 0,
        "rows_read_24h": 0,
    }


async def test_scan_activity_route_is_not_shadowed_by_the_scan_id_route(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, "activity-empty")

    resp = await client.get(f"/api/v1/projects/{project['slug']}/scans/activity")

    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == []


# ── tripl-fj5g.17: the hello carries the sequence number ───────────────────


class _FakeAsyncRedis:
    def __init__(self, seq: bytes | None) -> None:
        self._seq = seq

    async def get(self, _key: str) -> bytes | None:
        return self._seq

    async def lrange(self, _key: str, _start: int, _end: int) -> list[str]:
        return []


class _IdlePubSub:
    async def subscribe(self, *_channels: str) -> None:
        return None

    async def get_message(self, **_kwargs: Any) -> None:
        return None

    async def unsubscribe(self, *_channels: str) -> None:
        return None

    async def aclose(self) -> None:
        return None


class _IdlePubSubClient:
    def pubsub(self) -> _IdlePubSub:
        return _IdlePubSub()


async def _never_disconnected() -> bool:
    return False


async def _hello_data(frames: AsyncIterator[str]) -> dict[str, Any]:
    # ``max_messages=0`` greets, replays and returns, so the stream is finite.
    first, *_rest = [frame async for frame in frames]
    assert "event: hello" in first
    data_line = next(line for line in first.splitlines() if line.startswith("data: "))
    hello: dict[str, Any] = json.loads(data_line.removeprefix("data: "))
    return hello


@pytest.mark.parametrize(("stored", "expected"), [(b"42", 42), (None, 0)])
async def test_hello_carries_the_current_sequence_and_ring_size(
    monkeypatch: pytest.MonkeyPatch, stored: bytes | None, expected: int
) -> None:
    monkeypatch.setattr(realtime.cache, "get_async_pubsub_client", lambda: _IdlePubSubClient())
    monkeypatch.setattr(realtime.cache, "get_async_client", lambda: _FakeAsyncRedis(stored))

    hello = await _hello_data(
        realtime.project_response_stream(
            slug="p",
            last_event_id=None,
            is_disconnected=_never_disconnected,
            max_messages=0,
        )
    )

    assert hello == {
        "project_slug": "p",
        "backend": "redis",
        "seq": expected,
        "buffer_size": realtime.BUFFER_SIZE,
    }


async def test_degraded_hello_has_no_sequence(client: AsyncClient) -> None:
    await _create_project(client, "stream-seq")

    resp = await client.get("/api/v1/projects/stream-seq/events/stream?max_events=0")

    assert resp.status_code == 200
    data_line = next(line for line in resp.text.splitlines() if line.startswith("data: "))
    hello = json.loads(data_line.removeprefix("data: "))
    # Redis is off in tests: the client cannot tell what it missed, so it resyncs.
    assert hello["backend"] == "degraded"
    assert hello["seq"] is None
    assert hello["buffer_size"] == realtime.BUFFER_SIZE


# ── tripl-fj5g.9: the shared definition-change case table ──────────────────

_CASES_PATH = (
    Path(__file__).resolve().parents[4] / "frontend/src/pages/metrics/definition-change-cases.json"
)
_CASES: list[dict[str, Any]] = json.loads(_CASES_PATH.read_text(encoding="utf-8"))["cases"]
_UUID_COLUMNS = (
    "fact_table_id",
    "data_source_id",
    "numerator_event_id",
    "numerator_event_type_id",
    "denominator_event_id",
    "denominator_event_type_id",
)
_DEFINITION = TypeAdapter(MetricDefinitionConfigUpdate)


def _stored_metric(stored: dict[str, Any]) -> MetricDefinition:
    columns = {
        key: (uuid.UUID(value) if key in _UUID_COLUMNS and value is not None else value)
        for key, value in stored.items()
    }
    return MetricDefinition(project_id=uuid.uuid4(), name="m", display_name="M", **columns)


def test_the_shared_case_table_is_not_empty() -> None:
    assert len(_CASES) >= 10


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_service_agrees_with_the_shared_case_table(case: dict[str, Any]) -> None:
    """The deletion the backend performs is the one the form warns about."""
    metric = _stored_metric(case["stored"])
    new_values = _DEFINITION.validate_python(case["submitted"]).to_definition_values()

    assert _definition_values_changed(metric, new_values) is case["expect_history_reset"]

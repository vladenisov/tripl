import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from tripl.models.event_metric import EventMetric
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.scan_job import ScanJob
from tripl.tests.conftest import TestSessionLocal


async def _seed_project_operations(
    *,
    scan_config_id: str,
    event_type_id: str,
) -> None:
    metric_bucket = datetime(2026, 4, 18, 9, tzinfo=UTC)
    job_started_at = datetime(2026, 4, 18, 10, tzinfo=UTC)
    job_completed_at = datetime(2026, 4, 18, 10, 5, tzinfo=UTC)

    async with TestSessionLocal() as session:
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=metric_bucket,
                count=42,
            )
        )
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=metric_bucket,
                actual_count=42,
                expected_count=21,
                stddev=3,
                z_score=7,
                direction="spike",
            )
        )
        session.add(
            ScanJob(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                status="completed",
                started_at=job_started_at,
                completed_at=job_completed_at,
                result_summary={
                    "events_created": 4,
                    "signals_added": 1,
                    "alerts_queued": 1,
                },
                error_message=None,
                created_at=job_completed_at,
                updated_at=job_completed_at,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_create_project(client: AsyncClient):
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Test Project", "slug": "test-project", "description": "A test"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Test Project"
    assert data["slug"] == "test-project"


@pytest.mark.asyncio
async def test_create_project_duplicate_slug(client: AsyncClient):
    await client.post(
        "/api/v1/projects",
        json={"name": "P1", "slug": "dup-slug"},
    )
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "P2", "slug": "dup-slug"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_projects(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "A", "slug": "list-a"})
    await client.post("/api/v1/projects", json={"name": "B", "slug": "list-b"})
    resp = await client.get("/api/v1/projects")
    assert resp.status_code == 200
    assert len(resp.json()) >= 2
    assert "summary" in resp.json()[0]


@pytest.mark.asyncio
async def test_get_project(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "Get Me", "slug": "get-me"})
    resp = await client.get("/api/v1/projects/get-me")
    assert resp.status_code == 200
    assert resp.json()["slug"] == "get-me"
    assert resp.json()["summary"]["event_count"] == 0
    assert resp.json()["summary"]["latest_scan_job"] is None
    assert resp.json()["summary"]["latest_signal"] is None


@pytest.mark.asyncio
async def test_get_project_not_found(client: AsyncClient):
    resp = await client.get("/api/v1/projects/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_project(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "Old", "slug": "upd-me"})
    resp = await client.patch("/api/v1/projects/upd-me", json={"name": "New"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "New"


@pytest.mark.asyncio
async def test_update_project_slug(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "Slug me", "slug": "slug-old"})
    resp = await client.patch("/api/v1/projects/slug-old", json={"slug": "slug-new"})
    assert resp.status_code == 200
    assert resp.json()["slug"] == "slug-new"

    old = await client.get("/api/v1/projects/slug-old")
    assert old.status_code == 404
    new = await client.get("/api/v1/projects/slug-new")
    assert new.status_code == 200


@pytest.mark.asyncio
async def test_update_project_slug_conflict(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "First", "slug": "taken-slug"})
    await client.post("/api/v1/projects", json={"name": "Second", "slug": "free-slug"})
    resp = await client.patch("/api/v1/projects/free-slug", json={"slug": "taken-slug"})
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_delete_project(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "Del", "slug": "del-me"})
    resp = await client.delete("/api/v1/projects/del-me")
    assert resp.status_code == 204
    resp = await client.get("/api/v1/projects/del-me")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_project_summary_counts(client: AsyncClient):
    slug = "summary-proj"

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Summary Project", "slug": slug},
    )
    assert project_resp.status_code == 201

    event_type_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "page_view", "display_name": "Page View"},
    )
    assert event_type_resp.status_code == 201
    event_type_id = event_type_resp.json()["id"]

    active_event_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "Landing Viewed",
            "status": "implemented",
        },
    )
    assert active_event_resp.status_code == 201

    review_event_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "Checkout Started",
            "status": "in_review",
        },
    )
    assert review_event_resp.status_code == 201

    archived_event_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "Legacy Event",
            "status": "archived",
        },
    )
    assert archived_event_resp.status_code == 201

    variable_resp = await client.post(
        f"/api/v1/projects/{slug}/variables",
        json={"name": "user_id", "variable_type": "string"},
    )
    assert variable_resp.status_code == 201

    data_source_resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Warehouse",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "analytics",
            "username": "default",
            "password": "",
        },
    )
    assert data_source_resp.status_code == 201
    data_source_id = data_source_resp.json()["id"]

    scan_resp = await client.post(
        f"/api/v1/projects/{slug}/scans",
        json={
            "data_source_id": data_source_id,
            "name": "Production scan",
            "base_query": "SELECT 1",
        },
    )
    assert scan_resp.status_code == 201
    scan_config_id = scan_resp.json()["id"]

    destination_resp = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations",
        json={
            "type": "slack",
            "name": "Ops",
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    assert destination_resp.status_code == 201

    await _seed_project_operations(
        scan_config_id=scan_config_id,
        event_type_id=event_type_id,
    )

    resp = await client.get(f"/api/v1/projects/{slug}")
    assert resp.status_code == 200
    summary = resp.json()["summary"]

    assert summary["event_type_count"] == 1
    assert summary["event_count"] == 3
    assert summary["active_event_count"] == 2
    assert summary["implemented_event_count"] == 1
    assert summary["review_pending_event_count"] == 1
    assert summary["archived_event_count"] == 1
    assert summary["variable_count"] == 1
    assert summary["scan_count"] == 1
    assert summary["alert_destination_count"] == 1
    assert summary["monitoring_signal_count"] == 1
    assert summary["latest_scan_job"] == {
        "id": summary["latest_scan_job"]["id"],
        "scan_config_id": scan_config_id,
        "scan_name": "Production scan",
        "status": "completed",
        "started_at": "2026-04-18T10:00:00",
        "completed_at": "2026-04-18T10:05:00",
        "result_summary": {
            "events_created": 4,
            "signals_added": 1,
            "alerts_queued": 1,
        },
        "error_message": None,
        "created_at": "2026-04-18T10:05:00",
    }
    assert summary["latest_signal"] == {
        "scan_config_id": scan_config_id,
        "scan_name": "Production scan",
        "scope_type": "event_type",
        "scope_ref": event_type_id,
        "scope_name": "Page View",
        "state": "latest_scan",
        "bucket": "2026-04-18T09:00:00",
        "actual_count": 42,
        "expected_count": 21.0,
        "z_score": 7.0,
        "direction": "spike",
    }

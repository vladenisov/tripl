import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from tripl.models.alert_delivery import AlertDelivery
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.scan_job import ScanJob
from tripl.tests.conftest import TestSessionLocal


@pytest.mark.asyncio
async def test_project_activity_feed_uses_real_backend_records(client: AsyncClient):
    slug = "activity-proj"
    await client.post("/api/v1/projects", json={"name": "Activity Project", "slug": slug})

    event_type_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "page_view", "display_name": "Page View"},
    )
    event_type_id = event_type_resp.json()["id"]

    await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": event_type_id,
            "name": "Landing Viewed",
            "status": "in_review",
        },
    )

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
    scan_resp = await client.post(
        f"/api/v1/projects/{slug}/scans",
        json={
            "data_source_id": data_source_resp.json()["id"],
            "name": "Production scan",
            "base_query": "SELECT 1",
        },
    )
    scan_config_id = scan_resp.json()["id"]

    destination_resp = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations",
        json={
            "type": "slack",
            "name": "Ops",
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    destination_id = destination_resp.json()["id"]
    rule_resp = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations/{destination_id}/rules",
        json={"name": "Spike alerts"},
    )
    rule_id = rule_resp.json()["id"]
    project_id = destination_resp.json()["project_id"]

    created_at = datetime(2026, 4, 18, 9, tzinfo=UTC)
    async with TestSessionLocal() as session:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=created_at,
                actual_count=42,
                expected_count=21,
                stddev=3,
                z_score=7,
                direction="spike",
                created_at=created_at,
            )
        )
        session.add(
            ScanJob(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                status="completed",
                started_at=datetime(2026, 4, 18, 10, tzinfo=UTC),
                completed_at=datetime(2026, 4, 18, 10, 5, tzinfo=UTC),
                result_summary={"events_created": 4, "signals_added": 1},
                error_message=None,
                created_at=datetime(2026, 4, 18, 10, 5, tzinfo=UTC),
                updated_at=datetime(2026, 4, 18, 10, 5, tzinfo=UTC),
            )
        )
        session.add(
            AlertDelivery(
                id=uuid.uuid4(),
                project_id=uuid.UUID(project_id),
                scan_config_id=uuid.UUID(scan_config_id),
                scan_job_id=None,
                destination_id=uuid.UUID(destination_id),
                rule_id=uuid.UUID(rule_id),
                status="sent",
                channel="slack",
                matched_count=1,
                payload_snapshot={"preview": "one alert"},
                error_message=None,
                sent_at=datetime(2026, 4, 18, 11, tzinfo=UTC),
                created_at=datetime(2026, 4, 18, 10, 59, tzinfo=UTC),
                updated_at=datetime(2026, 4, 18, 11, tzinfo=UTC),
            )
        )
        await session.commit()

    resp = await client.get(f"/api/v1/activity/projects/{slug}?limit=10")
    assert resp.status_code == 200
    items = resp.json()

    assert all(item["project_slug"] == slug for item in items)
    assert any(
        item["type"] == "anomaly" and item["title"] == "Spike on Page View" for item in items
    )
    assert any(
        item["type"] == "scan" and item["title"] == "Scan completed: Production scan"
        for item in items
    )
    assert any(
        item["type"] == "alert" and item["title"] == "Alert sent: Spike alerts" for item in items
    )
    assert any(
        item["type"] == "event" and item["title"] == "Event needs review: Landing Viewed"
        for item in items
    )
    event_items = [item for item in items if item["type"] == "event"]
    assert event_items, "expected an event activity item"
    assert all(
        item["target_path"].startswith(f"/p/{slug}/monitoring/event/") for item in event_items
    )
    assert not any("/events/detail/" in (item["target_path"] or "") for item in items)


@pytest.mark.asyncio
async def test_project_activity_feed_returns_404_for_unknown_project(client: AsyncClient):
    resp = await client.get("/api/v1/activity/projects/missing-project")
    assert resp.status_code == 404

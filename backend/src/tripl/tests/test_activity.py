import uuid
from datetime import UTC, datetime, timedelta

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

    # The anomaly must be recent: the activity rail only surfaces anomalies
    # inside ANOMALY_RECENCY_WINDOW, so a fixed historical timestamp would be
    # filtered out and this assertion would flake as wall-clock time advances.
    anomaly_created_at = datetime.now(UTC)
    async with TestSessionLocal() as session:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=anomaly_created_at,
                actual_count=42,
                expected_count=21,
                stddev=3,
                z_score=7,
                direction="spike",
                created_at=anomaly_created_at,
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
async def test_activity_feed_excludes_stale_anomalies(client: AsyncClient):
    """A week-old anomaly must drop off the rail while a fresh one stays.

    Regression for the 'Now' rail pinning weeks-old high-z anomalies at the top
    of the feed on every page (tripl-dmch.13).
    """
    slug = "activity-recency"
    await client.post("/api/v1/projects", json={"name": "Recency Project", "slug": slug})

    event_type_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "page_view", "display_name": "Page View"},
    )
    event_type_id = event_type_resp.json()["id"]

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

    now = datetime.now(UTC)
    fresh_at = now - timedelta(hours=1)
    # Comfortably outside the 7-day window, mirroring the reported z=16.7 rows.
    stale_at = now - timedelta(days=30)
    async with TestSessionLocal() as session:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=fresh_at,
                actual_count=42,
                expected_count=21,
                stddev=3,
                z_score=7,
                direction="spike",
                created_at=fresh_at,
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
                bucket=stale_at,
                actual_count=900,
                expected_count=10,
                stddev=2,
                z_score=16,
                direction="spike",
                created_at=stale_at,
            )
        )
        await session.commit()

    resp = await client.get(f"/api/v1/activity/projects/{slug}?limit=20")
    assert resp.status_code == 200
    anomaly_items = [item for item in resp.json() if item["type"] == "anomaly"]

    assert len(anomaly_items) == 1, "only the fresh anomaly should surface"
    detail = anomaly_items[0]["detail"]
    assert "42 actual" in detail
    assert "z=7" in detail
    # The 30-day-old anomaly (z=16) must not leak into the rail.
    assert "900 actual" not in detail
    assert not any("z=16" in item["detail"] for item in anomaly_items)


@pytest.mark.asyncio
async def test_activity_feed_collapses_one_incident_into_one_rail_item(client: AsyncClient):
    """A project-total spike and its child event_type spike are one incident.

    They share a scan, bucket and direction, so the Now rail must surface the
    single parent project_total item and suppress the co-firing child instead of
    stacking both. Layered on top of Wave 1's recency filter (tripl-dmch.12).
    """
    slug = "activity-incident"
    await client.post("/api/v1/projects", json={"name": "Incident Rail", "slug": slug})

    event_type_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "page_view", "display_name": "Page View"},
    )
    event_type_id = event_type_resp.json()["id"]

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

    at = datetime.now(UTC) - timedelta(hours=1)
    async with TestSessionLocal() as session:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="project_total",
                scope_ref=scan_config_id,
                event_id=None,
                event_type_id=None,
                bucket=at,
                actual_count=480,
                expected_count=120,
                stddev=40,
                z_score=9,
                direction="spike",
                created_at=at,
            )
        )
        # Child of the SAME incident: same scan, same bucket, same direction.
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=at,
                actual_count=300,
                expected_count=90,
                stddev=30,
                z_score=7,
                direction="spike",
                created_at=at,
            )
        )
        await session.commit()

    resp = await client.get(f"/api/v1/activity/projects/{slug}?limit=20")
    assert resp.status_code == 200
    anomaly_items = [item for item in resp.json() if item["type"] == "anomaly"]

    assert len(anomaly_items) == 1, anomaly_items
    # The surviving rail item is the parent project_total, not the child scope.
    assert anomaly_items[0]["title"] == "Spike on Incident Rail total"
    assert "/monitoring/project-total/" in anomaly_items[0]["target_path"]


@pytest.mark.asyncio
async def test_project_activity_feed_returns_404_for_unknown_project(client: AsyncClient):
    resp = await client.get("/api/v1/activity/projects/missing-project")
    assert resp.status_code == 404

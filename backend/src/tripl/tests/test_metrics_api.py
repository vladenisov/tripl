import uuid
from datetime import UTC, datetime, timedelta
from typing import TypedDict

import pytest
from httpx import AsyncClient

from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.tests.conftest import TestSessionLocal


class EventMetricSeedRow(TypedDict):
    event_id: str
    counts: list[int]


def _plain_point(bucket: str, count: int) -> dict[str, object]:
    return {
        "bucket": bucket,
        "count": count,
        "expected_count": None,
        "stddev": None,
        "is_anomaly": False,
        "anomaly_direction": None,
        "z_score": None,
    }


async def _setup_metrics_project(
    client: AsyncClient,
    slug: str = "metrics-api",
) -> dict[str, str]:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Metrics API", "slug": slug},
    )
    project_id = project_resp.json()["id"]

    event_types: list[tuple[str, str]] = []
    for name, display_name in [("page", "Page"), ("track", "Track")]:
        et_resp = await client.post(
            f"/api/v1/projects/{slug}/event-types",
            json={"name": name, "display_name": display_name},
        )
        et_id = et_resp.json()["id"]
        field_resp = await client.post(
            f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
            json={
                "name": "screen",
                "display_name": "Screen",
                "field_type": "string",
                "is_required": True,
            },
        )
        event_types.append((et_id, field_resp.json()["id"]))

    return {
        "project_id": project_id,
        "page_type_id": event_types[0][0],
        "page_field_id": event_types[0][1],
        "track_type_id": event_types[1][0],
        "track_field_id": event_types[1][1],
    }


async def _seed_group_metrics(project_id: str, event_rows: list[EventMetricSeedRow]) -> None:
    buckets = [
        datetime(2026, 1, 1, 10, tzinfo=UTC),
        datetime(2026, 1, 1, 11, tzinfo=UTC),
    ]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Metrics DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(project_id),
            event_type_id=None,
            name="Metrics Config",
            base_query="SELECT time, event_name FROM events",
            event_type_column="event_name",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])

        for event_row in event_rows:
            for bucket, count in zip(buckets, event_row["counts"], strict=True):
                session.add(
                    EventMetric(
                        id=uuid.uuid4(),
                        scan_config_id=scan_config.id,
                        event_id=uuid.UUID(event_row["event_id"]),
                        event_type_id=None,
                        bucket=bucket,
                        count=count,
                    )
                )

        await session.commit()


async def _seed_monitoring_metrics(
    *,
    project_id: str,
    page_type_id: str,
    event_id: str,
) -> str:
    stable_bucket = datetime(2026, 1, 1, 10, tzinfo=UTC)
    anomaly_bucket = datetime(2026, 1, 1, 11, tzinfo=UTC)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Monitoring DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(project_id),
            event_type_id=uuid.UUID(page_type_id),
            name="Monitoring Config",
            base_query="SELECT time, event_name FROM events",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all(
            [
                data_source,
                scan_config,
                ProjectAnomalySettings(
                    project_id=uuid.UUID(project_id),
                    anomaly_detection_enabled=True,
                ),
            ]
        )
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=stable_bucket,
                    count=10,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=None,
                    event_type_id=uuid.UUID(page_type_id),
                    bucket=stable_bucket,
                    count=15,
                ),
            ]
        )
        session.add_all(
            [
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="event",
                    scope_ref=event_id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=10,
                    stddev=0,
                    z_score=-10,
                    direction="drop",
                ),
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="event_type",
                    scope_ref=page_type_id,
                    event_id=None,
                    event_type_id=uuid.UUID(page_type_id),
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=15,
                    stddev=0,
                    z_score=-15,
                    direction="drop",
                ),
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="project_total",
                    scope_ref=str(scan_config.id),
                    event_id=None,
                    event_type_id=None,
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=15,
                    stddev=0,
                    z_score=-15,
                    direction="drop",
                ),
            ]
        )
        await session.commit()
        return str(scan_config.id)


async def _seed_recent_monitoring_metrics(
    *,
    project_id: str,
    page_type_id: str,
    event_id: str,
) -> str:
    latest_bucket = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) - timedelta(
        hours=1
    )
    anomaly_bucket = latest_bucket - timedelta(hours=1)
    stable_bucket = latest_bucket - timedelta(hours=2)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Recent Monitoring DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(project_id),
            event_type_id=uuid.UUID(page_type_id),
            name="Recent Monitoring Config",
            base_query="SELECT time, event_name FROM events",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all(
            [
                data_source,
                scan_config,
                ProjectAnomalySettings(
                    project_id=uuid.UUID(project_id),
                    anomaly_detection_enabled=True,
                ),
            ]
        )
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=stable_bucket,
                    count=10,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=latest_bucket,
                    count=10,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=None,
                    event_type_id=uuid.UUID(page_type_id),
                    bucket=stable_bucket,
                    count=15,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=None,
                    event_type_id=uuid.UUID(page_type_id),
                    bucket=latest_bucket,
                    count=15,
                ),
            ]
        )
        session.add_all(
            [
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="event",
                    scope_ref=event_id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=10,
                    stddev=0,
                    z_score=-10,
                    direction="drop",
                ),
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="event_type",
                    scope_ref=page_type_id,
                    event_id=None,
                    event_type_id=uuid.UUID(page_type_id),
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=15,
                    stddev=0,
                    z_score=-15,
                    direction="drop",
                ),
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="project_total",
                    scope_ref=str(scan_config.id),
                    event_id=None,
                    event_type_id=None,
                    bucket=anomaly_bucket,
                    actual_count=0,
                    expected_count=15,
                    stddev=0,
                    z_score=-15,
                    direction="drop",
                ),
            ]
        )
        await session.commit()
        return str(scan_config.id)


@pytest.mark.asyncio
async def test_get_events_metrics_aggregates_matching_events(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "metrics-group")

    event_1 = await client.post(
        "/api/v1/projects/metrics-group/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Alpha Viewed",
            "status": "implemented",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_2 = await client.post(
        "/api/v1/projects/metrics-group/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Beta Review",
            "status": "in_review",
            "tags": ["web"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "pricing"}],
        },
    )
    event_3 = await client.post(
        "/api/v1/projects/metrics-group/events",
        json={
            "event_type_id": setup["track_type_id"],
            "name": "Gamma Archived",
            "status": "archived",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": setup["track_field_id"], "value": "checkout"}],
        },
    )

    await _seed_group_metrics(
        setup["project_id"],
        [
            {"event_id": event_1.json()["id"], "counts": [10, 15]},
            {"event_id": event_2.json()["id"], "counts": [5, 7]},
            {"event_id": event_3.json()["id"], "counts": [20, 30]},
        ],
    )

    resp = await client.get("/api/v1/projects/metrics-group/events-metrics")

    assert resp.status_code == 200
    body = resp.json()
    assert body["interval"] == "1h"
    assert body["data"] == [
        _plain_point("2026-01-01T10:00:00", 35),
        _plain_point("2026-01-01T11:00:00", 52),
    ]


@pytest.mark.asyncio
async def test_get_events_metrics_applies_event_filters(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "metrics-filters")

    event_1 = await client.post(
        "/api/v1/projects/metrics-filters/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Alpha Viewed",
            "status": "implemented",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_2 = await client.post(
        "/api/v1/projects/metrics-filters/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Beta Review",
            "status": "in_review",
            "tags": ["web"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "pricing"}],
        },
    )
    event_3 = await client.post(
        "/api/v1/projects/metrics-filters/events",
        json={
            "event_type_id": setup["track_type_id"],
            "name": "Gamma Archived",
            "status": "archived",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": setup["track_field_id"], "value": "checkout"}],
        },
    )

    await _seed_group_metrics(
        setup["project_id"],
        [
            {"event_id": event_1.json()["id"], "counts": [10, 15]},
            {"event_id": event_2.json()["id"], "counts": [5, 7]},
            {"event_id": event_3.json()["id"], "counts": [20, 30]},
        ],
    )

    reviewed_resp = await client.get(
        "/api/v1/projects/metrics-filters/events-metrics?status=in_review"
    )
    assert reviewed_resp.status_code == 200
    assert reviewed_resp.json()["data"] == [
        _plain_point("2026-01-01T10:00:00", 5),
        _plain_point("2026-01-01T11:00:00", 7),
    ]

    archived_resp = await client.get(
        "/api/v1/projects/metrics-filters/events-metrics?status=archived"
    )
    assert archived_resp.status_code == 200
    assert archived_resp.json()["data"] == [
        _plain_point("2026-01-01T10:00:00", 20),
        _plain_point("2026-01-01T11:00:00", 30),
    ]

    type_resp = await client.get(
        f"/api/v1/projects/metrics-filters/events-metrics?event_type_id={setup['page_type_id']}"
    )
    assert type_resp.status_code == 200
    assert type_resp.json()["data"] == [
        _plain_point("2026-01-01T10:00:00", 15),
        _plain_point("2026-01-01T11:00:00", 22),
    ]


@pytest.mark.asyncio
async def test_get_events_window_metrics_returns_last_day_counts_per_event(
    client: AsyncClient,
) -> None:
    setup = await _setup_metrics_project(client, "metrics-window")

    event_1 = await client.post(
        "/api/v1/projects/metrics-window/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Alpha Viewed",
            "status": "implemented",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_2 = await client.post(
        "/api/v1/projects/metrics-window/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Beta Review",
            "status": "in_review",
            "tags": ["web"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "pricing"}],
        },
    )

    await _seed_group_metrics(
        setup["project_id"],
        [
            {"event_id": event_1.json()["id"], "counts": [10, 15]},
            {"event_id": event_2.json()["id"], "counts": [5, 7]},
        ],
    )

    resp = await client.post(
        "/api/v1/projects/metrics-window/events/window-metrics",
        json={
            "event_ids": [event_1.json()["id"], event_2.json()["id"]],
            "time_from": "2026-01-01T09:00:00Z",
            "time_to": "2026-01-01T12:00:00Z",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert [(item["event_id"], item["total_count"]) for item in body] == [
        (event_1.json()["id"], 25),
        (event_2.json()["id"], 12),
    ]
    assert body[0]["data"] == [
        _plain_point("2026-01-01T10:00:00", 10),
        _plain_point("2026-01-01T11:00:00", 15),
    ]


@pytest.mark.asyncio
async def test_get_event_metrics_returns_enriched_monitoring_series(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "monitoring-event")

    event_resp = await client.post(
        "/api/v1/projects/monitoring-event/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]

    await _seed_monitoring_metrics(
        project_id=setup["project_id"],
        page_type_id=setup["page_type_id"],
        event_id=event_id,
    )

    resp = await client.get(f"/api/v1/projects/monitoring-event/events/{event_id}/metrics")

    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == "event"
    assert body["latest_signal"]["scope_type"] == "event"
    assert body["latest_signal"]["state"] == "latest_scan"
    assert body["data"] == [
        {
            "bucket": "2026-01-01T10:00:00",
            "count": 10,
            "expected_count": None,
            "stddev": None,
            "is_anomaly": False,
            "anomaly_direction": None,
            "z_score": None,
        },
        {
            "bucket": "2026-01-01T11:00:00",
            "count": 0,
            "expected_count": 10.0,
            "stddev": 0.0,
            "is_anomaly": True,
            "anomaly_direction": "drop",
            "z_score": -10.0,
        },
    ]


@pytest.mark.asyncio
async def test_get_event_metric_breakdowns_returns_series(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "breakdown-event")

    event_resp = await client.post(
        "/api/v1/projects/breakdown-event/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "metric_breakdown_columns": ["country"],
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Breakdown DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(setup["project_id"]),
            event_type_id=uuid.UUID(setup["page_type_id"]),
            name="Breakdown Config",
            base_query="SELECT time, event_name, country FROM events",
            time_column="time",
            metric_breakdown_columns=["platform"],
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        for bucket, country, count, is_other in [
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "US", 10, False),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "US", 12, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "Other", 5, True),
        ]:
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="country",
                    breakdown_value=country,
                    is_other=is_other,
                    count=count,
                )
            )
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 11, tzinfo=UTC),
                count=17,
            )
        )
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 10, tzinfo=UTC),
                breakdown_column="country",
                breakdown_value="Other",
                is_other=True,
                actual_count=5,
                expected_count=20,
                stddev=2,
                z_score=-7.5,
                direction="drop",
            )
        )
        await session.commit()

    resp = await client.get(
        f"/api/v1/projects/breakdown-event/events/{event_id}/metrics/breakdowns"
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["columns"] == ["platform", "country"]
    assert body["selected_column"] == "country"
    assert [series["breakdown_value"] for series in body["series"]] == ["US", "Other"]
    assert body["series"][0]["total_count"] == 22
    other_series = body["series"][1]
    assert other_series["is_other"] is True
    assert other_series["data"][0]["is_anomaly"] is True
    assert other_series["data"][0]["anomaly_direction"] == "drop"


@pytest.mark.asyncio
async def test_get_project_total_metrics_and_active_signals(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "monitoring-total")

    event_resp = await client.post(
        "/api/v1/projects/monitoring-total/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Checkout",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "pricing"}],
        },
    )
    event_id = event_resp.json()["id"]

    scan_config_id = await _seed_monitoring_metrics(
        project_id=setup["project_id"],
        page_type_id=setup["page_type_id"],
        event_id=event_id,
    )

    total_resp = await client.get(
        f"/api/v1/projects/monitoring-total/metrics/total?scan_config_id={scan_config_id}"
    )
    assert total_resp.status_code == 200
    total_body = total_resp.json()
    assert total_body["scope"] == "project_total"
    assert total_body["latest_signal"]["scope_ref"] == scan_config_id
    assert total_body["latest_signal"]["state"] == "latest_scan"
    assert total_body["data"][-1]["is_anomaly"] is True

    type_resp = await client.get(
        f"/api/v1/projects/monitoring-total/event-types/{setup['page_type_id']}/metrics"
    )
    assert type_resp.status_code == 200
    assert type_resp.json()["latest_signal"]["scope_type"] == "event_type"
    assert type_resp.json()["latest_signal"]["state"] == "latest_scan"

    signals_resp = await client.get(
        f"/api/v1/projects/monitoring-total/anomalies/signals?event_id={event_id}"
    )
    assert signals_resp.status_code == 200
    signals = signals_resp.json()
    assert {(signal["scope_type"], signal["scope_ref"]) for signal in signals} == {
        ("project_total", scan_config_id),
        ("event_type", setup["page_type_id"]),
        ("event", event_id),
    }
    assert {signal["state"] for signal in signals} == {"latest_scan"}


@pytest.mark.asyncio
async def test_get_recent_signals_when_anomaly_is_within_last_24_hours(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "monitoring-recent")

    event_resp = await client.post(
        "/api/v1/projects/monitoring-recent/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Signup",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "signup"}],
        },
    )
    event_id = event_resp.json()["id"]

    scan_config_id = await _seed_recent_monitoring_metrics(
        project_id=setup["project_id"],
        page_type_id=setup["page_type_id"],
        event_id=event_id,
    )

    total_resp = await client.get(
        f"/api/v1/projects/monitoring-recent/metrics/total?scan_config_id={scan_config_id}"
    )
    assert total_resp.status_code == 200
    assert total_resp.json()["latest_signal"]["state"] == "recent"

    event_resp = await client.get(f"/api/v1/projects/monitoring-recent/events/{event_id}/metrics")
    assert event_resp.status_code == 200
    assert event_resp.json()["latest_signal"]["state"] == "recent"

    signals_resp = await client.get(
        f"/api/v1/projects/monitoring-recent/anomalies/signals?event_id={event_id}"
    )
    assert signals_resp.status_code == 200
    signals = signals_resp.json()
    assert {(signal["scope_type"], signal["state"]) for signal in signals} == {
        ("project_total", "recent"),
        ("event_type", "recent"),
        ("event", "recent"),
    }


@pytest.mark.asyncio
async def test_get_top_movers_ranks_breakdown_anomalies_by_abs_z(
    client: AsyncClient,
) -> None:
    setup = await _setup_metrics_project(client, "top-movers")

    event_resp = await client.post(
        "/api/v1/projects/top-movers/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]
    bucket = datetime(2026, 1, 1, 10, tzinfo=UTC)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"TopMover DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(setup["project_id"]),
            event_type_id=uuid.UUID(setup["page_type_id"]),
            name="Top-mover Config",
            base_query="SELECT time, event_name, country FROM events",
            time_column="time",
            metric_breakdown_columns=["country"],
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        # Two anomalies on the same bucket; one with a much bigger |z|. A third
        # row on a different bucket is added as noise that must NOT be returned.
        for value, z, count, expected in [
            ("US", -2.0, 90, 100),
            ("DE", -8.0, 10, 60),
        ]:
            session.add(
                MetricBreakdownAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    scope_type="event",
                    scope_ref=event_id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="country",
                    breakdown_value=value,
                    is_other=False,
                    actual_count=count,
                    expected_count=expected,
                    stddev=5,
                    z_score=z,
                    direction="drop",
                )
            )
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 11, tzinfo=UTC),
                breakdown_column="country",
                breakdown_value="US",
                is_other=False,
                actual_count=80,
                expected_count=100,
                stddev=5,
                z_score=-4.0,
                direction="drop",
            )
        )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/top-movers/scans/{scan_config_id}/top-movers",
        params={
            "scope_type": "event",
            "scope_ref": event_id,
            "bucket": bucket.isoformat(),
            "limit": 10,
        },
    )

    assert resp.status_code == 200
    items = resp.json()
    assert [(row["breakdown_value"], row["z_score"]) for row in items] == [
        ("DE", -8.0),
        ("US", -2.0),
    ]


@pytest.mark.asyncio
async def test_distribution_drifts_endpoint_filters_by_event_type(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, slug="distribution-api")
    bucket = datetime(2026, 1, 1, 10, tzinfo=UTC)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Distribution DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(setup["project_id"]),
            event_type_id=uuid.UUID(setup["page_type_id"]),
            name="Distribution Config",
            base_query="SELECT time, event_name, platform FROM events",
            time_column="time",
            distribution_drift_fields=["platform"],
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        session.add(
            DistributionDrift(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                event_type_id=uuid.UUID(setup["page_type_id"]),
                field_name="platform",
                bucket=bucket,
                psi=0.42,
                band="significant",
                baseline_total=1000,
                current_total=1000,
                top_movers=[
                    {
                        "value": "ios",
                        "baseline_share": 0.5,
                        "current_share": 0.9,
                        "contribution": 0.25,
                    }
                ],
            )
        )
        session.add(
            DistributionDrift(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                event_type_id=uuid.UUID(setup["track_type_id"]),
                field_name="country",
                bucket=bucket,
                psi=0.30,
                band="significant",
                baseline_total=10,
                current_total=10,
                top_movers=[],
            )
        )
        await session.commit()

    resp = await client.get(
        "/api/v1/projects/distribution-api/distribution-drifts",
        params={
            "scope_type": "event_type",
            "scope_ref": setup["page_type_id"],
            "from": (bucket - timedelta(hours=1)).isoformat(),
            "to": (bucket + timedelta(hours=1)).isoformat(),
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"] == ["platform"]
    assert len(body["data"]) == 1
    assert body["data"][0]["band"] == "significant"
    assert body["data"][0]["top_movers"][0]["value"] == "ios"


@pytest.mark.asyncio
async def test_seasonality_heatmap_aggregates_by_weekday_hour(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, slug="heatmap-api")
    event_resp = await client.post(
        "/api/v1/projects/heatmap-api/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Home",
            "field_values": [
                {"field_definition_id": setup["page_field_id"], "value": "home"},
            ],
        },
    )
    event_id = event_resp.json()["id"]

    # 2026-01-05 is a Monday; 2026-01-06 a Tuesday. Hours 09 and 10 chosen
    # so the assertions can target specific (weekday, hour) slots.
    monday_9 = datetime(2026, 1, 5, 9, tzinfo=UTC)
    monday_9_again = datetime(2026, 1, 12, 9, tzinfo=UTC)
    monday_10 = datetime(2026, 1, 5, 10, tzinfo=UTC)
    tuesday_10 = datetime(2026, 1, 6, 10, tzinfo=UTC)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Heatmap DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(setup["project_id"]),
            event_type_id=uuid.UUID(setup["page_type_id"]),
            name="Heatmap Config",
            base_query="SELECT time, event_name FROM events",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])

        for bucket, count in [
            (monday_9, 30),
            (monday_9_again, 20),
            (monday_10, 5),
            (tuesday_10, 50),
        ]:
            session.add(
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=bucket,
                    count=count,
                )
            )
        # One anomaly on Tuesday 10 — should show up as anomaly_count=1 in
        # that cell.
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=tuesday_10,
                actual_count=50,
                expected_count=5.0,
                stddev=2.0,
                z_score=15.0,
                direction="spike",
            )
        )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/heatmap-api/scans/{scan_config_id}/seasonality",
        params={
            "scope_type": "event",
            "scope_ref": event_id,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["cells"]) == 7 * 24
    assert body["total_count"] == 30 + 20 + 5 + 50
    assert body["max_count"] == 50

    by_slot = {(cell["weekday"], cell["hour"]): cell for cell in body["cells"]}
    # Monday=0, Tuesday=1 (Python datetime.weekday()).
    assert by_slot[(0, 9)]["count"] == 50  # 30 + 20 two Mondays at 09:00
    assert by_slot[(0, 9)]["anomaly_count"] == 0
    assert by_slot[(0, 10)]["count"] == 5
    assert by_slot[(1, 10)]["count"] == 50
    assert by_slot[(1, 10)]["anomaly_count"] == 1


@pytest.mark.asyncio
async def test_breakdown_timeline_returns_per_bucket_counts(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, slug="drilldown-api")
    event_resp = await client.post(
        "/api/v1/projects/drilldown-api/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "Home",
            "field_values": [
                {"field_definition_id": setup["page_field_id"], "value": "home"},
            ],
        },
    )
    event_id = event_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Drilldown DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(setup["project_id"]),
            event_type_id=uuid.UUID(setup["page_type_id"]),
            name="Drilldown Config",
            base_query="SELECT time, event_name, country FROM events",
            time_column="time",
            metric_breakdown_columns=["country"],
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])

        buckets = [
            datetime(2026, 1, 1, 10, tzinfo=UTC),
            datetime(2026, 1, 1, 11, tzinfo=UTC),
            datetime(2026, 1, 1, 12, tzinfo=UTC),
        ]
        # Two breakdown_values; expect drill-down to return only US.
        for bucket, us_count, de_count in zip(buckets, [40, 50, 60], [10, 20, 30], strict=True):
            session.add_all(
                [
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=scan_config.id,
                        event_id=uuid.UUID(event_id),
                        event_type_id=None,
                        bucket=bucket,
                        breakdown_column="country",
                        breakdown_value="US",
                        is_other=False,
                        count=us_count,
                    ),
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=scan_config.id,
                        event_id=uuid.UUID(event_id),
                        event_type_id=None,
                        bucket=bucket,
                        breakdown_column="country",
                        breakdown_value="DE",
                        is_other=False,
                        count=de_count,
                    ),
                ]
            )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/drilldown-api/scans/{scan_config_id}/breakdown-timeline",
        params={
            "scope_type": "event",
            "scope_ref": event_id,
            "breakdown_column": "country",
            "breakdown_value": "US",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["breakdown_value"] == "US"
    assert [point["count"] for point in body["data"]] == [40, 50, 60]

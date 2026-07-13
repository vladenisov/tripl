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
from tripl.models.release_regression import ReleaseRegression
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
        "detector_kind": None,
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


# The "latest_scan" monitoring fixture below seeds an anomaly on the newest
# bucket, so its bucket must stay inside the wall-clock freshness horizon
# (classify keeps a signal "latest_scan" only while newer than now - 24h).
# Anchored to recent hour-aligned buckets; the 1h stable->anomaly spacing is
# preserved and the enriched-series assertions derive their bucket strings from
# these same constants.
_MONITORING_STABLE_BUCKET = datetime.now(UTC).replace(
    minute=0, second=0, microsecond=0
) - timedelta(hours=2)
_MONITORING_ANOMALY_BUCKET = _MONITORING_STABLE_BUCKET + timedelta(hours=1)


async def _seed_monitoring_metrics(
    *,
    project_id: str,
    page_type_id: str,
    event_id: str,
) -> str:
    stable_bucket = _MONITORING_STABLE_BUCKET
    anomaly_bucket = _MONITORING_ANOMALY_BUCKET

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
            "bucket": _MONITORING_STABLE_BUCKET.replace(tzinfo=None).isoformat(),
            "count": 10,
            "expected_count": None,
            "stddev": None,
            "detector_kind": None,
            "is_anomaly": False,
            "anomaly_direction": None,
            "z_score": None,
        },
        {
            "bucket": _MONITORING_ANOMALY_BUCKET.replace(tzinfo=None).isoformat(),
            "count": 0,
            "expected_count": 10.0,
            "stddev": 0.0,
            "detector_kind": "phase",
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
            platform_column="country",
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
                breakdown_value="US",
                is_other=False,
                kind="parity",
                actual_count=0.25,
                expected_count=0.5,
                stddev=0.02,
                z_score=-12.5,
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
    assert body["series"][0]["data"][0]["is_anomaly"] is False
    assert body["series"][0]["parity_anomalies"] == [
        {
            "bucket": "2026-01-01T10:00:00",
            "actual_share": 0.25,
            "expected_share": 0.5,
            "stddev": 0.02,
            "z_score": -12.5,
            "direction": "drop",
        }
    ]
    other_series = body["series"][1]
    assert other_series["is_other"] is True
    assert other_series["data"][0]["is_anomaly"] is True
    assert other_series["data"][0]["anomaly_direction"] == "drop"


@pytest.mark.asyncio
async def test_get_app_version_series_returns_semver_ordered_versions(
    client: AsyncClient,
) -> None:
    setup = await _setup_metrics_project(client, "version-series")

    event_resp = await client.post(
        "/api/v1/projects/version-series/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Version DS {uuid.uuid4().hex[:8]}",
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
            name="Version Config",
            base_query="SELECT time, event_name, app_version FROM events",
            time_column="time",
            app_version_column="app_version",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        for bucket, version, count, is_other in [
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "2.9.0", 90, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "2.10.0", 100, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "beta", 10, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "Other", 40, True),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "2.10.0", 200, False),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "2.9.0", 80, False),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "beta", 20, False),
        ]:
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="app_version",
                    breakdown_value=version,
                    is_other=is_other,
                    count=count,
                )
            )
        # Legacy rows may survive until the next scheduled recomputation after
        # upgrading. App-version APIs are observational and must not serve them.
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 11, tzinfo=UTC),
                breakdown_column="app_version",
                breakdown_value="2.10.0",
                is_other=False,
                actual_count=200,
                expected_count=400,
                stddev=2,
                z_score=-10,
                direction="drop",
            )
        )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/version-series/scans/{scan_config_id}/app-versions",
        params={"scope_type": "event", "scope_ref": event_id},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["app_version_column"] == "app_version"
    assert body["latest_version"] == "2.10.0"
    assert [item["version"] for item in body["versions"]] == [
        "2.10.0",
        "2.9.0",
        "beta",
        "Other",
    ]
    assert [item["is_latest"] for item in body["versions"]] == [True, False, False, False]
    assert [series["version"] for series in body["series"]] == [
        "2.10.0",
        "2.9.0",
        "beta",
        "Other",
    ]
    assert body["series"][0]["is_latest"] is True
    assert body["series"][0]["total_count"] == 300
    assert body["series"][-1]["is_other"] is True
    assert all(
        point["is_anomaly"] is False for series in body["series"] for point in series["data"]
    )


@pytest.mark.asyncio
async def test_get_app_version_series_retention_is_window_stable(
    client: AsyncClient,
) -> None:
    # Regression: latest-N retention + "Other" rollup must be decided once over
    # the whole window, not per collection chunk. A high-volume older version
    # must fold into "Other" consistently — even in buckets where the newer
    # version is absent — instead of flipping between its own series and "Other".
    setup = await _setup_metrics_project(client, "version-stable")
    policy_resp = await client.patch(
        "/api/v1/projects/version-stable",
        json={"app_version_keep_releases": 1},
    )
    assert policy_resp.status_code == 200

    event_resp = await client.post(
        "/api/v1/projects/version-stable/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Version Stable DS {uuid.uuid4().hex[:8]}",
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
            name="Version Stable Config",
            base_query="SELECT time, event_name, app_version FROM events",
            time_column="time",
            app_version_column="app_version",
            # Deliberately conflicts with the project policy: runtime retention
            # must no longer depend on the legacy per-scan value.
            app_version_keep_releases=5,
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        # Every version stored verbatim (is_other=False), as the write path now does.
        # 2.0.0 (newest) appears only in the first bucket; 1.0.0 dominates both.
        for bucket, version, count in [
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "1.0.0", 100),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "2.0.0", 5),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "1.0.0", 80),
        ]:
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(event_id),
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="app_version",
                    breakdown_value=version,
                    is_other=False,
                    count=count,
                )
            )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/version-stable/scans/{scan_config_id}/app-versions",
        params={"scope_type": "event", "scope_ref": event_id},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["latest_version"] == "2.0.0"
    # Project keep_releases=1 → only the latest (2.0.0) stays explicit; 1.0.0 folds into
    # "Other" in BOTH buckets, including the one where 2.0.0 is absent.
    assert [item["version"] for item in body["versions"]] == ["2.0.0", "Other"]
    series_by_version = {series["version"]: series for series in body["series"]}
    assert set(series_by_version) == {"2.0.0", "Other"}
    assert series_by_version["2.0.0"]["total_count"] == 5
    assert series_by_version["Other"]["is_other"] is True
    assert series_by_version["Other"]["total_count"] == 180


@pytest.mark.asyncio
async def test_get_app_version_adoption_returns_project_totals(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "version-adoption")

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Version Adoption DS {uuid.uuid4().hex[:8]}",
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
            name="Version Adoption Config",
            base_query="SELECT time, event_name, app_version FROM events",
            time_column="time",
            app_version_column="app_version",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        for bucket, version, count, is_other in [
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "2.9.0", 9, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "2.10.0", 10, False),
            (datetime(2026, 1, 1, 10, tzinfo=UTC), "Other", 4, True),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "2.10.0", 20, False),
            (datetime(2026, 1, 1, 11, tzinfo=UTC), "2.9.0", 8, False),
        ]:
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=None,
                    event_type_id=uuid.UUID(setup["page_type_id"]),
                    bucket=bucket,
                    breakdown_column="app_version",
                    breakdown_value=version,
                    is_other=is_other,
                    count=count,
                )
            )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/version-adoption/scans/{scan_config_id}/version-adoption"
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["scope_type"] == "project_total"
    assert body["scope_ref"] == scan_config_id
    assert body["latest_version"] == "2.10.0"
    assert [series["version"] for series in body["series"]] == ["2.10.0", "2.9.0", "Other"]
    assert body["totals"] == [
        {"bucket": "2026-01-01T10:00:00", "count": 23},
        {"bucket": "2026-01-01T11:00:00", "count": 28},
    ]


@pytest.mark.asyncio
async def test_get_app_version_endpoints_are_empty_without_version_column(
    client: AsyncClient,
) -> None:
    setup = await _setup_metrics_project(client, "version-empty")

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Version Empty DS {uuid.uuid4().hex[:8]}",
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
            name="No Version Config",
            base_query="SELECT time, event_name FROM events",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        await session.commit()
        scan_config_id = str(scan_config.id)

    series_resp = await client.get(
        f"/api/v1/projects/version-empty/scans/{scan_config_id}/app-versions"
    )
    adoption_resp = await client.get(
        f"/api/v1/projects/version-empty/scans/{scan_config_id}/version-adoption"
    )

    assert series_resp.status_code == 200
    assert adoption_resp.status_code == 200
    series_body = series_resp.json()
    adoption_body = adoption_resp.json()
    assert series_body["app_version_column"] is None
    assert series_body["latest_version"] is None
    assert series_body["versions"] == []
    assert series_body["series"] == []
    assert adoption_body["totals"] == []
    assert adoption_body["series"] == []


@pytest.mark.asyncio
async def test_get_release_regressions_lists_missing_first(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "release-regressions")

    event_resp = await client.post(
        "/api/v1/projects/release-regressions/events",
        json={
            "event_type_id": setup["page_type_id"],
            "name": "event_name=Login",
            "status": "implemented",
            "field_values": [{"field_definition_id": setup["page_field_id"], "value": "home"}],
        },
    )
    event_id = event_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Regression DS {uuid.uuid4().hex[:8]}",
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
            name="Regression Config",
            base_query="SELECT time, event_name, app_version FROM events",
            time_column="time",
            app_version_column="app_version",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        # A volume_drop (event-type scope) and a missing event — missing should
        # sort first regardless of insertion order.
        session.add(
            ReleaseRegression(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event_type",
                scope_ref=setup["page_type_id"],
                event_id=None,
                event_type_id=uuid.UUID(setup["page_type_id"]),
                app_version_column="app_version",
                version="2.1.0",
                previous_version="2.0.0",
                kind="volume_drop",
                observed_count=40,
                expected_count=100.0,
                ratio=0.4,
                share_prev=0.2,
                share_new=0.08,
                release_share=0.33,
                window_from=datetime(2026, 1, 1, 10, tzinfo=UTC),
                window_to=datetime(2026, 1, 1, 11, tzinfo=UTC),
            )
        )
        session.add(
            ReleaseRegression(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                app_version_column="app_version",
                version="2.1.0",
                previous_version="2.0.0",
                kind="missing",
                observed_count=0,
                expected_count=200.0,
                ratio=0.0,
                share_prev=0.1,
                share_new=0.0,
                release_share=0.33,
                window_from=datetime(2026, 1, 1, 10, tzinfo=UTC),
                window_to=datetime(2026, 1, 1, 11, tzinfo=UTC),
            )
        )
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/release-regressions/scans/{scan_config_id}/release-regressions"
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["app_version_column"] == "app_version"
    assert body["latest_version"] == "2.1.0"
    assert [item["kind"] for item in body["items"]] == ["missing", "volume_drop"]
    missing = body["items"][0]
    assert missing["scope_type"] == "event"
    assert missing["scope_name"] == "event_name=Login"
    assert missing["version"] == "2.1.0"
    assert missing["previous_version"] == "2.0.0"
    assert missing["observed_count"] == 0
    assert missing["expected_count"] == 200.0
    assert body["items"][1]["scope_type"] == "event_type"

    # scope_type filter narrows the result set.
    filtered = await client.get(
        f"/api/v1/projects/release-regressions/scans/{scan_config_id}/release-regressions",
        params={"scope_type": "event"},
    )
    assert [item["kind"] for item in filtered.json()["items"]] == ["missing"]


@pytest.mark.asyncio
async def test_get_release_regressions_empty_without_version_column(client: AsyncClient) -> None:
    setup = await _setup_metrics_project(client, "regression-empty")

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Regression Empty DS {uuid.uuid4().hex[:8]}",
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
            name="No Version Regression Config",
            base_query="SELECT time, event_name FROM events",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        await session.commit()
        scan_config_id = str(scan_config.id)

    resp = await client.get(
        f"/api/v1/projects/regression-empty/scans/{scan_config_id}/release-regressions"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["app_version_column"] is None
    assert body["latest_version"] is None
    assert body["items"] == []


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
    # Incident de-duplication: the event/event_type signals share the same
    # (scan_config_id, bucket, direction) as the project_total signal and are
    # suppressed in favor of the kept project_total signal.
    assert {(signal["scope_type"], signal["scope_ref"]) for signal in signals} == {
        ("project_total", scan_config_id),
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
    # Incident de-duplication: the event/event_type signals share the same
    # (scan_config_id, bucket, direction) as the project_total signal and are
    # suppressed in favor of the kept project_total signal.
    assert {(signal["scope_type"], signal["state"]) for signal in signals} == {
        ("project_total", "recent"),
    }


@pytest.mark.asyncio
async def test_get_top_movers_ranks_regular_breakdowns_and_excludes_app_versions(
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
            base_query="SELECT time, event_name, country, app_version FROM events",
            time_column="time",
            metric_breakdown_columns=["country"],
            app_version_column="app_version",
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
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                scope_type="event",
                scope_ref=event_id,
                event_id=uuid.UUID(event_id),
                event_type_id=None,
                bucket=bucket,
                breakdown_column="app_version",
                breakdown_value="2.10.0",
                is_other=False,
                actual_count=10,
                expected_count=100,
                stddev=2,
                z_score=-20.0,
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


@pytest.mark.asyncio
async def test_overview_top_events_ranks_by_volume(client: AsyncClient):
    ctx = await _setup_metrics_project(client, slug="top-ev")

    async def _make_event(name: str) -> str:
        resp = await client.post(
            "/api/v1/projects/top-ev/events",
            json={
                "event_type_id": ctx["page_type_id"],
                "name": name,
                "field_values": [{"field_definition_id": ctx["page_field_id"], "value": "x"}],
            },
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    big = await _make_event("Big")
    small = await _make_event("Small")
    recent = datetime.now(UTC) - timedelta(hours=1)
    old = datetime.now(UTC) - timedelta(days=10)

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Top DS {uuid.uuid4().hex[:8]}",
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
            project_id=uuid.UUID(ctx["project_id"]),
            event_type_id=None,
            name="Top Config",
            base_query="SELECT time, event_name FROM events",
            event_type_column="event_name",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(big),
                    event_type_id=None,
                    bucket=recent,
                    count=500,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(small),
                    event_type_id=None,
                    bucket=recent,
                    count=20,
                ),
                # Outside the 48h window — must be excluded from the ranking.
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=uuid.UUID(small),
                    event_type_id=None,
                    bucket=old,
                    count=99999,
                ),
            ]
        )
        await session.commit()

    resp = await client.get("/api/v1/projects/top-ev/overview/top-events?window_hours=48&limit=6")
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["event_id"] for r in rows] == [big, small]
    assert rows[0]["total_count"] == 500
    assert rows[1]["total_count"] == 20
    assert rows[0]["name"] == "Big"


@pytest.mark.asyncio
async def test_data_source_stats_aggregates_recent_metrics(client: AsyncClient):
    ctx = await _setup_metrics_project(client, slug="ds-stats")
    recent = datetime.now(UTC) - timedelta(hours=1)
    old = datetime.now(UTC) - timedelta(days=10)
    ds_id = uuid.uuid4()
    ev1, ev2 = uuid.uuid4(), uuid.uuid4()

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=ds_id,
            name="DS stats",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=ds_id,
            project_id=uuid.UUID(ctx["project_id"]),
            event_type_id=None,
            name="DS Config",
            base_query="SELECT time, event_name FROM events",
            event_type_column="event_name",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add_all([data_source, scan_config])
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=ev1,
                    event_type_id=None,
                    bucket=recent,
                    count=100,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=ev2,
                    event_type_id=None,
                    bucket=recent,
                    count=50,
                ),
                # Outside the window — excluded.
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=ev1,
                    event_type_id=None,
                    bucket=old,
                    count=9999,
                ),
            ]
        )
        await session.commit()

    resp = await client.get(f"/api/v1/data-sources/{ds_id}/stats?window_hours=48")
    assert resp.status_code == 200
    body = resp.json()
    assert body["volume_window"] == 150
    assert body["events_tracked"] == 2
    assert len(body["throughput"]) == 1


@pytest.mark.asyncio
async def test_overview_kpi_series(client: AsyncClient):
    ctx = await _setup_metrics_project(client, slug="kpi-series")
    for name in ("A", "B"):
        resp = await client.post(
            "/api/v1/projects/kpi-series/events",
            json={
                "event_type_id": ctx["page_type_id"],
                "name": name,
                "field_values": [{"field_definition_id": ctx["page_field_id"], "value": "x"}],
            },
        )
        assert resp.status_code == 201

    resp = await client.get("/api/v1/projects/kpi-series/overview/kpi-series?days=14")
    assert resp.status_code == 200
    body = resp.json()
    assert body["days"] == 14
    assert len(body["active_events"]) == 14
    assert sum(body["active_events"]) == 2
    assert body["active_events"][-1] == 2  # both created today


async def _seed_platform_scan(
    client: AsyncClient, slug: str, *, platform_column: str | None
) -> tuple[str, dict[str, str]]:
    """Project + 2 events + a scan config (optionally platform-aware). Returns
    (scan_config_id, {event_name: event_id})."""
    proj = await client.post("/api/v1/projects", json={"name": "Platform", "slug": slug})
    project_id = proj.json()["id"]
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    et_id = et.json()["id"]
    events: dict[str, str] = {}
    for name in ("checkout", "signup"):
        ev = await client.post(
            f"/api/v1/projects/{slug}/events",
            json={"event_type_id": et_id, "name": name},
        )
        events[name] = ev.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Platform DS {uuid.uuid4().hex[:8]}",
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
            name="Platform Config",
            base_query="SELECT time, event_name FROM events",
            event_type_column="event_name",
            time_column="time",
            cardinality_threshold=100,
            interval="1h",
            platform_column=platform_column,
        )
        session.add_all([data_source, scan_config])
        scan_config_id = str(scan_config.id)
        await session.commit()
    return scan_config_id, events


async def test_platform_presence_matrix(client: AsyncClient) -> None:
    """Presence is derived from platform_column breakdown rows (event scope,
    count > 0); zero-count and non-platform breakdown rows are excluded."""
    scan_config_id, events = await _seed_platform_scan(
        client, "platform-presence", platform_column="platform"
    )
    bucket = datetime(2026, 1, 1, 10, tzinfo=UTC)
    rows = [
        ("checkout", "ios", 50),
        ("checkout", "android", 30),
        ("signup", "ios", 10),
        ("signup", "android", 0),  # zero count → not present
    ]
    async with TestSessionLocal() as session:
        for ev_name, platform, count in rows:
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=uuid.UUID(scan_config_id),
                    event_id=uuid.UUID(events[ev_name]),
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value=platform,
                    is_other=False,
                    count=count,
                )
            )
        # A non-platform breakdown row must be ignored by the matrix.
        session.add(
            EventMetricBreakdown(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_config_id),
                event_id=uuid.UUID(events["checkout"]),
                event_type_id=None,
                bucket=bucket,
                breakdown_column="country",
                breakdown_value="US",
                is_other=False,
                count=99,
            )
        )
        await session.commit()

    resp = await client.get(
        f"/api/v1/projects/platform-presence/scans/{scan_config_id}/platform-presence"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["platform_column"] == "platform"
    assert body["platforms"] == ["android", "ios"]
    items = {it["event_name"]: it["present_platforms"] for it in body["items"]}
    assert items["checkout"] == ["android", "ios"]
    assert items["signup"] == ["ios"]  # android dropped (count 0)


async def test_platform_presence_empty_without_platform_column(client: AsyncClient) -> None:
    scan_config_id, _events = await _seed_platform_scan(
        client, "platform-presence-empty", platform_column=None
    )
    resp = await client.get(
        f"/api/v1/projects/platform-presence-empty/scans/{scan_config_id}/platform-presence"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["platform_column"] is None
    assert body["platforms"] == []
    assert body["items"] == []

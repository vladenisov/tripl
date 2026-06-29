"""API tests for the catalog-metric series reads + list enrichment (tripl-dxhp.7).

Seeds ``MetricValue`` / ``MetricValueBreakdown`` rows directly (the collection
worker is ticket .5, not exercised here) plus a ``MetricAnomaly`` row keyed by
``scope_ref = str(metric_definition_id)`` to exercise the defensive
anomaly-join seam documented in ``metric_series_service``.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tripl.models.data_source import DataSource
from tripl.models.domain_enums import MetricComposition, MetricKind
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.metric_value_breakdown import MetricValueBreakdown
from tripl.models.scan_config import ScanConfig
from tripl.services.metric_definition_service import _SPARK_POINTS
from tripl.tests.conftest import TestSessionLocal

# Three 1h-aligned buckets; b1 is intentionally left without a stored value so
# the densify-to-grid step has to fill it with 0.0.
B0 = datetime(2026, 1, 1, 10, tzinfo=UTC)
B1 = datetime(2026, 1, 1, 11, tzinfo=UTC)
B2 = datetime(2026, 1, 1, 12, tzinfo=UTC)


@pytest.fixture
async def project(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Series Test", "slug": "series-test", "description": ""},
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def data_source(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Series CH",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "test_db",
        },
    )
    assert resp.status_code == 201
    return resp.json()


def _metrics_url(slug: str) -> str:
    return f"/api/v1/projects/{slug}/metrics"


async def _create_sql_metric(
    client: AsyncClient,
    slug: str,
    data_source_id: str,
    name: str,
    **extra: object,
) -> dict:
    payload: dict = {
        "kind": "sql",
        "name": name,
        "display_name": name.upper(),
        "data_source_id": data_source_id,
        "interval": "1h",
        "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
        **extra,
    }
    resp = await client.post(_metrics_url(slug), json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _seed_scan_config(project_id: str, *, interval: str = "1h") -> uuid.UUID:
    """A bare scan config to satisfy MetricAnomaly.scan_config_id (non-nullable)."""
    scan_config_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name=f"Series DS {uuid.uuid4().hex[:8]}",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=scan_config_id,
            data_source_id=data_source.id,
            project_id=uuid.UUID(project_id),
            name=f"Series Config {uuid.uuid4().hex[:8]}",
            base_query="SELECT time, v FROM t",
            interval=interval,
        )
        session.add_all([data_source, scan_config])
        await session.commit()
    return scan_config_id


async def _seed_event_composition_metric(project_id: str, name: str) -> str:
    """Seed an ``event_composition`` metric (interval NULL) straight to the DB.

    Composition metrics are normally created via the API with real event refs;
    here the interval-resolution seam only needs a row whose ``interval`` is NULL
    so the grid is derived from the values' ``scan_config_id``.
    """
    metric_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(
            MetricDefinition(
                id=metric_id,
                project_id=uuid.UUID(project_id),
                name=name,
                display_name=name.upper(),
                kind=MetricKind.event_composition,
                composition=MetricComposition.single,
                config={},
                interval=None,
            )
        )
        await session.commit()
    return str(metric_id)


async def _seed_metric_values(
    metric_id: str,
    rows: list[tuple[datetime, float]],
    *,
    scan_config_id: uuid.UUID | None = None,
) -> None:
    async with TestSessionLocal() as session:
        for bucket, value in rows:
            session.add(
                MetricValue(
                    id=uuid.uuid4(),
                    metric_definition_id=uuid.UUID(metric_id),
                    scan_config_id=scan_config_id,
                    bucket=bucket,
                    value=value,
                )
            )
        await session.commit()


async def _seed_metric_anomaly(
    *,
    scan_config_id: uuid.UUID,
    metric_id: str,
    bucket: datetime,
    direction: str,
    actual_count: int,
    expected_count: float,
) -> None:
    # SEAM (ticket .6): MetricScopeType.metric does not exist yet and cannot be
    # inserted under the SQLite CHECK constraint, so we seed a placeholder
    # scope_type and rely on the service matching on scope_ref alone.
    async with TestSessionLocal() as session:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
                scope_type="event",
                scope_ref=str(metric_id),
                event_id=None,
                event_type_id=None,
                bucket=bucket,
                actual_count=actual_count,
                expected_count=expected_count,
                stddev=1.0,
                z_score=5.0 if direction == "spike" else -5.0,
                direction=direction,
            )
        )
        await session.commit()


async def _seed_breakdowns(
    metric_id: str,
    rows: list[tuple[str, str, datetime, float]],
) -> None:
    async with TestSessionLocal() as session:
        for column, value, bucket, amount in rows:
            session.add(
                MetricValueBreakdown(
                    id=uuid.uuid4(),
                    metric_definition_id=uuid.UUID(metric_id),
                    scan_config_id=None,
                    bucket=bucket,
                    breakdown_column=column,
                    breakdown_value=value,
                    is_other=False,
                    value=amount,
                )
            )
        await session.commit()


class TestMetricSeries:
    async def test_series_densified_with_anomaly_flags(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        metric = await _create_sql_metric(client, slug, data_source["id"], "lat")
        scan_config_id = await _seed_scan_config(project["id"])
        await _seed_metric_values(metric["id"], [(B0, 10.0), (B2, 4.0)])
        await _seed_metric_anomaly(
            scan_config_id=scan_config_id,
            metric_id=metric["id"],
            bucket=B0,
            direction="spike",
            actual_count=10,
            expected_count=3.0,
        )
        await _seed_metric_anomaly(
            scan_config_id=scan_config_id,
            metric_id=metric["id"],
            bucket=B2,
            direction="drop",
            actual_count=4,
            expected_count=12.0,
        )

        resp = await client.get(f"{_metrics_url(slug)}/{metric['id']}/series")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["metric_id"] == metric["id"]
        assert body["scope"] == "metric"
        assert body["interval"] == "1h"

        # b1 was never stored: the grid must densify it to 0.0 between b0 and b2.
        assert [point["value"] for point in body["data"]] == [10.0, 0.0, 4.0]

        spike, gap, drop = body["data"]
        assert spike["is_anomaly"] is True
        assert spike["anomaly_direction"] == "spike"
        assert gap["is_anomaly"] is False
        assert drop["is_anomaly"] is True
        assert drop["anomaly_direction"] == "drop"

        # Latest anomaly sits on the latest value bucket → an open "latest_scan" signal.
        assert body["latest_signal"] is not None
        assert body["latest_signal"]["direction"] == "drop"
        assert body["latest_signal"]["scope_ref"] == metric["id"]

    async def test_series_empty_when_no_values(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        metric = await _create_sql_metric(client, slug, data_source["id"], "empty")
        resp = await client.get(f"{_metrics_url(slug)}/{metric['id']}/series")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["data"] == []
        assert body["latest_signal"] is None

    async def test_series_unknown_metric_404(self, client: AsyncClient, project: dict):
        resp = await client.get(f"{_metrics_url(project['slug'])}/{uuid.uuid4()}/series")
        assert resp.status_code == 404, resp.text

    async def test_series_cross_project_404(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        other = await client.post(
            "/api/v1/projects",
            json={"name": "Other", "slug": "series-other", "description": ""},
        )
        assert other.status_code == 201
        metric = await _create_sql_metric(client, project["slug"], data_source["id"], "iso")
        resp = await client.get(f"{_metrics_url('series-other')}/{metric['id']}/series")
        assert resp.status_code == 404, resp.text


class TestMetricIntervalResolution:
    async def test_event_composition_grid_follows_latest_scan_config(
        self, client: AsyncClient, project: dict
    ):
        """A composition metric collected under two scan_configs must resolve its
        grid to the MOST-RECENT one, not an arbitrary ``LIMIT 1`` row."""
        slug = project["slug"]
        metric_id = await _seed_event_composition_metric(project["id"], "comp")
        # "old" carries the earlier bucket; "new" the later one. Seed old FIRST so
        # an unordered ``LIMIT 1`` would wrongly return the old config's grid.
        old_config = await _seed_scan_config(project["id"], interval="1h")
        new_config = await _seed_scan_config(project["id"], interval="1d")
        await _seed_metric_values(metric_id, [(B0, 10.0)], scan_config_id=old_config)
        await _seed_metric_values(metric_id, [(B2, 4.0)], scan_config_id=new_config)

        resp = await client.get(f"{_metrics_url(slug)}/{metric_id}/series")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The latest bucket (B2) was collected under new_config → its grid wins.
        assert body["scan_config_id"] == str(new_config)
        assert body["interval"] == "1d"


class TestMetricBreakdowns:
    async def test_breakdown_series(self, client: AsyncClient, project: dict, data_source: dict):
        slug = project["slug"]
        metric = await _create_sql_metric(
            client, slug, data_source["id"], "bd", breakdown_columns=["country"]
        )
        await _seed_breakdowns(
            metric["id"],
            [
                ("country", "US", B0, 3.0),
                ("country", "US", B2, 5.0),
                ("country", "CA", B0, 1.0),
            ],
        )
        resp = await client.get(f"{_metrics_url(slug)}/{metric['id']}/breakdowns")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["columns"] == ["country"]
        assert body["selected_column"] == "country"
        series_by_value = {item["breakdown_value"]: item for item in body["series"]}
        assert set(series_by_value) == {"US", "CA"}
        assert series_by_value["US"]["total_value"] == 8.0
        # Highest-volume series sorts first.
        assert body["series"][0]["breakdown_value"] == "US"

    async def test_breakdown_unknown_column_400(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        metric = await _create_sql_metric(
            client, slug, data_source["id"], "bd2", breakdown_columns=["country"]
        )
        resp = await client.get(
            f"{_metrics_url(slug)}/{metric['id']}/breakdowns", params={"column": "ghost"}
        )
        assert resp.status_code == 400, resp.text


class TestMetricVersionSeries:
    async def test_version_series(self, client: AsyncClient, project: dict, data_source: dict):
        slug = project["slug"]
        metric = await _create_sql_metric(
            client, slug, data_source["id"], "ver", app_version_column="app_version"
        )
        await _seed_breakdowns(
            metric["id"],
            [
                ("app_version", "1.0.0", B0, 2.0),
                ("app_version", "1.1.0", B0, 3.0),
            ],
        )
        resp = await client.get(f"{_metrics_url(slug)}/{metric['id']}/versions")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["app_version_column"] == "app_version"
        assert body["latest_version"] == "1.1.0"
        versions = {item["version"]: item for item in body["versions"]}
        assert versions["1.1.0"]["is_latest"] is True
        assert {item["version"] for item in body["series"]} == {"1.0.0", "1.1.0"}

    async def test_version_series_empty_when_no_column(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        metric = await _create_sql_metric(client, slug, data_source["id"], "nover")
        resp = await client.get(f"{_metrics_url(slug)}/{metric['id']}/versions")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["app_version_column"] is None
        assert body["versions"] == []
        assert body["series"] == []


class TestListEnrichment:
    async def test_list_includes_latest_value_and_signal(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        seeded = await _create_sql_metric(client, slug, data_source["id"], "seeded")
        bare = await _create_sql_metric(client, slug, data_source["id"], "bare")
        scan_config_id = await _seed_scan_config(project["id"])
        await _seed_metric_values(seeded["id"], [(B0, 10.0), (B2, 4.0)])
        await _seed_metric_anomaly(
            scan_config_id=scan_config_id,
            metric_id=seeded["id"],
            bucket=B2,
            direction="drop",
            actual_count=4,
            expected_count=12.0,
        )

        resp = await client.get(_metrics_url(slug))
        assert resp.status_code == 200, resp.text
        items = {item["id"]: item for item in resp.json()["items"]}

        seeded_item = items[seeded["id"]]
        assert seeded_item["latest_value"] == 4.0
        assert seeded_item["spark"] == [10.0, 4.0]
        assert seeded_item["latest_signal"] is not None
        assert seeded_item["latest_signal"]["direction"] == "drop"

        bare_item = items[bare["id"]]
        assert bare_item["latest_value"] is None
        assert bare_item["spark"] == []
        assert bare_item["latest_signal"] is None

    async def test_spark_bounded_to_last_n_points(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        """With more history than ``_SPARK_POINTS``, the window-bounded query keeps
        only the trailing N values per metric — newest tail, ascending, latest last."""
        slug = project["slug"]
        metric = await _create_sql_metric(client, slug, data_source["id"], "deep")
        total_points = _SPARK_POINTS + 5
        await _seed_metric_values(
            metric["id"],
            [(B0 + timedelta(hours=i), float(i)) for i in range(total_points)],
        )

        resp = await client.get(_metrics_url(slug))
        assert resp.status_code == 200, resp.text
        item = {row["id"]: row for row in resp.json()["items"]}[metric["id"]]

        # Bounded to the trailing N, in ascending bucket order, with the most
        # recent bucket's value as both the spark tail and ``latest_value``.
        expected_tail = [float(i) for i in range(total_points - _SPARK_POINTS, total_points)]
        assert len(item["spark"]) == _SPARK_POINTS
        assert item["spark"] == expected_tail
        assert item["latest_value"] == float(total_points - 1)


class TestRoutePrecedence:
    async def test_series_route_does_not_shadow_crud(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        metric = await _create_sql_metric(client, slug, data_source["id"], "prec")

        # The single-segment CRUD route still returns the definition itself.
        crud = await client.get(f"{_metrics_url(slug)}/{metric['id']}")
        assert crud.status_code == 200, crud.text
        assert crud.json()["id"] == metric["id"]
        assert "kind" in crud.json()

        # The two-segment series route resolves to the series handler.
        series = await client.get(f"{_metrics_url(slug)}/{metric['id']}/series")
        assert series.status_code == 200, series.text
        assert series.json()["metric_id"] == metric["id"]

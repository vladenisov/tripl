import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event_metric import EventMetric
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_job import ScanJob
from tripl.models.schema_drift import SchemaDrift
from tripl.tests.conftest import TestSessionLocal


async def _seed_project_operations(
    *,
    scan_config_id: str,
    event_type_id: str,
    destination_id: str,
) -> None:
    metric_bucket = datetime(2026, 4, 18, 9, tzinfo=UTC)
    job_started_at = datetime(2026, 4, 18, 10, tzinfo=UTC)
    job_completed_at = datetime(2026, 4, 18, 10, 5, tzinfo=UTC)
    # A firing monitor needs an active scope whose last anomaly is inside the
    # recent window (summarize_monitor_states uses now - 24h), so anchor it to now.
    firing_anomaly_bucket = datetime.now(UTC)

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
        rule_id = uuid.uuid4()
        session.add(
            AlertRule(
                id=rule_id,
                destination_id=uuid.UUID(destination_id),
                name="Spike monitor",
            )
        )
        session.add(
            AlertRuleState(
                id=uuid.uuid4(),
                rule_id=rule_id,
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                is_active=True,
                last_anomaly_bucket=firing_anomaly_bucket,
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
    destination_id = destination_resp.json()["id"]

    await _seed_project_operations(
        scan_config_id=scan_config_id,
        event_type_id=event_type_id,
        destination_id=destination_id,
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
    assert summary["firing_monitor_count"] == 1
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


# --- Danger zone: project-wide detection reset ------------------------------

# Half-open reset window: rows strictly before ``_RESET_BEFORE`` are cleared.
_IN_PERIOD = datetime(2026, 1, 15, 12, tzinfo=UTC)
_OUT_OF_PERIOD = datetime(2026, 6, 15, 12, tzinfo=UTC)
_RESET_BEFORE = "2026-03-01T00:00:00Z"


async def _setup_reset_project(client: AsyncClient, slug: str) -> dict[str, str]:
    """Create project + data source + scan config + event type + metric def."""
    project_resp = await client.post(
        "/api/v1/projects", json={"name": f"Reset {slug}", "slug": slug}
    )
    assert project_resp.status_code == 201, project_resp.text
    project_id = project_resp.json()["id"]

    ds_resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": f"Warehouse {slug}",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "analytics",
            "username": "default",
            "password": "",
        },
    )
    assert ds_resp.status_code == 201, ds_resp.text
    data_source_id = ds_resp.json()["id"]

    scan_resp = await client.post(
        f"/api/v1/projects/{slug}/scans",
        json={
            "data_source_id": data_source_id,
            "name": "Production scan",
            "base_query": "SELECT 1",
        },
    )
    assert scan_resp.status_code == 201, scan_resp.text
    scan_config_id = scan_resp.json()["id"]

    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "page_view", "display_name": "Page View"},
    )
    assert et_resp.status_code == 201, et_resp.text
    event_type_id = et_resp.json()["id"]

    metric_definition_id = str(uuid.uuid4())
    async with TestSessionLocal() as session:
        session.add(
            MetricDefinition(
                id=uuid.UUID(metric_definition_id),
                project_id=uuid.UUID(project_id),
                name="conversion_rate",
                display_name="Conversion Rate",
                kind="sql",
                config={},
                data_source_id=uuid.UUID(data_source_id),
                interval="1h",
                status="active",
                unit="%",
            )
        )
        await session.commit()

    return {
        "project_id": project_id,
        "slug": slug,
        "scan_config_id": scan_config_id,
        "event_type_id": event_type_id,
        "metric_definition_id": metric_definition_id,
    }


def _anomaly(scan_config_id: str | None, scope_type: str, scope_ref: str, bucket: datetime,
             *, event_type_id: str | None = None) -> MetricAnomaly:
    return MetricAnomaly(
        id=uuid.uuid4(),
        scan_config_id=uuid.UUID(scan_config_id) if scan_config_id else None,
        scope_type=scope_type,
        scope_ref=scope_ref,
        event_id=None,
        event_type_id=uuid.UUID(event_type_id) if event_type_id else None,
        bucket=bucket,
        actual_count=42,
        expected_count=21,
        stddev=3,
        z_score=7,
        direction="spike",
    )


def _breakdown(scan_config_id: str, event_type_id: str, bucket: datetime,
               breakdown_value: str) -> MetricBreakdownAnomaly:
    return MetricBreakdownAnomaly(
        id=uuid.uuid4(),
        scan_config_id=uuid.UUID(scan_config_id),
        scope_type="event_type",
        scope_ref=event_type_id,
        event_id=None,
        event_type_id=uuid.UUID(event_type_id),
        bucket=bucket,
        breakdown_column="platform",
        breakdown_value=breakdown_value,
        is_other=False,
        actual_count=42,
        expected_count=21,
        stddev=3,
        z_score=7,
        direction="spike",
    )


@pytest.mark.asyncio
async def test_reset_anomalies_clears_period_and_covers_metric_scope(client: AsyncClient) -> None:
    ids = await _setup_reset_project(client, "reset-anom")
    scan_config_id = ids["scan_config_id"]
    event_type_id = ids["event_type_id"]
    metric_definition_id = ids["metric_definition_id"]

    event_metric_id = uuid.uuid4()
    regression_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        # In-period event-scope anomaly (deleted) + out-of-period one (kept).
        anomaly_in = _anomaly(scan_config_id, "event_type", event_type_id, _IN_PERIOD,
                              event_type_id=event_type_id)
        anomaly_out = _anomaly(scan_config_id, "event_type", event_type_id, _OUT_OF_PERIOD,
                              event_type_id=event_type_id)
        # Project-global metric-scope anomaly: NULL scan_config_id, keyed by the
        # metric definition id. Must be covered by the dual scoping branch.
        anomaly_metric = _anomaly(None, "metric", metric_definition_id, _IN_PERIOD)
        breakdown_in = _breakdown(scan_config_id, event_type_id, _IN_PERIOD, "ios")
        breakdown_out = _breakdown(scan_config_id, event_type_id, _OUT_OF_PERIOD, "android")
        session.add_all([anomaly_in, anomaly_out, anomaly_metric, breakdown_in, breakdown_out])
        # EventMetric + ReleaseRegression must survive the reset (regression guard).
        session.add(
            EventMetric(
                id=event_metric_id,
                scan_config_id=uuid.UUID(scan_config_id),
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                bucket=_IN_PERIOD,
                count=5,
            )
        )
        session.add(
            ReleaseRegression(
                id=regression_id,
                scan_config_id=uuid.UUID(scan_config_id),
                scope_type="event_type",
                scope_ref=event_type_id,
                event_id=None,
                event_type_id=uuid.UUID(event_type_id),
                app_version_column="app_version",
                version="2.0.0",
                previous_version="1.0.0",
                kind="volume_drop",
                observed_count=1,
                expected_count=2.0,
                ratio=0.5,
                share_prev=0.5,
                share_new=0.25,
                release_share=0.5,
                window_from=_IN_PERIOD,
                window_to=_OUT_OF_PERIOD,
            )
        )
        await session.commit()
        kept_anomaly_id = anomaly_out.id
        kept_breakdown_id = breakdown_out.id

    resp = await client.post(
        "/api/v1/projects/reset-anom/danger/reset-anomalies",
        json={"before": _RESET_BEFORE},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"metric_anomalies": 2, "metric_breakdown_anomalies": 1}

    async with TestSessionLocal() as session:
        remaining_anomalies = (await session.execute(select(MetricAnomaly))).scalars().all()
        assert {a.id for a in remaining_anomalies} == {kept_anomaly_id}
        remaining_breakdowns = (
            await session.execute(select(MetricBreakdownAnomaly))
        ).scalars().all()
        assert {b.id for b in remaining_breakdowns} == {kept_breakdown_id}
        # Regression guard: values + release regressions are untouched.
        event_metrics = (await session.execute(select(EventMetric))).scalars().all()
        assert {m.id for m in event_metrics} == {event_metric_id}
        regressions = (await session.execute(select(ReleaseRegression))).scalars().all()
        assert {r.id for r in regressions} == {regression_id}

    # Idempotent: a second reset over the same window deletes nothing.
    again = await client.post(
        "/api/v1/projects/reset-anom/danger/reset-anomalies",
        json={"before": _RESET_BEFORE},
    )
    assert again.status_code == 200
    assert again.json() == {"metric_anomalies": 0, "metric_breakdown_anomalies": 0}


@pytest.mark.asyncio
async def test_reset_drifts_clears_schema_and_distribution_in_period(client: AsyncClient) -> None:
    ids = await _setup_reset_project(client, "reset-drift")
    scan_config_id = ids["scan_config_id"]
    event_type_id = ids["event_type_id"]

    async with TestSessionLocal() as session:
        schema_in = SchemaDrift(
            id=uuid.uuid4(),
            event_type_id=uuid.UUID(event_type_id),
            scan_config_id=uuid.UUID(scan_config_id),
            field_name="payload.old",
            drift_type="new_field",
            detected_at=_IN_PERIOD,
        )
        schema_out = SchemaDrift(
            id=uuid.uuid4(),
            event_type_id=uuid.UUID(event_type_id),
            scan_config_id=uuid.UUID(scan_config_id),
            field_name="payload.new",
            drift_type="new_field",
            detected_at=_OUT_OF_PERIOD,
        )
        dist_in = DistributionDrift(
            id=uuid.uuid4(),
            scan_config_id=uuid.UUID(scan_config_id),
            event_type_id=uuid.UUID(event_type_id),
            field_name="platform",
            bucket=_IN_PERIOD,
            psi=0.42,
            band="significant",
            baseline_total=1000,
            current_total=1000,
            top_movers=[],
        )
        dist_out = DistributionDrift(
            id=uuid.uuid4(),
            scan_config_id=uuid.UUID(scan_config_id),
            event_type_id=uuid.UUID(event_type_id),
            field_name="country",
            bucket=_OUT_OF_PERIOD,
            psi=0.30,
            band="significant",
            baseline_total=10,
            current_total=10,
            top_movers=[],
        )
        session.add_all([schema_in, schema_out, dist_in, dist_out])
        await session.commit()
        kept_schema_id = schema_out.id
        kept_dist_id = dist_out.id

    resp = await client.post(
        "/api/v1/projects/reset-drift/danger/reset-drifts",
        json={"before": _RESET_BEFORE},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"schema_drifts": 1, "distribution_drifts": 1}

    async with TestSessionLocal() as session:
        remaining_schema = (await session.execute(select(SchemaDrift))).scalars().all()
        assert {d.id for d in remaining_schema} == {kept_schema_id}
        remaining_dist = (await session.execute(select(DistributionDrift))).scalars().all()
        assert {d.id for d in remaining_dist} == {kept_dist_id}


@pytest.mark.asyncio
async def test_reset_endpoints_are_owner_only(anon_client: AsyncClient) -> None:
    # First registered user is the owner; create the project as owner.
    owner_reg = await anon_client.post(
        "/api/v1/auth/register",
        json={"email": "reset-owner@example.com", "password": "Password123!", "name": "Owner"},
    )
    assert owner_reg.status_code == 201, owner_reg.text
    await anon_client.post("/api/v1/projects", json={"name": "Guarded", "slug": "reset-rbac"})

    # An owner-scope key is still rejected: owner actions need an interactive session.
    key_resp = await anon_client.post(
        "/api/v1/me/api-keys", json={"name": "agent", "scope": "write"}
    )
    assert key_resp.status_code == 201, key_resp.text
    owner_key = key_resp.json()["token"]

    # Second user defaults to editor (non-owner).
    await anon_client.post("/api/v1/auth/logout")
    editor_reg = await anon_client.post(
        "/api/v1/auth/register",
        json={"email": "reset-editor@example.com", "password": "Password123!", "name": "Editor"},
    )
    assert editor_reg.status_code == 201, editor_reg.text

    for path in ("reset-anomalies", "reset-drifts"):
        editor_denied = await anon_client.post(
            f"/api/v1/projects/reset-rbac/danger/{path}", json={"before": None}
        )
        assert editor_denied.status_code == 403, editor_denied.text

        key_denied = await anon_client.post(
            f"/api/v1/projects/reset-rbac/danger/{path}",
            json={"before": None},
            headers={"Authorization": f"Bearer {owner_key}"},
        )
        assert key_denied.status_code == 403, key_denied.text
        assert "owner session" in key_denied.json()["detail"].lower()

"""Tests for the demo project generator endpoint."""

import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
from tripl.core.analyzers.distribution_drift import PSI_BAND_MINOR, PSI_BAND_SIGNIFICANT
from tripl.models.data_source import DataSource, TestStatus
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.domain_enums import ProjectGenerationStatus
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SCHEMA_DRIFT_STATUS_OPEN
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.services import plan_branch_service
from tripl.services.demo import DemoContext, noise, seed_demo_content
from tripl.services.demo.builders import plan
from tripl.services.demo.scenario import DEMO_SEED
from tripl.tests.conftest import TestSessionLocal


async def _project_id_for_slug(session: AsyncSession, slug: str) -> uuid.UUID:
    return (await session.execute(select(Project.id).where(Project.slug == slug))).scalar_one()


async def _scan_config_id_for_project(
    session: AsyncSession, project_id: uuid.UUID
) -> uuid.UUID | None:
    return (
        (await session.execute(select(ScanConfig.id).where(ScanConfig.project_id == project_id)))
        .scalars()
        .first()
    )


@pytest.mark.asyncio
async def test_create_demo_project_returns_201(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    data = resp.json()
    assert data["slug"].startswith("demo-")
    assert len(data["slug"]) == len("demo-") + 6


@pytest.mark.asyncio
async def test_demo_project_has_events(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    events_resp = await client.get(f"/api/v1/projects/{slug}/events")
    assert events_resp.status_code == 200
    data = events_resp.json()
    items = data["items"] if isinstance(data, dict) else data
    assert len(items) > 0

    # At least one event should have field values
    has_field_values = any(len(ev.get("field_values", [])) > 0 for ev in items)
    assert has_field_values, "Expected at least one event with field values"


@pytest.mark.asyncio
async def test_demo_events_first_seen_matches_history_window(client: AsyncClient) -> None:
    # "First seen" (created_at) is STAGGERED across the seeded ~23-day metric
    # history (tripl-2su6 .21 / PR #51 follow-up): core events anchor the window
    # start, the rest ramp in, and nothing is younger than ~2 days. A uniform
    # history_start stamp left the Overview 14-day "active events" sparkline a
    # flat zero; the provisioning instant made everything first seen "just now".
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    events_resp = await client.get(f"/api/v1/projects/{slug}/events")
    assert events_resp.status_code == 200
    data = events_resp.json()
    items = data["items"] if isinstance(data, dict) else data
    assert items

    now = datetime.now(tz=UTC)
    ages_by_name: dict[str, float] = {}
    for ev in items:
        created = datetime.fromisoformat(ev["created_at"])
        # The API may serialize created_at without an offset; treat naive as UTC so
        # the subtraction below doesn't mix naive/aware datetimes.
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        ages_by_name[ev["name"]] = (now - created).total_seconds() / 86400

    # (a) Nothing reads as first seen "just now" — the stagger floor is ~2 days;
    # assert >= 1 day to leave deterministic-jitter slack.
    for name, age_days in ages_by_name.items():
        assert age_days >= 1, f"{name} first seen only {age_days:.1f}d ago — reads as brand new"

    # (b) The oldest (core) events still anchor the full ~23-day history window.
    assert max(ages_by_name.values()) >= noise.DEMO_HISTORY_DAYS - 1, ages_by_name
    assert ages_by_name["Home Screen View"] >= noise.DEMO_HISTORY_DAYS - 1, ages_by_name[
        "Home Screen View"
    ]

    # (c) Part of the catalog falls INSIDE the Overview KPI's 14-day lookback so
    # the "active events" sparkline is not a flat zero. (< 13d is always >= the
    # route's midnight-aligned time_from for days=14.)
    inside_14d = [name for name, age_days in ages_by_name.items() if age_days < 13]
    assert inside_14d, "no event first seen inside the last 14 days — sparkline is a flat zero"


def test_demo_event_first_seen_stagger_is_deterministic() -> None:
    # (d) Same recipe (clock + seed) -> identical first-seen timestamps: the
    # stagger derives from noise.derive_seed(seed, event name), never from
    # random state or the wall clock at call time.
    fixed_now = datetime(2026, 7, 1, 10, 30, tzinfo=UTC)
    specs = plan.event_specs(fixed_now)
    first = plan.staggered_created_ats(specs, now=fixed_now, seed=DEMO_SEED)
    second = plan.staggered_created_ats(specs, now=fixed_now, seed=DEMO_SEED)
    assert first == second
    assert len(first) == len(specs)


@pytest.mark.asyncio
async def test_demo_project_has_metrics(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    metrics_resp = await client.get(f"/api/v1/projects/{slug}/metrics/total")
    assert metrics_resp.status_code == 200
    data = metrics_resp.json()
    assert len(data["data"]) > 0, "Expected metric data points for demo project"


@pytest.mark.asyncio
async def test_demo_project_has_metrics_catalog(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    # Metrics catalog: at least the four seeded definitions, covering all kinds.
    metrics_resp = await client.get(f"/api/v1/projects/{slug}/metrics")
    assert metrics_resp.status_code == 200
    metrics = metrics_resp.json()["items"]
    assert len(metrics) >= 4, "Expected at least four seeded metric definitions"
    kinds = {metric["kind"] for metric in metrics}
    assert {"sql", "event_composition", "fact"} <= kinds, kinds

    # MetricValue rows render through the enriched list (latest value + spark).
    with_values = [metric for metric in metrics if metric["spark"]]
    assert with_values, "Expected at least one metric definition with collected values"

    # The conversion ratio is a fraction (purchases / screen views), not a count.
    conversion = next(metric for metric in metrics if metric["name"] == "purchase_conversion")
    assert conversion["kind"] == "event_composition"
    assert conversion["latest_value"] is not None
    assert 0.0 < conversion["latest_value"] < 1.0, conversion["latest_value"]


@pytest.mark.asyncio
async def test_demo_project_has_fact_table_with_named_filter(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    list_resp = await client.get(f"/api/v1/projects/{slug}/fact-tables")
    assert list_resp.status_code == 200
    fact_tables = list_resp.json()["items"]
    assert len(fact_tables) >= 1, "Expected at least one seeded fact table"

    fact_table_id = fact_tables[0]["id"]
    detail_resp = await client.get(f"/api/v1/projects/{slug}/fact-tables/{fact_table_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    filter_names = {row_filter["name"] for row_filter in detail["row_filters"]}
    assert "completed" in filter_names, filter_names


@pytest.mark.asyncio
async def test_demo_data_source_is_tested_healthy(client: AsyncClient) -> None:
    """The synthetic warehouse is stamped tested-healthy at seed time (issue .14).

    The in-memory adapter always answers, so a never-checked source would read as
    "untested" and drop out of the HEALTHY count / Overview badge for no real
    reason. Provisioning sets last_test_status=success (with last_test_at), and
    the source stays project-scoped so the Overview rail can filter it per project.
    """
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        source = (
            await session.execute(select(DataSource).where(DataSource.project_id == project_id))
        ).scalar_one()

    assert source.db_type == "synthetic"
    assert source.last_test_status == TestStatus.success
    assert source.last_test_at is not None
    assert source.project_id == project_id


@pytest.mark.asyncio
async def test_demo_fact_table_preview_serves_synthetic_orders(client: AsyncClient) -> None:
    """The fact-table preview endpoint reads real synthetic ``orders`` rows.

    The demo fact table is backed by a ``db_type='synthetic'`` DataSource, so the
    normal preview path (``POST /fact-tables/preview`` -> introspection service ->
    ``build_adapter`` -> ``SyntheticAdapter``) returns the in-memory orders rows
    and their bucketed column types with no network/filesystem access.
    """
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    fact_tables = (await client.get(f"/api/v1/projects/{slug}/fact-tables")).json()["items"]
    fact_table_id = fact_tables[0]["id"]
    detail = (await client.get(f"/api/v1/projects/{slug}/fact-tables/{fact_table_id}")).json()

    # Preview (used by the create/edit "Preview columns" surface AND schema
    # refresh) over the fact table's own SQL / data source.
    preview_resp = await client.post(
        f"/api/v1/projects/{slug}/fact-tables/preview",
        json={
            "data_source_id": detail["data_source_id"],
            "sql": detail["sql"],
            "timestamp_column": detail["timestamp_column"],
        },
    )
    assert preview_resp.status_code == 200, preview_resp.text
    preview = preview_resp.json()

    # The synthetic ``orders`` schema, bucketed by the introspection service.
    columns = {column["name"]: column["type"] for column in preview["columns"]}
    assert {"created_at", "amount", "currency", "user_id", "country", "status"} <= set(columns)
    assert columns["created_at"] == "timestamp"
    assert columns["amount"] == "number"
    assert columns["status"] == "string"
    # ``user_id`` carries an identifier signal and is offered as a candidate.
    assert "user_id" in preview["identifier_candidates"]

    # Real rows from the in-memory dataset (never fabricated, never empty).
    assert preview["sample_rows"], "Expected synthetic orders sample rows"
    first_row = preview["sample_rows"][0]
    assert set(first_row) >= {"created_at", "amount", "status"}
    assert first_row["status"] in {"completed", "pending", "refunded", "failed"}


@pytest.mark.asyncio
async def test_create_demo_project_twice_unique_slugs(client: AsyncClient) -> None:
    resp1 = await client.post("/api/v1/projects/demo")
    resp2 = await client.post("/api/v1/projects/demo")
    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp1.json()["slug"] != resp2.json()["slug"]


@pytest.mark.asyncio
async def test_demo_project_viewer_cannot_create(anon_client: AsyncClient) -> None:
    # Register a new user (default role is viewer in a fresh instance with
    # an existing owner, but in tests the first registered user becomes owner
    # and subsequent ones are viewers).  Here we use anon_client which has no
    # session at all — the endpoint should return 401.
    resp = await anon_client.post("/api/v1/projects/demo")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_delete_demo_project_cascades(client: AsyncClient) -> None:
    # A demo project is data-rich (event types, events, fields, metrics,
    # signals, drifts, scan configs). Deleting it must succeed and remove it.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    del_resp = await client.delete(f"/api/v1/projects/{slug}")
    assert del_resp.status_code == 204
    assert (await client.get(f"/api/v1/projects/{slug}")).status_code == 404


@pytest.mark.asyncio
async def test_demo_project_seeds_enabled_anomaly_settings(client: AsyncClient) -> None:
    # The scan advertises anomaly_detection_enabled=True; detect.py only runs when
    # a matching project-level ProjectAnomalySettings row is ALSO enabled, so the
    # seeder must persist one or detection would silently never run.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        settings = (
            await session.execute(
                select(ProjectAnomalySettings).where(
                    ProjectAnomalySettings.project_id == project_id
                )
            )
        ).scalar_one()

    assert settings.anomaly_detection_enabled is True
    # Gate scopes are on so the seeded event/type/project anomalies are what the
    # worker would produce.
    assert settings.detect_events is True
    assert settings.detect_project_total is True


@pytest.mark.asyncio
async def test_demo_project_anomalies_match_seeded_series(client: AsyncClient) -> None:
    # Every seeded MetricAnomaly must be reproducible from the visible EventMetric
    # series: the detector ran over exactly the stored counts, so an anomaly's
    # bucket must exist in the series and its actual/expected must be drawn from it.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        scan_config_id = await _scan_config_id_for_project(session, project_id)
        assert scan_config_id is not None

        all_anomalies = (
            (
                await session.execute(
                    select(MetricAnomaly).where(MetricAnomaly.scan_config_id == scan_config_id)
                )
            )
            .scalars()
            .all()
        )

        # Post-Wave-1 tuning, the seeded series is shaped to yield a SMALL number of
        # genuine anomalies (one visible spike per scope), not hundreds.
        assert 0 < len(all_anomalies) <= 12, len(all_anomalies)

        event_anomalies = [a for a in all_anomalies if a.scope_type == SCOPE_EVENT]
        assert event_anomalies, "expected at least one event-scope anomaly"

        for anomaly in event_anomalies:
            assert anomaly.event_id is not None
            # The anomaly bucket exists in the event's stored series.
            metric = (
                await session.execute(
                    select(EventMetric).where(
                        EventMetric.scan_config_id == scan_config_id,
                        EventMetric.event_id == anomaly.event_id,
                        EventMetric.bucket == anomaly.bucket,
                    )
                )
            ).scalar_one()
            # actual_count is drawn straight from the stored count.
            assert anomaly.actual_count == float(metric.count)

            # expected_count is drawn from the same series (a phase median), so it
            # sits within the series' observed range, and a spike overshoots it.
            series_counts = (
                (
                    await session.execute(
                        select(EventMetric.count).where(
                            EventMetric.scan_config_id == scan_config_id,
                            EventMetric.event_id == anomaly.event_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
            assert min(series_counts) <= anomaly.expected_count <= max(series_counts)
            assert anomaly.direction == "spike"
            assert anomaly.actual_count > anomaly.expected_count


@pytest.mark.asyncio
async def test_demo_project_distribution_drift_is_real_psi(client: AsyncClient) -> None:
    # Drift rows are computed by the real compute_psi over a genuinely shifting
    # platform mix, so PSI varies across buckets and each band matches the score.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        scan_config_id = await _scan_config_id_for_project(session, project_id)
        drifts = (
            (
                await session.execute(
                    select(DistributionDrift)
                    .where(DistributionDrift.scan_config_id == scan_config_id)
                    .order_by(DistributionDrift.bucket)
                )
            )
            .scalars()
            .all()
        )

    assert len(drifts) >= 3, "expected a distribution-drift ladder"

    # A genuinely drifting mix produces varied PSI, not a hand-written constant.
    psi_values = [round(drift.psi, 4) for drift in drifts]
    assert len(set(psi_values)) > 1, psi_values
    # PSI climbs toward the most recent (newest) bucket as the mix drifts further.
    assert drifts[-1].psi > drifts[0].psi

    for drift in drifts:
        # Band is exactly what compute_psi's thresholds imply from the score.
        if drift.psi < PSI_BAND_MINOR:
            assert drift.band == "stable", (drift.psi, drift.band)
        elif drift.psi < PSI_BAND_SIGNIFICANT:
            assert drift.band == "minor", (drift.psi, drift.band)
        else:
            assert drift.band == "significant", (drift.psi, drift.band)
        # Top movers are real contributions from the seeded values.
        assert drift.top_movers
        mover_values = {mover["value"] for mover in drift.top_movers}
        assert {"web", "ios"} <= mover_values


# ---------------------------------------------------------------------------
# Recipe 4: real pending branch change + variable-value drift (tripl-odrj.3)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_demo_recipe_version_is_pinned_to_4(client: AsyncClient) -> None:
    # The literal is deliberate: bumping the recipe must be a conscious edit here
    # too, so a stale demo (recipe < 4) is never mistaken for the current shape.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    assert resp.json()["demo_recipe_version"] == "4"


async def _working_branch(session: AsyncSession, project_id: uuid.UUID) -> PlanBranch:
    return (
        await session.execute(
            select(PlanBranch).where(
                PlanBranch.project_id == project_id,
                PlanBranch.kind == BranchKind.working.value,
            )
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_demo_branch_diff_is_exactly_one_modified_event(client: AsyncClient) -> None:
    # The seeded feature branch carries a REAL pending change: the plan is
    # deep-copied onto it and exactly one event description is edited, so the
    # diff (the merge preview's content) is non-empty and precisely scoped.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    branches = (await client.get(f"/api/v1/projects/{slug}/branches")).json()["items"]
    feature = next(b for b in branches if b["name"] == "feature/checkout-funnel")

    diff_resp = await client.get(f"/api/v1/projects/{slug}/branches/{feature['id']}/diff")
    assert diff_resp.status_code == 200
    diff = diff_resp.json()
    assert diff["summary"] == {"added": 0, "removed": 0, "changed": 1}
    assert len(diff["entries"]) == 1, diff["entries"]

    entry = diff["entries"][0]
    assert entry["entity_type"] == "event"
    assert entry["kind"] == "changed"
    assert entry["name"] == "Buy Button Click"
    assert {fc["field"] for fc in entry["field_changes"]} == {"description"}
    # Main has not moved since the branch was cut.
    assert diff["behind_base"] is False

    # The branch holds a full plan copy (not just the one edited row), so a
    # merge preview has real content behind it: every main event has a branch
    # counterpart.
    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        branch = await _working_branch(session, project_id)
        main_count = (
            await session.execute(
                select(func.count(Event.id)).where(
                    Event.project_id == project_id,
                    Event.branch_id != branch.id,
                )
            )
        ).scalar_one()
        branch_count = (
            await session.execute(select(func.count(Event.id)).where(Event.branch_id == branch.id))
        ).scalar_one()
    assert branch_count == main_count
    assert branch_count > 0


@pytest.mark.asyncio
async def test_demo_seeds_one_open_variable_value_drift(client: AsyncClient) -> None:
    # prod_weekly is observed OUTSIDE the documented override list for
    # product_id on Trial Started ([prod_monthly, prod_annual]), so the
    # variables drift UI (list_value_drifts / open drift counts / event drift
    # badge) has a real open row behind it. It never feeds the firing rule's
    # replay — candidates come from MetricAnomaly + schema/distribution drifts.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project_id = await _project_id_for_slug(session, slug)
        drifts = (
            (
                await session.execute(
                    select(VariableValueDrift).where(VariableValueDrift.project_id == project_id)
                )
            )
            .scalars()
            .all()
        )
        assert len(drifts) == 1, drifts
        drift = drifts[0]
        assert drift.status == SCHEMA_DRIFT_STATUS_OPEN
        assert drift.observed_values == ["prod_weekly"]
        assert drift.variable_name == "product_id"
        assert drift.event_name == "Trial Started"
        # The observed value sits outside the documented override list.
        assert not set(drift.observed_values) & {"prod_monthly", "prod_annual"}
        assert drift.resolved_at is None
        assert drift.detected_at is not None


# A fixed clock for the determinism fixtures (mirrors test_demo_scenario).
_FIXED_NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)


async def _seed_fixture(session: AsyncSession, slug: str) -> uuid.UUID:
    """Provision a demo shell + seed the full scenario at a fixed clock/seed."""
    project = Project(
        name="Demo Project",
        slug=slug,
        description="determinism fixture",
        is_demo=True,
        generation_status=ProjectGenerationStatus.seeding.value,
        generation_stage="init",
    )
    session.add(project)
    await session.flush()
    branch_id = await plan_branch_service.ensure_main_branch_id(session, project.id)
    await session.commit()
    ctx = DemoContext(
        project_id=project.id,
        branch_id=branch_id,
        slug=slug,
        now=_FIXED_NOW,
        seed=DEMO_SEED,
    )
    await seed_demo_content(session, ctx)
    await session.commit()
    return project.id


async def _drift_shape(session: AsyncSession, project_id: uuid.UUID) -> list[tuple]:
    rows = (
        (
            await session.execute(
                select(VariableValueDrift).where(VariableValueDrift.project_id == project_id)
            )
        )
        .scalars()
        .all()
    )
    return sorted(
        (
            drift.variable_name,
            drift.event_name,
            tuple(drift.observed_values),
            drift.status,
            drift.detected_at,
        )
        for drift in rows
    )


async def _branch_diff_shape(session: AsyncSession, slug: str, project_id: uuid.UUID) -> tuple:
    branch = await _working_branch(session, project_id)
    diff = await plan_branch_service.diff_branch(session, slug, branch.id)
    entries = sorted(
        (entry.entity_type, entry.kind, entry.parent, entry.name, tuple(entry.changes))
        for entry in diff.entries
    )
    return entries, diff.summary, diff.behind_base


@pytest.mark.asyncio
async def test_demo_branch_change_and_drift_are_deterministic() -> None:
    # Same clock + seed => identical drift rows and an identical branch diff:
    # the pending change and the drift derive from the recipe, never from
    # per-run randomness.
    async with TestSessionLocal() as session:
        first_id = await _seed_fixture(session, "demo-branchA")
        second_id = await _seed_fixture(session, "demo-branchB")

        first_drift = await _drift_shape(session, first_id)
        second_drift = await _drift_shape(session, second_id)
        assert first_drift == second_drift
        assert len(first_drift) == 1

        first_diff = await _branch_diff_shape(session, "demo-branchA", first_id)
        second_diff = await _branch_diff_shape(session, "demo-branchB", second_id)
        assert first_diff == second_diff
        entries, summary, behind_base = first_diff
        assert summary == {"added": 0, "removed": 0, "changed": 1}
        assert entries[0][1] == "changed"
        assert entries[0][3] == "Buy Button Click"
        assert behind_base is False


@pytest.mark.asyncio
async def test_reset_purges_branch_plan_entities_and_drift(client: AsyncClient) -> None:
    # Reset drops the old demo in full — including the branch-side plan copy and
    # the variable-value drift — and re-seeds the same shape under a fresh id.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        old_project_id = await _project_id_for_slug(session, slug)
        old_branch = await _working_branch(session, old_project_id)
        old_branch_id = old_branch.id
        old_branch_events = (
            await session.execute(
                select(func.count(Event.id)).where(Event.branch_id == old_branch_id)
            )
        ).scalar_one()
        assert old_branch_events > 0

    reset_resp = await client.post(f"/api/v1/projects/demo/{slug}/reset")
    assert reset_resp.status_code == 200

    async with TestSessionLocal() as session:
        new_project_id = await _project_id_for_slug(session, slug)
        assert new_project_id != old_project_id

        # Old rows are gone: branches, their plan copies, and the drift.
        for count_query in (
            select(func.count(PlanBranch.id)).where(PlanBranch.project_id == old_project_id),
            select(func.count(Event.id)).where(Event.branch_id == old_branch_id),
            select(func.count(VariableValueDrift.id)).where(
                VariableValueDrift.project_id == old_project_id
            ),
        ):
            assert (await session.execute(count_query)).scalar_one() == 0

        # And the fresh seed carries the same recipe-4 shape again.
        new_branch = await _working_branch(session, new_project_id)
        new_branch_events = (
            await session.execute(
                select(func.count(Event.id)).where(Event.branch_id == new_branch.id)
            )
        ).scalar_one()
        assert new_branch_events > 0
        new_drifts = (
            await session.execute(
                select(func.count(VariableValueDrift.id)).where(
                    VariableValueDrift.project_id == new_project_id
                )
            )
        ).scalar_one()
        assert new_drifts == 1

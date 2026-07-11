"""Demo project generator.

Creates a fully pre-populated project so users can explore the service without
connecting a warehouse.  Every seeded row is synthetic — the DataSource never
receives a real query.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import NotRequired, TypedDict, cast

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
    AnomalyDetectionSettings,
    SeriesPoint,
    detect_anomalies,
)
from tripl.core.analyzers.distribution_drift import compute_psi
from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricStatus,
    ProjectGenerationStatus,
    ScanInterval,
)
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.fact_table import FactTable
from tripl.models.field_definition import FieldDefinition
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.fact_table import (
    FactTableColumnSchema,
    FactTableCreate,
    FactTableRowFilter,
)
from tripl.schemas.metric_definition import (
    EventCompositionMetricCreate,
    FactMetricCreate,
    FactOperand,
    SqlConfig,
    SqlMetricCreate,
)
from tripl.schemas.project import ProjectResponse
from tripl.services import plan_branch_service, project_service
from tripl.services.project_service import demo_data_source_name
from tripl.services.search_service import reindex_project_branch

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


class _DemoEventSpec(TypedDict):
    et: EventType
    name: str
    description: str
    base: int
    status: str
    tags: list[str]
    fvs: dict[uuid.UUID, str]
    last_seen_at: datetime | None
    metric_breakdown_columns: list[str]
    sunset_at: NotRequired[datetime]


def _hour_buckets(now: datetime, days: int) -> list[datetime]:
    """Return UTC hour-aligned buckets covering the last ``days`` days."""
    end = now.replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days)
    result: list[datetime] = []
    cursor = start
    while cursor < end:
        result.append(cursor)
        cursor += timedelta(hours=1)
    return result


def _sinusoidal_count(base: int, bucket: datetime, noise_seed: int) -> int:
    """Daily sinusoid with a small deterministic noise term."""
    hour_of_day = bucket.hour
    # peak around 14:00 UTC, trough around 02:00
    sinusoid = math.sin((hour_of_day - 2) * math.pi / 12)
    # cheap deterministic noise: hash the seed+hour to ±10 %
    noise = ((noise_seed * 31 + bucket.day * 7 + hour_of_day * 13) % 21 - 10) / 100.0
    raw = base * (1 + 0.4 * sinusoid + noise)
    return max(1, round(raw))


# Wall-clock length of the seeded hourly history. The seasonal (hour-of-week)
# phase baseline in the anomaly detector needs 3 full weekly cycles = 504 hourly
# buckets BEFORE the evaluation window, or ``detect_anomalies`` silently degrades
# to the seasonality-blind rolling fallback. 23 days = 552 buckets gives 504 of
# history plus a 48h evaluation window, and the newest bucket sits one hour before
# ``now`` so the signal stays inside the Wave-1 freshness horizon
# (``LATEST_SCAN_STALE_INTERVALS`` = 3 intervals).
_DEMO_HISTORY_DAYS = 23
_DEMO_EVAL_WINDOW_HOURS = 48
_DEMO_SPIKE_MULTIPLIER = 3

# Anomaly-detector settings mirrored from the ProjectAnomalySettings row seeded
# below (Wave-1 defaults). Running the real detector with these guarantees every
# seeded MetricAnomaly is exactly what the worker would produce over the visible
# EventMetric series.
_DEMO_ANOMALY_SETTINGS = AnomalyDetectionSettings(
    baseline_window_buckets=14,
    min_history_buckets=7,
    sigma_threshold=3.0,
    min_expected_count=10,
)

# Distribution-drift showcase: the platform mix drifts only over the final
# ``_DEMO_DRIFT_SPAN_DAYS`` days so the real PSI climbs a stable -> minor ->
# significant ladder against the window-start baseline.
_DEMO_DRIFT_SPAN_DAYS = 8
_DEMO_DRIFT_DAILY_TOTAL = 48000


def _hourly_volume(
    base: int, bucket: datetime, idx: int, noise_seed: int, total_buckets: int
) -> int:
    """Deterministic hourly volume: daily + gentle weekly shape, a phase-consistent
    texture, and a slow upward drift.

    The texture depends only on ``(noise_seed, weekday, hour)`` — never on the week
    — so the same hour-of-week repeats identically across cycles. That keeps the
    detector's seasonal phase baseline tight (near-zero robust scale), so the
    injected spike is the only deviation that clears the sigma gate and the demo
    yields a small, reproducible set of anomalies instead of noise-driven false
    positives. The drift stays well under the detector's 15% trend-shift gate.
    """
    hour = bucket.hour
    weekday = bucket.weekday()
    daily = math.sin((hour - 2) * math.pi / 12)
    weekly = 0.08 * math.sin(weekday * math.pi / 3.5)
    texture = ((noise_seed * 31 + weekday * 7 + hour * 13) % 15 - 7) / 100.0
    drift = 0.04 * (idx / max(total_buckets - 1, 1))
    raw = base * (1 + 0.35 * daily + weekly + texture + drift)
    return max(1, round(raw))


def _platform_shares(progress: float) -> dict[str, float]:
    """Platform mix at ``progress`` (0 = drift start, 1 = now). Web share rises
    while iOS falls, so the distribution genuinely drifts over the window."""
    clamped = min(max(progress, 0.0), 1.0)
    web = 0.12 + 0.24 * clamped
    ios = 0.55 - 0.18 * clamped
    android = max(0.01, 1.0 - web - ios)
    return {"ios": ios, "android": android, "web": web}


def _shares_to_counts(shares: dict[str, float], total: int) -> dict[str, int]:
    return {value: max(0, round(share * total)) for value, share in shares.items()}


def _drift_span_progress(days_before_now: float) -> float:
    """Fraction into the drift ramp for a bucket ``days_before_now`` old. The mix
    only starts drifting ``_DEMO_DRIFT_SPAN_DAYS`` before now."""
    return min(max((_DEMO_DRIFT_SPAN_DAYS - days_before_now) / _DEMO_DRIFT_SPAN_DAYS, 0.0), 1.0)


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------


DEMO_RECIPE_VERSION = "1"


async def create_demo_project(
    session: AsyncSession,
    *,
    created_by: uuid.UUID | None = None,
    slug: str | None = None,
) -> ProjectResponse:
    """Provision a demo workspace atomically.

    Phase 1 commits a hidden, ``seeding`` project shell as the provisioning
    marker; phase 2 seeds all demo content and promotes it to ``ready``. A
    mid-seed failure rolls the partial seed back and marks the shell ``failed``
    (still hidden from normal project lists), so a partial or failed demo never
    surfaces as a real workspace. ``created_by`` records provenance so the
    creator can manage their own demo; ``slug`` lets ``reset`` re-seed in place.
    """
    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    if slug is None:
        # Unique slug so repeated create calls never collide.
        slug = f"demo-{uuid.uuid4().hex[:6]}"

    # Phase 1: durable hidden shell, committed first as the provisioning marker.
    project = Project(
        name="Demo Project",
        slug=slug,
        description=(
            "A pre-populated demo workspace. "
            "Explore events, metrics, signals, and distribution drift "
            "without connecting a warehouse."
        ),
        is_demo=True,
        demo_recipe_version=DEMO_RECIPE_VERSION,
        generation_status=ProjectGenerationStatus.seeding.value,
        generation_stage="init",
        created_by_user_id=created_by,
    )
    session.add(project)
    await session.flush()
    project_id = project.id
    branch_id = await plan_branch_service.ensure_main_branch_id(session, project_id)
    await session.commit()
    await cache.delete_prefix(cache.prefix_projects())

    # Phase 2: seed all content, then promote to ready — or record a safe failure.
    try:
        await _seed_demo_content(
            session, project_id=project_id, branch_id=branch_id, slug=slug, now=now
        )
    except Exception as exc:
        await session.rollback()
        failed = await session.get(Project, project_id)
        if failed is not None:
            failed.generation_status = ProjectGenerationStatus.failed.value
            failed.generation_stage = None
            failed.generation_error = _safe_generation_error(exc)
            await session.commit()
        await cache.delete_prefix(cache.prefix_projects())
        raise HTTPException(status_code=500, detail="Demo provisioning failed") from exc

    ready = await session.get(Project, project_id)
    if ready is not None:
        ready.generation_status = ProjectGenerationStatus.ready.value
        ready.generation_stage = None
        ready.generation_error = None
        ready.demo_seeded_at = now
    await session.commit()
    await cache.delete_prefix(cache.prefix_projects())
    await cache.delete_prefix(cache.prefix_data_sources())
    return await project_service.get_project(session, slug)


async def reset_demo_project(
    session: AsyncSession, slug: str, *, created_by: uuid.UUID | None = None
) -> ProjectResponse:
    """Restore a demo to its freshly-seeded state under the same slug.

    Delete removes the demo and its owned synthetic warehouse; recreate re-seeds
    under the same slug so the demo URL stays stable across a reset. The original
    creator is preserved so ownership-based management still applies afterwards.
    """
    project = await project_service.get_project_by_slug(session, slug)
    if not project.is_demo:
        raise HTTPException(status_code=400, detail="Only demo projects can be reset")
    creator = project.created_by_user_id or created_by
    await project_service.delete_project(session, slug)
    return await create_demo_project(session, created_by=creator, slug=slug)


def _safe_generation_error(exc: Exception) -> str:
    """Short, user-safe failure summary — never internals (SQL, secrets, trace)."""
    return f"Demo provisioning failed during seeding ({type(exc).__name__})."


async def _seed_demo_content(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str,
    now: datetime,
) -> None:
    """Seed all demo content into an existing project shell (does not commit).

    Every seeded row is synthetic — the DataSource never receives a real query.
    Runs inside the caller's phase-2 transaction so a failure rolls back cleanly.
    """
    # 2. DataSource (never actually queried). Scoped to this demo project so it is
    # cleaned up with the project instead of leaking a workspace-global orphan.
    data_source = DataSource(
        project_id=project_id,
        name=demo_data_source_name(slug),
        db_type="clickhouse",
        host="demo.internal",
        port=8123,
        database_name="analytics",
        username="demo",
        password_encrypted="",
    )
    session.add(data_source)
    await session.flush()

    # 3. Event types
    et_screen_view = EventType(
        project_id=project_id,
        branch_id=branch_id,
        name="screen_view",
        display_name="Screen View",
        color="#6366f1",
        order=0,
    )
    et_click = EventType(
        project_id=project_id,
        branch_id=branch_id,
        name="click",
        display_name="Click",
        color="#22c55e",
        order=1,
    )
    et_purchase = EventType(
        project_id=project_id,
        branch_id=branch_id,
        name="purchase",
        display_name="Purchase",
        color="#f59e0b",
        order=2,
    )
    session.add_all([et_screen_view, et_click, et_purchase])
    await session.flush()

    # 4. Field definitions
    # screen_view
    fd_sv_screen_name = FieldDefinition(
        event_type_id=et_screen_view.id,
        name="screen_name",
        display_name="Screen Name",
        field_type="string",
        is_required=True,
        order=0,
    )
    fd_sv_platform = FieldDefinition(
        event_type_id=et_screen_view.id,
        name="platform",
        display_name="Platform",
        field_type="enum",
        is_required=False,
        enum_options=["ios", "android", "web"],
        order=1,
    )
    # click
    fd_cl_button_id = FieldDefinition(
        event_type_id=et_click.id,
        name="button_id",
        display_name="Button ID",
        field_type="string",
        is_required=False,
        order=0,
    )
    fd_cl_screen_name = FieldDefinition(
        event_type_id=et_click.id,
        name="screen_name",
        display_name="Screen Name",
        field_type="string",
        is_required=False,
        order=1,
    )
    fd_cl_platform = FieldDefinition(
        event_type_id=et_click.id,
        name="platform",
        display_name="Platform",
        field_type="enum",
        is_required=False,
        enum_options=["ios", "android", "web"],
        order=2,
    )
    # purchase
    fd_pu_product_id = FieldDefinition(
        event_type_id=et_purchase.id,
        name="product_id",
        display_name="Product ID",
        field_type="string",
        is_required=False,
        order=0,
    )
    fd_pu_amount = FieldDefinition(
        event_type_id=et_purchase.id,
        name="amount",
        display_name="Amount",
        field_type="number",
        is_required=False,
        order=1,
    )
    fd_pu_currency = FieldDefinition(
        event_type_id=et_purchase.id,
        name="currency",
        display_name="Currency",
        field_type="enum",
        is_required=False,
        enum_options=["USD", "EUR"],
        order=2,
    )
    fd_pu_platform = FieldDefinition(
        event_type_id=et_purchase.id,
        name="platform",
        display_name="Platform",
        field_type="enum",
        is_required=False,
        enum_options=["ios", "android", "web"],
        order=3,
    )
    fd_pu_payload = FieldDefinition(
        event_type_id=et_purchase.id,
        name="payload",
        display_name="Payload",
        field_type="json",
        is_required=False,
        order=4,
    )
    session.add_all(
        [
            fd_sv_screen_name,
            fd_sv_platform,
            fd_cl_button_id,
            fd_cl_screen_name,
            fd_cl_platform,
            fd_pu_product_id,
            fd_pu_amount,
            fd_pu_currency,
            fd_pu_platform,
            fd_pu_payload,
        ]
    )
    await session.flush()

    # 5. Meta fields
    mf_jira = MetaFieldDefinition(
        project_id=project_id,
        branch_id=branch_id,
        name="jira",
        display_name="Jira ticket",
        field_type="url",
        link_template="https://jira.example.com/{value}",
        order=0,
    )
    mf_owner = MetaFieldDefinition(
        project_id=project_id,
        branch_id=branch_id,
        name="owner_team",
        display_name="Owner team",
        field_type="string",
        order=1,
    )
    session.add_all([mf_jira, mf_owner])
    await session.flush()

    # 6. ScanConfig
    scan_config = ScanConfig(
        data_source_id=data_source.id,
        project_id=project_id,
        name="Demo scan",
        base_query="SELECT 1 -- demo",
        time_column="event_time",  # required for _get_default_scan_config_id
        interval="1h",
        anomaly_detection_enabled=True,
        distribution_drift_fields=["platform"],
        metric_breakdown_columns=["platform"],
    )
    session.add(scan_config)
    await session.flush()

    # 6b. Project-level anomaly gate. ``detect.py`` bails out (and purges any
    # anomalies) when this row is absent or disabled — so the advertised
    # ``anomaly_detection_enabled`` scan flag must be backed by an enabled
    # settings row, or detection never actually runs. Values mirror the Wave-1
    # defaults used by ``_DEMO_ANOMALY_SETTINGS`` so the seeded anomalies are
    # exactly what the worker would produce.
    session.add(
        ProjectAnomalySettings(
            project_id=project_id,
            anomaly_detection_enabled=True,
            detect_project_total=True,
            detect_event_types=True,
            detect_events=True,
            detect_metrics=True,
            baseline_window_buckets=_DEMO_ANOMALY_SETTINGS.baseline_window_buckets,
            min_history_buckets=_DEMO_ANOMALY_SETTINGS.min_history_buckets,
            sigma_threshold=_DEMO_ANOMALY_SETTINGS.sigma_threshold,
            min_expected_count=_DEMO_ANOMALY_SETTINGS.min_expected_count,
        )
    )
    await session.flush()

    # 7. Events
    #
    # We define a flat list of (event_type, name, description, base_volume,
    # implemented, reviewed, archived, tags, field_values_map).
    # base_volume drives the hourly metric row counts.

    seven_days_ago = now - timedelta(days=7)
    two_days_ago = now - timedelta(days=2)
    one_day_ago = now - timedelta(days=1)

    # Status guide:
    #   live          — high-volume, implemented, recent last_seen_at
    #   implemented   — implemented but no warehouse data yet
    #   in_review     — new/scanned event (reviewed=False in old schema)
    #   ready_for_dev — reviewed and planned, not yet built (reviewed=True, implemented=False)
    #   archived      — Legacy CTA Click
    #   deprecated    — Promo Applied (sunset showcase)
    event_specs = cast(
        list[_DemoEventSpec],
        [
            # screen_view events
            dict(
                et=et_screen_view,
                name="Home Screen View",
                description="User lands on the home screen.",
                base=1800,
                status="live",
                tags=["core", "onboarding"],
                fvs={fd_sv_screen_name.id: "home", fd_sv_platform.id: "${platform}"},
                last_seen_at=now - timedelta(minutes=15),
                metric_breakdown_columns=["platform"],
            ),
            dict(
                et=et_screen_view,
                name="Paywall View",
                description="User sees the paywall / subscription upsell screen.",
                base=600,
                status="live",
                tags=["core", "checkout"],
                fvs={fd_sv_screen_name.id: "paywall", fd_sv_platform.id: "${platform}"},
                last_seen_at=now - timedelta(hours=1),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_screen_view,
                name="Onboarding Step 1 View",
                description="First step of the onboarding flow.",
                base=900,
                status="live",
                tags=["onboarding"],
                fvs={fd_sv_screen_name.id: "onboarding_step1", fd_sv_platform.id: "${platform}"},
                last_seen_at=now - timedelta(hours=2),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_screen_view,
                name="Onboarding Step 2 View",
                description="Second step of the onboarding flow.",
                base=700,
                status="in_review",
                tags=["onboarding"],
                fvs={fd_sv_screen_name.id: "onboarding_step2", fd_sv_platform.id: "${platform}"},
                last_seen_at=now - timedelta(hours=3),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_screen_view,
                name="Profile Screen View",
                description="User opens their profile.",
                base=400,
                status="live",
                tags=["core"],
                fvs={fd_sv_screen_name.id: "profile", fd_sv_platform.id: "${platform}"},
                last_seen_at=now - timedelta(hours=4),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_screen_view,
                name="Settings Screen View",
                description="User opens app settings.",
                base=200,
                status="in_review",
                tags=[],
                fvs={fd_sv_screen_name.id: "settings"},
                last_seen_at=None,
                metric_breakdown_columns=[],
            ),
            # click events
            dict(
                et=et_click,
                name="Buy Button Click",
                description="User taps the primary CTA on the paywall.",
                base=300,
                status="live",
                tags=["core", "checkout"],
                fvs={
                    fd_cl_button_id.id: "buy_now",
                    fd_cl_screen_name.id: "paywall",
                    fd_cl_platform.id: "${platform}",
                },
                last_seen_at=now - timedelta(minutes=30),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_click,
                name="Skip Onboarding Click",
                description="User skips onboarding.",
                base=180,
                status="live",
                tags=["onboarding"],
                fvs={
                    fd_cl_button_id.id: "skip_onboarding",
                    fd_cl_screen_name.id: "onboarding_step1",
                    fd_cl_platform.id: "${platform}",
                },
                last_seen_at=now - timedelta(hours=5),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_click,
                name="Restore Purchase Click",
                description="User taps restore purchase.",
                base=40,
                status="in_review",
                tags=["checkout"],
                fvs={fd_cl_button_id.id: "restore_purchase", fd_cl_screen_name.id: "paywall"},
                last_seen_at=now - timedelta(hours=8),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_click,
                name="Share Button Click",
                description="User shares content.",
                base=120,
                status="in_review",
                tags=[],
                fvs={fd_cl_button_id.id: "share"},
                last_seen_at=None,
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_click,
                name="Legacy CTA Click",
                description="Old primary CTA, replaced by buy_now.",
                base=20,
                status="archived",
                tags=["checkout"],
                fvs={fd_cl_button_id.id: "old_cta"},
                last_seen_at=seven_days_ago,
                metric_breakdown_columns=[],
            ),
            # purchase events
            dict(
                et=et_purchase,
                name="Purchase Completed",
                description="User successfully completes an in-app purchase.",
                base=120,
                status="live",
                tags=["core", "checkout"],
                fvs={
                    fd_pu_product_id.id: "${product_id}",
                    fd_pu_amount.id: "9.99",
                    fd_pu_currency.id: "USD",
                    fd_pu_platform.id: "${platform}",
                },
                last_seen_at=now - timedelta(minutes=45),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Purchase Failed",
                description="An in-app purchase was attempted but failed.",
                base=15,
                status="live",
                tags=["checkout"],
                fvs={
                    fd_pu_product_id.id: "${product_id}",
                    fd_pu_currency.id: "USD",
                    fd_pu_platform.id: "${platform}",
                },
                last_seen_at=now - timedelta(hours=2),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Trial Started",
                description="User starts a free trial.",
                base=250,
                status="live",
                tags=["checkout", "onboarding"],
                fvs={fd_pu_product_id.id: "${product_id}", fd_pu_platform.id: "${platform}"},
                last_seen_at=now - timedelta(hours=1),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Subscription Renewed",
                description="Recurring subscription renewal processed.",
                base=80,
                status="in_review",
                tags=["checkout"],
                fvs={
                    fd_pu_product_id.id: "${product_id}",
                    fd_pu_amount.id: "9.99",
                    fd_pu_currency.id: "USD",
                },
                last_seen_at=now - timedelta(hours=6),
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Refund Processed",
                description="A refund was issued to the user.",
                base=8,
                status="in_review",
                tags=[],
                fvs={fd_pu_product_id.id: "${product_id}", fd_pu_amount.id: "9.99"},
                last_seen_at=None,
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Promo Applied",
                description="User redeemed a promotional code.",
                base=35,
                status="deprecated",
                sunset_at=now - timedelta(days=1),
                tags=["checkout", "onboarding"],
                fvs={fd_pu_product_id.id: "${product_id}", fd_pu_platform.id: "${platform}"},
                last_seen_at=two_days_ago,
                metric_breakdown_columns=[],
            ),
            dict(
                et=et_purchase,
                name="Subscription Cancelled",
                description="User cancels their subscription.",
                base=22,
                status="implemented",
                tags=["checkout"],
                fvs={fd_pu_product_id.id: "${product_id}", fd_pu_platform.id: "${platform}"},
                last_seen_at=one_day_ago,
                metric_breakdown_columns=[],
            ),
        ],
    )

    events: list[Event] = []
    for order, spec in enumerate(event_specs):
        ev = Event(
            project_id=project_id,
            branch_id=branch_id,
            event_type_id=spec["et"].id,
            name=spec["name"],
            description=spec["description"],
            order=order,
            status=spec["status"],
            sunset_at=spec.get("sunset_at"),
            last_seen_at=spec.get("last_seen_at"),
            metric_breakdown_columns=spec["metric_breakdown_columns"],
        )
        session.add(ev)
        events.append(ev)

    await session.flush()

    # Field values + tags
    for spec, ev in zip(event_specs, events, strict=True):
        for fd_id, value in spec["fvs"].items():
            session.add(EventFieldValue(event_id=ev.id, field_definition_id=fd_id, value=value))
        for tag_name in spec["tags"]:
            session.add(EventTag(event_id=ev.id, name=tag_name))

    await session.flush()

    # 8. Variables + VariableValues
    var_user_id = Variable(
        project_id=project_id,
        branch_id=branch_id,
        name="user_id",
        source_name="user_id",
        variable_type="string",
        description="Unique identifier for the authenticated user.",
    )
    var_session_id = Variable(
        project_id=project_id,
        branch_id=branch_id,
        name="session_id",
        source_name="session_id",
        variable_type="string",
        description="Session identifier scoped to one app launch.",
    )
    var_product_id = Variable(
        project_id=project_id,
        branch_id=branch_id,
        name="product_id",
        source_name="product_id",
        variable_type="string",
        description="Store product / SKU identifier.",
    )
    session.add_all([var_user_id, var_session_id, var_product_id])
    await session.flush()

    # Attach VariableValues to a few event/field pairs
    # user_id appears in many events via ${user_id} — attach to the first screen_view
    home_event = events[0]  # Home Screen View
    session.add(
        VariableValue(
            project_id=project_id,
            branch_id=branch_id,
            variable_id=var_user_id.id,
            event_id=home_event.id,
            field_definition_id=fd_sv_screen_name.id,
            source_column="user_id",
            value_kind="low",
            observed_count=14823,
            values=["u_001", "u_002", "u_003", "u_004", "u_005"],
        )
    )
    # product_id in purchase completed
    purchase_event = events[11]  # Purchase Completed
    session.add(
        VariableValue(
            project_id=project_id,
            branch_id=branch_id,
            variable_id=var_product_id.id,
            event_id=purchase_event.id,
            field_definition_id=fd_pu_product_id.id,
            source_column="product_id",
            value_kind="low",
            observed_count=3241,
            values=["prod_monthly", "prod_annual", "prod_lifetime"],
        )
    )
    # session_id in paywall view
    paywall_event = events[1]  # Paywall View
    session.add(
        VariableValue(
            project_id=project_id,
            branch_id=branch_id,
            variable_id=var_session_id.id,
            event_id=paywall_event.id,
            field_definition_id=fd_sv_screen_name.id,
            source_column="session_id",
            value_kind="low",
            observed_count=6102,
            values=["sess_aaa", "sess_bbb", "sess_ccc"],
        )
    )
    await session.flush()

    # 9. EventMetric rows
    #
    # Strategy:
    #   - Per-event rows: event_id=ev.id, event_type_id=None
    #   - Per-type aggregate rows: event_id=None, event_type_id=et.id
    #   - Project-total rows: event_id=None, event_type_id=et.id (summed in
    #     metrics_service._get_metric_rows for SCOPE_PROJECT_TOTAL which sums
    #     all rows WHERE event_id IS NULL AND event_type_id IS NOT NULL)
    #
    # ``_DEMO_HISTORY_DAYS`` of hourly buckets gives the seasonal detector enough
    # weekly cycles to engage. The "spike" event is Home Screen View (events[0]):
    # its newest bucket is inflated ×``_DEMO_SPIKE_MULTIPLIER`` — a single, sharply
    # visible deviation that the real detector (run in section 10) turns into one
    # reproducible anomaly per scope.
    buckets = _hour_buckets(now, days=_DEMO_HISTORY_DAYS)
    total_buckets = len(buckets)
    evaluation_start = now - timedelta(hours=_DEMO_EVAL_WINDOW_HOURS)
    evaluation_end = now
    spike_event = events[0]  # Home Screen View, base=1800
    screen_view_type_id = et_screen_view.id
    spike_bucket = buckets[-1]  # newest full hour, ~1h before now (fresh signal)

    # Collect type-level counts per bucket for the aggregate rows, plus the raw
    # Home Screen View series so section 10 detects over exactly what is stored.
    type_bucket_counts: dict[tuple[uuid.UUID, datetime], int] = {}
    home_series: dict[datetime, int] = {}

    for spec, ev in zip(event_specs, events, strict=True):
        base = spec["base"]
        noise_seed = hash(ev.id) % 997
        for idx, bucket in enumerate(buckets):
            count = _hourly_volume(base, bucket, idx, noise_seed, total_buckets)

            # Single-bucket spike on Home Screen View's newest bucket.
            if ev is spike_event and bucket == spike_bucket:
                count *= _DEMO_SPIKE_MULTIPLIER

            session.add(
                EventMetric(
                    scan_config_id=scan_config.id,
                    event_id=ev.id,
                    event_type_id=None,
                    bucket=bucket,
                    count=count,
                )
            )

            et_id = spec["et"].id
            type_bucket_counts[(et_id, bucket)] = type_bucket_counts.get((et_id, bucket), 0) + count
            if ev is spike_event:
                home_series[bucket] = count

    await session.flush()

    # Per-type aggregate rows
    for (et_id, bucket), count in type_bucket_counts.items():
        session.add(
            EventMetric(
                scan_config_id=scan_config.id,
                event_id=None,
                event_type_id=et_id,
                bucket=bucket,
                count=count,
            )
        )

    await session.flush()

    # 10. MetricAnomaly rows produced by RUNNING the real detector over the seeded
    #     series — not hand-written z-scores. The ×N spike injected into Home
    #     Screen View's newest bucket is the only deviation that clears the sigma
    #     gate, so each scope yields a single, reproducible anomaly whose
    #     actual/expected are drawn straight from the visible chart data.
    def _seed_scope_anomalies(
        series: dict[datetime, int],
        *,
        scope_type: str,
        scope_ref: str,
        event_id: uuid.UUID | None,
        event_type_id: uuid.UUID | None,
    ) -> None:
        points = [
            SeriesPoint(bucket=bucket, count=count) for bucket, count in sorted(series.items())
        ]
        for anomaly in detect_anomalies(
            points,
            interval=timedelta(hours=1),
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            settings=_DEMO_ANOMALY_SETTINGS,
        ):
            session.add(
                MetricAnomaly(
                    scan_config_id=scan_config.id,
                    scope_type=scope_type,
                    scope_ref=scope_ref,
                    event_id=event_id,
                    event_type_id=event_type_id,
                    bucket=anomaly.bucket,
                    actual_count=anomaly.actual_count,
                    expected_count=anomaly.expected_count,
                    stddev=anomaly.stddev,
                    z_score=anomaly.z_score,
                    direction=anomaly.direction,
                )
            )

    # Event scope: Home Screen View's own series.
    _seed_scope_anomalies(
        home_series,
        scope_type=SCOPE_EVENT,
        scope_ref=str(spike_event.id),
        event_id=spike_event.id,
        event_type_id=None,
    )

    # Event-type scope: the screen_view aggregate (Home rolls up into it).
    screen_view_series = {
        bucket: count
        for (et_id, bucket), count in type_bucket_counts.items()
        if et_id == screen_view_type_id
    }
    _seed_scope_anomalies(
        screen_view_series,
        scope_type=SCOPE_EVENT_TYPE,
        scope_ref=str(screen_view_type_id),
        event_id=None,
        event_type_id=screen_view_type_id,
    )

    # Project-total scope: sum of every type aggregate per bucket (scope_ref is the
    # scan_config_id, per metrics_service).
    project_total_series: dict[datetime, int] = {}
    for (_et_id, bucket), count in type_bucket_counts.items():
        project_total_series[bucket] = project_total_series.get(bucket, 0) + count
    _seed_scope_anomalies(
        project_total_series,
        scope_type=SCOPE_PROJECT_TOTAL,
        scope_ref=str(scan_config.id),
        event_id=None,
        event_type_id=None,
    )

    await session.flush()

    # 11. EventMetricBreakdown: platform split for Home Screen View over the drift
    #     span, hourly. The mix drifts (web up, iOS down) so the visible breakdown
    #     matches the distribution-drift badges seeded below. Bucket totals reuse
    #     the stored Home Screen View series so the split sums to the volume chart.
    breakdown_buckets = _hour_buckets(now, days=_DEMO_DRIFT_SPAN_DAYS)
    for idx, bucket in enumerate(breakdown_buckets):
        total_count = home_series.get(
            bucket, _hourly_volume(1800, bucket, idx, hash(spike_event.id) % 997, total_buckets)
        )
        days_before = (now - bucket).total_seconds() / 86400.0
        shares = _platform_shares(_drift_span_progress(days_before))
        for platform, count in _shares_to_counts(shares, total_count).items():
            session.add(
                EventMetricBreakdown(
                    scan_config_id=scan_config.id,
                    event_id=spike_event.id,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value=platform,
                    is_other=False,
                    count=max(1, count),
                )
            )

    await session.flush()

    # 12. DistributionDrift for 'platform' on screen_view, one daily row across the
    #     drift span. PSI / band / top_movers come from the REAL ``compute_psi``
    #     over the window-start baseline mix vs each day's drifted mix, so every
    #     badge is reproducible from the seeded distribution and climbs a natural
    #     stable -> minor -> significant ladder.
    baseline_counts = _shares_to_counts(_platform_shares(0.0), _DEMO_DRIFT_DAILY_TOTAL)
    for days_back in range(_DEMO_DRIFT_SPAN_DAYS, 0, -1):
        drift_bucket = (now - timedelta(days=days_back)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        current_shares = _platform_shares(_drift_span_progress(float(days_back)))
        current_counts = _shares_to_counts(current_shares, _DEMO_DRIFT_DAILY_TOTAL)
        result = compute_psi(baseline_counts, current_counts)
        session.add(
            DistributionDrift(
                scan_config_id=scan_config.id,
                event_type_id=et_screen_view.id,
                field_name="platform",
                bucket=drift_bucket,
                psi=result.psi,
                band=result.band,
                baseline_total=result.baseline_total,
                current_total=result.current_total,
                top_movers=[
                    {
                        "value": mover.value,
                        "baseline_share": mover.baseline_share,
                        "current_share": mover.current_share,
                        "contribution": mover.contribution,
                    }
                    for mover in result.top_movers
                ],
            )
        )

    # 13. SchemaDrift
    session.add(
        SchemaDrift(
            event_type_id=et_purchase.id,
            scan_config_id=scan_config.id,
            field_name="amount",
            drift_type="type_changed",
            observed_type="String",
            declared_type="number",
            sample_value="9.99",
            status="open",
        )
    )
    session.add(
        SchemaDrift(
            event_type_id=et_purchase.id,
            scan_config_id=scan_config.id,
            field_name="currency",
            drift_type="enum_violation",
            observed_type=None,
            declared_type=None,
            sample_value="GBP",
            status="open",
        )
    )

    await session.flush()

    # 14. Metrics catalog: a fact table, four metric definitions (one of each
    #     kind), and pre-collected MetricValue series so the catalog and metric
    #     drilldowns render with data (the demo worker never runs).
    #
    # The definitions are built from the authoritative Pydantic create schemas so
    # their validators run (SQL safety, identifier allowlist, fact composition
    # rules) and the config JSON is guaranteed correct, then persisted as ORM rows
    # via ``to_create_values()``. We deliberately do NOT call the catalog services
    # here: each of them commits internally, which would break this seeder's
    # single end-of-function commit.

    # 14a. Fact table "orders" (a synthetic read-only SELECT; never queried).
    orders_fact_create = FactTableCreate(
        name="orders",
        display_name="Orders",
        description="One row per store order, used by the revenue fact metrics.",
        color="#0ea5e9",
        data_source_id=data_source.id,
        sql=(
            "SELECT created_at, amount, currency, user_id, country, status "
            "FROM orders"
        ),
        timestamp_column="created_at",
        columns=[
            FactTableColumnSchema(name="created_at", type="timestamp"),
            FactTableColumnSchema(name="amount", type="number"),
            FactTableColumnSchema(name="currency", type="string"),
            FactTableColumnSchema(name="user_id", type="string"),
            FactTableColumnSchema(name="country", type="string"),
            FactTableColumnSchema(name="status", type="string"),
        ],
        identifier_columns=["user_id"],
        row_filters=[FactTableRowFilter(name="completed", sql="status = 'completed'")],
    )
    orders_fact = FactTable(
        project_id=project_id, order=0, **orders_fact_create.to_create_values()
    )
    session.add(orders_fact)
    await session.flush()

    # 14b. Four metric definitions: one sql, one event_composition ratio, and two
    #      fact metrics (single + ratio). All active, reviewed-as-collected.
    sql_metric_create = SqlMetricCreate(
        name="active_sessions",
        display_name="Active Sessions",
        description="Distinct sessions seen per day.",
        color="#6366f1",
        order=0,
        unit="sessions",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        config=SqlConfig(
            metric_sql=(
                "SELECT toStartOfDay(event_time) AS ts, "
                "count(DISTINCT session_id) AS value FROM events"
            ),
            time_column="ts",
        ),
        data_source_id=data_source.id,
        interval=ScanInterval.d1,
    )
    conversion_metric_create = EventCompositionMetricCreate(
        name="purchase_conversion",
        display_name="Purchase conversion",
        description="Completed purchases per Home Screen View.",
        color="#22c55e",
        order=1,
        unit="%",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.ratio,
        numerator_event_id=purchase_event.id,  # Purchase Completed (events[11])
        denominator_event_id=home_event.id,  # Home Screen View (events[0])
    )
    revenue_metric_create = FactMetricCreate(
        name="revenue_completed",
        display_name="Revenue (completed)",
        description="Sum of completed-order amounts per day.",
        color="#f59e0b",
        order=2,
        unit="$",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.single,
        interval=ScanInterval.d1,
        fact_table_id=orders_fact.id,
        aggregation=MetricAggregation.sum,
        measure_column="amount",
        row_filters=["completed"],
    )
    aov_metric_create = FactMetricCreate(
        name="average_order_value",
        display_name="Average order value",
        description="Completed-order revenue divided by completed-order count.",
        color="#a855f7",
        order=3,
        unit="$",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.ratio,
        interval=ScanInterval.d1,
        numerator=FactOperand(
            fact_table_id=orders_fact.id,
            aggregation=MetricAggregation.sum,
            measure_column="amount",
        ),
        denominator=FactOperand(
            fact_table_id=orders_fact.id,
            aggregation=MetricAggregation.count,
        ),
    )

    metric_defs: dict[str, MetricDefinition] = {}
    for metric_create in (
        sql_metric_create,
        conversion_metric_create,
        revenue_metric_create,
        aov_metric_create,
    ):
        metric_def = MetricDefinition(project_id=project_id, **metric_create.to_create_values())
        metric_def.last_collected_at = now
        metric_def.last_collection_status = "success"
        session.add(metric_def)
        metric_defs[metric_create.name] = metric_def
    await session.flush()

    # 14c. MetricValue series so the catalog + drilldowns render with data.
    #
    # event_composition ratio → ~7 days HOURLY, aligned to the source scan grid
    # (scan_config_id set). Conversion drifts gently upward over the window with a
    # daily ripple so the ratio series reads as a live, dynamic line; deriving it
    # from purchases/screen-views with the same sinusoid base cancels out to a
    # near-flat constant. Stays a small fraction (~0.04-0.11).
    conversion_metric = metric_defs["purchase_conversion"]
    conversion_buckets = _hour_buckets(now, days=7)
    conversion_span = max(len(conversion_buckets) - 1, 1)
    for idx, bucket in enumerate(conversion_buckets):
        progress = idx / conversion_span
        daily_ripple = 0.015 * math.sin(bucket.hour * math.pi / 12)
        session.add(
            MetricValue(
                metric_definition_id=conversion_metric.id,
                scan_config_id=scan_config.id,
                bucket=bucket,
                value=0.05 + 0.045 * progress + daily_ripple,
            )
        )

    # sql + both fact metrics → ~30 DAILY buckets, collected from their own source
    # (scan_config_id NULL). Levels are plausible and deterministic: sessions in
    # the thousands, revenue in the tens of thousands, AOV in the 40-60 range.
    daily_buckets = [
        now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=k)
        for k in range(30)
    ]
    sql_metric = metric_defs["active_sessions"]
    revenue_metric = metric_defs["revenue_completed"]
    aov_metric = metric_defs["average_order_value"]
    for k, bucket in enumerate(daily_buckets):
        session.add(
            MetricValue(
                metric_definition_id=sql_metric.id,
                scan_config_id=None,
                bucket=bucket,
                value=float(_sinusoidal_count(4200, bucket, k + 3)),
            )
        )
        session.add(
            MetricValue(
                metric_definition_id=revenue_metric.id,
                scan_config_id=None,
                bucket=bucket,
                value=float(_sinusoidal_count(48000, bucket, k + 5)),
            )
        )
        session.add(
            MetricValue(
                metric_definition_id=aov_metric.id,
                scan_config_id=None,
                bucket=bucket,
                value=50.0 + 8.0 * math.sin(k * math.pi / 7.0),
            )
        )

    await session.flush()

    # 15. Reindex search for this branch. No commit here: the caller
    # (create_demo_project) owns the phase-2 transaction boundary.
    await reindex_project_branch(
        session,
        project_id=project_id,
        branch_id=branch_id,
        slug=slug,
        schedule_embeddings=False,
    )

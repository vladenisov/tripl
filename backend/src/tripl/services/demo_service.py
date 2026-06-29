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

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricStatus,
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
from tripl.schemas.project import ProjectCreate, ProjectResponse
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


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------


async def create_demo_project(session: AsyncSession) -> ProjectResponse:
    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)

    # Unique slug so repeated calls never collide.
    short_hex = uuid.uuid4().hex[:6]
    slug = f"demo-{short_hex}"

    # 1. Project + main branch
    project_response = await project_service.create_project(
        session,
        ProjectCreate(
            name="Demo Project",
            slug=slug,
            description=(
                "A pre-populated demo workspace. "
                "Explore events, metrics, signals, and distribution drift "
                "without connecting a warehouse."
            ),
        ),
    )
    project_id = project_response.id
    branch_id = await plan_branch_service.ensure_main_branch_id(session, project_id)

    # 2. DataSource (never actually queried)
    data_source = DataSource(
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
    # The "spike" event for the anomaly will be Home Screen View (events[0]).
    # We inject a ×3 spike in the last 24 h for that event.

    buckets = _hour_buckets(now, days=7)
    spike_event = events[0]  # Home Screen View, base=1800

    # Determine spike window: last 3 hours
    spike_start = now - timedelta(hours=3)

    # Collect type-level counts per bucket for the aggregate rows
    type_bucket_counts: dict[tuple[uuid.UUID, datetime], int] = {}

    for spec, ev in zip(event_specs, events, strict=True):
        base = spec["base"]
        noise_seed = hash(ev.id) % 997
        for idx, bucket in enumerate(buckets):
            count = _sinusoidal_count(base, bucket, noise_seed + idx)

            # Spike: inflate last-3h for Home Screen View
            if ev is spike_event and bucket >= spike_start:
                count = count * 3

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

    # 10. MetricAnomaly: spike for Home Screen View in the last 3 h
    #
    # Pick the most recent spike bucket as the representative anomaly bucket.
    if buckets:
        anomaly_bucket = buckets[-1]  # last full hour bucket
        spike_actual = _sinusoidal_count(1800, anomaly_bucket, 0) * 3
        # baseline expected: normal count at that hour
        expected = float(_sinusoidal_count(1800, anomaly_bucket, 0))
        stddev = expected * 0.12  # 12 % stddev is realistic
        z_score = round((spike_actual - expected) / max(stddev, 1), 2)

        # Event-scope anomaly
        session.add(
            MetricAnomaly(
                scan_config_id=scan_config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(spike_event.id),
                event_id=spike_event.id,
                event_type_id=None,
                bucket=anomaly_bucket,
                actual_count=spike_actual,
                expected_count=expected,
                stddev=stddev,
                z_score=z_score,
                direction="spike",
            )
        )

        # Project-total scope anomaly (scope_ref is the scan_config_id, per metrics_service)
        session.add(
            MetricAnomaly(
                scan_config_id=scan_config.id,
                scope_type=SCOPE_PROJECT_TOTAL,
                scope_ref=str(scan_config.id),
                event_id=None,
                event_type_id=None,
                bucket=anomaly_bucket,
                actual_count=spike_actual,
                expected_count=expected,
                stddev=stddev,
                z_score=z_score,
                direction="spike",
            )
        )

    await session.flush()

    # 11. EventMetricBreakdown: platform breakdown for Home Screen View,
    #     last 48 h, hourly.
    breakdown_buckets = _hour_buckets(now, days=2)
    platforms = [
        ("ios", 0.50, 1),
        ("android", 0.35, 2),
        ("web", 0.15, 3),
    ]
    base_sv = 1800
    noise_seed_sv = hash(spike_event.id) % 997

    for idx, bucket in enumerate(breakdown_buckets):
        total_count = _sinusoidal_count(base_sv, bucket, noise_seed_sv + idx)
        remaining = total_count
        for platform_idx, (platform, share, p_seed) in enumerate(platforms):
            if platform_idx < len(platforms) - 1:
                raw_count = round(total_count * share)
                # small noise on share
                noise = (p_seed * 17 + idx * 7) % 11 - 5
                count = max(1, raw_count + noise)
                remaining -= count
            else:
                count = max(1, remaining)

            session.add(
                EventMetricBreakdown(
                    scan_config_id=scan_config.id,
                    event_id=spike_event.id,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value=platform,
                    is_other=False,
                    count=count,
                )
            )

    await session.flush()

    # 12. DistributionDrift: rising PSI for 'platform' on screen_view, 6 daily buckets
    drift_psi_values = [
        (6, 0.04, "stable"),
        (5, 0.08, "stable"),
        (4, 0.12, "minor"),
        (3, 0.18, "minor"),
        (2, 0.26, "significant"),
        (1, 0.35, "significant"),
    ]
    for days_back, psi, band in drift_psi_values:
        drift_bucket = (now - timedelta(days=days_back)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        session.add(
            DistributionDrift(
                scan_config_id=scan_config.id,
                event_type_id=et_screen_view.id,
                field_name="platform",
                bucket=drift_bucket,
                psi=psi,
                band=band,
                baseline_total=50000,
                current_total=48500,
                top_movers=[
                    {
                        "value": "web",
                        "baseline_share": 0.12,
                        "current_share": 0.12 + psi * 0.5,
                        "contribution": round(psi * 0.6, 4),
                    },
                    {
                        "value": "ios",
                        "baseline_share": 0.53,
                        "current_share": max(0.01, 0.53 - psi * 0.3),
                        "contribution": round(psi * 0.3, 4),
                    },
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
        row_filter="completed",
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
    # (scan_config_id set). The value is a plausible fractional conversion derived
    # deterministically from the two event bases (purchases / screen views).
    conversion_metric = metric_defs["purchase_conversion"]
    for idx, bucket in enumerate(_hour_buckets(now, days=7)):
        purchases = _sinusoidal_count(120, bucket, idx + 11)
        screen_views = _sinusoidal_count(1800, bucket, idx + 1)
        session.add(
            MetricValue(
                metric_definition_id=conversion_metric.id,
                scan_config_id=scan_config.id,
                bucket=bucket,
                value=purchases / screen_views,
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

    # 15. Reindex search for this branch
    await reindex_project_branch(
        session,
        project_id=project_id,
        branch_id=branch_id,
        slug=slug,
        schedule_embeddings=False,
    )

    await session.commit()

    # Return a fresh ProjectResponse
    return await project_service.get_project(session, slug)

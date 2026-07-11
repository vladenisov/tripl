"""Governance builder: scan history, coverage, and reconciliation outputs.

Seeds the observable governance surface that a real scan/metrics pipeline would
leave behind, coherent with the warehouse volume seeded by the warehouse builder:

- ``ScanJob`` history — a run cadence of completed jobs with realistic
  ``result_summary`` and timing, plus one older, safely-explained transient
  failure. The latest job is successful, so the project summary reads healthy.
- ``CoverageMetric`` — per-bucket plan coverage of scanned volume. ``matched``
  is the volume attributed to plan events (the seeded per-type series); ``total``
  adds a small unmatched tail, so coverage reconciles with scanned volume and
  the unmatched share equals what the shadow candidates represent.
- ``ShadowEventCandidate`` — warehouse identities with no matching plan event.
  Names are deliberately OUTSIDE the authored plan so accepting one never
  collides with an existing source identity.
- One age-valid dead-event example (a plan event whose warehouse volume dried up
  long enough ago to surface in the dead-events review).

All rows are synthetic and deterministic for a given ``(clock, seed)``. No real
scan runs here — this is the "faithfully orchestrated" initial history; the live
Run now / Preview / Replay / scheduled paths run the real pipeline over the
synthetic source on demand.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.coverage_metric import CoverageMetric
from tripl.models.event import Event
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.shadow_event_candidate import (
    SHADOW_STATUS_DISMISSED,
    SHADOW_STATUS_NEW,
    ShadowEventCandidate,
)
from tripl.services.demo.scenario import DemoContext

# Coverage rate: plan events account for ~94% of scanned volume; the ~6% tail is
# unmatched (the shadow candidates below).
_COVERAGE_MATCH_RATE = 0.94
# Only the recent slice gets coverage rows (the reconciliation view is windowed);
# keeps the seed bounded while still reconciling with the volume chart.
_COVERAGE_DAYS = 14
# The dead-event example: this authored event's warehouse volume dried up this
# many days ago — old enough to surface in the dead-events review.
_DEAD_EVENT_NAME = "Subscription Cancelled"
_DEAD_EVENT_AGE_DAYS = 45


async def build_governance(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_scan_history(session, ctx)
    await _build_coverage(session, ctx)
    await _build_shadow_candidates(session, ctx)
    await _build_dead_event(session, ctx)


async def _build_scan_history(session: AsyncSession, ctx: DemoContext) -> None:
    """A realistic run cadence: older completed runs, one transient failure that
    recovered, and a fresh successful run (the latest job)."""
    window_from = ctx.now - timedelta(hours=1)
    scanned_rows = sum(ctx.type_bucket_counts.values())
    matched_events = len(ctx.event_ids)

    def _summary(rows: int) -> dict[str, object]:
        return {
            "events_created": 0,
            "events_skipped": 0,
            "events_grouped": len(ctx.event_type_ids),
            "events_merged": matched_events,
            "variables_created": 0,
            "columns_analyzed": 10,
            "scan_rows_processed": rows,
            "scan_truncated": False,
            "scan_window_from": window_from.isoformat(),
            "scan_window_to": ctx.now.isoformat(),
            "details": [],
        }

    # Completed runs at the scan interval, newest last so the latest job is fresh.
    # ``created_at`` is set explicitly to the run time: the "latest job" rollups
    # rank by created_at, so without this every job would share the one
    # provisioning timestamp and the failed run could win the tiebreak.
    completed_offsets = (timedelta(hours=3), timedelta(hours=2), timedelta(hours=1))
    for offset in completed_offsets:
        started = ctx.now - offset
        session.add(
            ScanJob(
                scan_config_id=ctx.scan_config_id,
                status=ScanJobStatus.completed.value,
                started_at=started,
                completed_at=started + timedelta(seconds=42),
                result_summary=_summary(scanned_rows),
                created_at=started,
            )
        )

    # One older transient failure that later recovered — safe, non-leaky message.
    # Its old created_at keeps it behind the recent completed runs in the ranking,
    # so the config's LATEST job is the successful one and the project reads healthy.
    failed_started = ctx.now - timedelta(days=2, hours=4)
    session.add(
        ScanJob(
            scan_config_id=ctx.scan_config_id,
            status=ScanJobStatus.failed.value,
            started_at=failed_started,
            completed_at=failed_started + timedelta(seconds=61),
            error_message="Synthetic warehouse read timed out; the next scheduled run recovered.",
            created_at=failed_started,
        )
    )
    await session.flush()


async def _build_coverage(session: AsyncSession, ctx: DemoContext) -> None:
    """Per-bucket coverage that reconciles with the seeded per-type volume."""
    cutoff = ctx.now - timedelta(days=_COVERAGE_DAYS)
    # Aggregate the per-type series to a per-bucket matched total.
    matched_by_bucket: dict[datetime, int] = {}
    for (_et_id, bucket), count in ctx.type_bucket_counts.items():
        if bucket < cutoff:
            continue
        matched_by_bucket[bucket] = matched_by_bucket.get(bucket, 0) + count

    for bucket, matched in matched_by_bucket.items():
        total = max(matched, round(matched / _COVERAGE_MATCH_RATE))
        session.add(
            CoverageMetric(
                scan_config_id=ctx.scan_config_id,
                bucket=bucket,
                total_count=total,
                matched_count=matched,
            )
        )
    await session.flush()


async def _build_shadow_candidates(session: AsyncSession, ctx: DemoContext) -> None:
    """Warehouse identities with no plan event. Names are OUTSIDE the authored
    plan so accepting one cannot collide with an existing source identity."""
    screen_view_type_id = ctx.event_type_ids.get("screen_view")
    recent = ctx.now - timedelta(hours=2)
    week_ago = ctx.now - timedelta(days=7)

    session.add(
        ShadowEventCandidate(
            project_id=ctx.project_id,
            scan_config_id=ctx.scan_config_id,
            event_type_id=screen_view_type_id,
            event_name="app_heartbeat_v1",
            observed_count=1840,
            first_seen_at=week_ago,
            last_seen_at=recent,
            status=SHADOW_STATUS_NEW,
        )
    )
    session.add(
        ShadowEventCandidate(
            project_id=ctx.project_id,
            scan_config_id=ctx.scan_config_id,
            event_type_id=None,
            event_name="legacy_deeplink_open",
            observed_count=420,
            first_seen_at=week_ago,
            last_seen_at=week_ago + timedelta(days=1),
            status=SHADOW_STATUS_DISMISSED,
        )
    )
    await session.flush()


async def _build_dead_event(session: AsyncSession, ctx: DemoContext) -> None:
    """Age out one authored event's warehouse volume so it surfaces as dead."""
    event_id = ctx.event_ids.get(_DEAD_EVENT_NAME)
    if event_id is None:
        return
    event = await session.get(Event, event_id)
    if event is not None:
        event.last_seen_at = ctx.now - timedelta(days=_DEAD_EVENT_AGE_DAYS)
    await session.flush()

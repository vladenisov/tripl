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
from tripl.services.demo import noise
from tripl.services.demo.builders.warehouse import SCAN_COLUMNS
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
# The dead-events query applies a grace period — an event created inside the
# review window legitimately has no data yet — so it also requires
# ``created_at < cutoff``. Every other demo event is staggered across the ~3-week
# history, which is INSIDE the 30-day window, so the deliberately-planted dead
# example was silently unflaggable and Coverage always claimed zero gaps
# (tripl-jfm3.58). Backdating its authoring instant well ahead of its last
# sighting also makes the row self-consistent: an event cannot be seen before it
# was written down.
_DEAD_EVENT_FIRST_SEEN_LEAD_DAYS = 30

# How long ago each backfilled completed run started (one per scan interval).
_COMPLETED_RUN_OFFSETS = (timedelta(hours=3), timedelta(hours=2), timedelta(hours=1))
# Backfilled run duration: a floor plus time proportional to the rows scanned,
# with a small deterministic jitter, so three consecutive runs do not all report
# an identical wall time (bd tripl-jfm3.61).
_RUN_DURATION_FLOOR = timedelta(seconds=2.4)
_RUN_SECONDS_PER_1K_ROWS = 0.09
_RUN_JITTER_SECONDS = 2.5


def _run_duration(ctx: DemoContext, started: datetime, rows: int) -> timedelta:
    """Deterministic per-run wall time in the same band a real Run now lands in."""
    jitter = (noise.derive_seed(ctx.seed, f"scan_run:{started.isoformat()}") % 1000) / 1000.0
    seconds = (
        _RUN_DURATION_FLOOR.total_seconds()
        + rows / 1000.0 * _RUN_SECONDS_PER_1K_ROWS
        + jitter * _RUN_JITTER_SECONDS
    )
    return timedelta(seconds=round(seconds, 1))


async def build_governance(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_scan_history(session, ctx)
    await _build_coverage(session, ctx)
    await _build_shadow_candidates(session, ctx)
    await _build_dead_event(session, ctx)


def _hourly_scanned_rows(ctx: DemoContext, window_from: datetime) -> int:
    """Rows the seeded warehouse actually holds for one hourly scan window.

    The per-type series IS the seeded volume, so summing the window's buckets
    makes a backfilled run report the same order of magnitude a real Run now
    reports against the same synthetic table.
    """
    bucket = window_from.replace(minute=0, second=0, microsecond=0)
    return sum(
        count for (_et_id, stored), count in ctx.type_bucket_counts.items() if stored == bucket
    )


async def _build_scan_history(session: AsyncSession, ctx: DemoContext) -> None:
    """A realistic run cadence: older completed runs, one transient failure that
    recovered, and a fresh successful run (the latest job)."""
    matched_events = len(ctx.event_ids)

    def _summary(window_from: datetime, window_to: datetime, rows: int) -> dict[str, object]:
        return {
            "events_created": 0,
            "events_skipped": 0,
            "events_grouped": len(ctx.event_type_ids),
            "events_merged": matched_events,
            "variables_created": 0,
            "columns_analyzed": len(SCAN_COLUMNS),
            "scan_rows_processed": rows,
            "scan_truncated": False,
            "scan_window_from": window_from.isoformat(),
            "scan_window_to": window_to.isoformat(),
            "details": [],
        }

    # Completed runs at the scan interval, newest last so the latest job is fresh.
    # ``created_at`` is set explicitly to the run time: the "latest job" rollups
    # rank by created_at, so without this every job would share the one
    # provisioning timestamp and the failed run could win the tiebreak.
    #
    # Each run reports ITS OWN hour: window, row count and duration are all
    # derived from the run's own clock and the volume the seeded warehouse holds
    # for that hour (bd tripl-jfm3.61). They used to be constants, so three
    # consecutive runs claimed the same future window, byte-identical millions of
    # rows and an identical 42.0s — next to a real Run now reporting ~30K rows.
    for offset in _COMPLETED_RUN_OFFSETS:
        started = ctx.now - offset
        window_to = started.replace(minute=0, second=0, microsecond=0)
        window_from = window_to - timedelta(hours=1)
        rows = _hourly_scanned_rows(ctx, window_from)
        session.add(
            ScanJob(
                scan_config_id=ctx.scan_config_id,
                status=ScanJobStatus.completed.value,
                started_at=started,
                completed_at=started + _run_duration(ctx, started, rows),
                result_summary=_summary(window_from, window_to, rows),
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
    click_type_id = ctx.event_type_ids.get("click")
    recent = ctx.now - timedelta(hours=2)
    week_ago = ctx.now - timedelta(days=7)

    session.add(
        ShadowEventCandidate(
            project_id=ctx.project_id,
            scan_config_id=ctx.scan_config_id,
            # Keep the coached one-click Accept path valid: unlike screen_view,
            # the click type has no required field whose value the warehouse
            # candidate cannot supply.
            event_type_id=click_type_id,
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
        last_seen = ctx.now - timedelta(days=_DEAD_EVENT_AGE_DAYS)
        event.last_seen_at = last_seen
        event.created_at = last_seen - timedelta(days=_DEAD_EVENT_FIRST_SEEN_LEAD_DAYS)
    await session.flush()

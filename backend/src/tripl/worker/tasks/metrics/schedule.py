"""Scheduling task for metrics collection.

``check_metrics_due`` scans all configured scan configs and dispatches
``collect_metrics`` for every config with a newly completed interval bucket.
The Celery task name is kept identical via the explicit ``name=`` string.

Tests monkey-patch the session/helper globals of THIS module.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import func as sa_func
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tripl.core.intervals import get_interval
from tripl.models.domain_enums import MetricKind, MetricStatus
from tripl.models.event_metric import EventMetric
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks.metrics._helpers import (
    STALE_ACTIVE_SCAN_JOB_TIMEOUT,
    _fail_stale_active_scan_job,
    _floor_to_interval,
    _get_active_scan_jobs,
    _get_sync_session,
    _normalize_job_timestamp,
)
from tripl.worker.tasks.metrics.metric_collect import (
    COLLECTION_STATUS_ERROR,
    COLLECTION_STATUS_RUNNING,
    collect_fact_metrics_batch,
    collect_metric_definitions,
)
from tripl.worker.tasks.metrics.tasks import collect_metrics

logger = logging.getLogger(__name__)

# A single Postgres session-level advisory lock serialises the whole dispatcher
# across worker processes. With concurrency=N, a backlog of redelivered
# ``check_metrics_due`` messages (e.g. accumulated while the worker was busy or
# after a restart) used to be drained in parallel; the per-config "one active
# job" guard is not atomic, so overlapping runs each created a job for the same
# config in the same instant — duplicate pending/running rows plus duplicate-key
# crashes downstream in anomaly writes. Holding this lock for the duration of a
# run makes any overlapping run a no-op instead. No-op on non-Postgres backends
# (e.g. SQLite in tests).
_DISPATCH_ADVISORY_LOCK_KEY = 4_021_968_017

# A SECOND, distinct advisory lock for the catalog-metric dispatcher so it
# serialises across workers WITHOUT contending with ``check_metrics_due``. Using
# a separate key means catalog-metric dispatch never starves (nor is starved by)
# event-metric collection — the two dispatchers run independently.
_METRIC_DEFINITION_DISPATCH_ADVISORY_LOCK_KEY = 4_021_968_018


@celery_app.task(name="tripl.worker.tasks.metrics.check_metrics_due")  # type: ignore[untyped-decorator]
def check_metrics_due() -> dict[str, int]:
    """Check which scan configs are due for metrics collection and dispatch tasks."""
    session = _get_sync_session()
    lock_conn = None
    try:
        bind = session.bind
        if bind is not None and bind.dialect.name == "postgresql":
            engine = bind if isinstance(bind, Engine) else bind.engine
            lock_conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
            acquired = bool(
                lock_conn.execute(
                    text("SELECT pg_try_advisory_lock(:key)"),
                    {"key": _DISPATCH_ADVISORY_LOCK_KEY},
                ).scalar()
            )
            if not acquired:
                logger.info(
                    "check_metrics_due: another dispatch run holds the advisory "
                    "lock; skipping this tick"
                )
                lock_conn.close()
                lock_conn = None
                return {"checked": 0, "dispatched": 0}

        configs = (
            session.execute(
                select(ScanConfig).where(
                    ScanConfig.interval.isnot(None),
                    ScanConfig.time_column.isnot(None),
                )
            )
            .scalars()
            .all()
        )

        dispatched = 0
        for config in configs:
            now = datetime.now(UTC)
            # Examine EVERY active job, not just the newest: reap all stale ones
            # so a stuck old job can't be permanently shadowed by a fresher
            # pending row, and skip dispatch only when a genuinely live
            # (non-stale) job remains.
            has_live_job = False
            for active_job in _get_active_scan_jobs(session, config.id):
                if not _fail_stale_active_scan_job(
                    session,
                    active_job,
                    now=now,
                    scan_name=config.name,
                ):
                    has_live_job = True
            if has_live_job:
                logger.info(
                    f"Skipping collect_metrics for {config.name!r}: "
                    "an active job is still in progress"
                )
                continue

            assert config.interval is not None
            interval_spec = get_interval(config.interval)
            delta = interval_spec.delta

            # Check last metric bucket for this config
            last_bucket = session.execute(
                select(sa_func.max(EventMetric.bucket)).where(
                    EventMetric.scan_config_id == config.id,
                )
            ).scalar()

            should_run = False

            if last_bucket is None:
                # Never collected — run now
                should_run = True
            else:
                # Only dispatch when a new complete bucket is available.
                # The latest complete bucket is floor(now) - delta.
                latest_complete = _floor_to_interval(now, delta) - delta
                if last_bucket < latest_complete:
                    should_run = True

            if should_run:
                job = ScanJob(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    status=ScanJobStatus.pending.value,
                )
                session.add(job)
                session.commit()

                logger.info(
                    f"Dispatching collect_metrics for {config.name!r} (interval={config.interval})"
                )
                try:
                    collect_metrics.delay(str(config.id), str(job.id))
                except Exception as exc:
                    job.status = ScanJobStatus.failed.value
                    job.completed_at = datetime.now(UTC)
                    job.error_message = f"Failed to dispatch collect_metrics: {exc}"
                    session.commit()
                    raise
                dispatched += 1

        logger.info(f"check_metrics_due: {len(configs)} configs checked, {dispatched} dispatched")
        return {"checked": len(configs), "dispatched": dispatched}

    except Exception:
        logger.exception("check_metrics_due failed")
        raise
    finally:
        if lock_conn is not None:
            try:
                lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:key)"),
                    {"key": _DISPATCH_ADVISORY_LOCK_KEY},
                )
            except Exception:  # pragma: no cover - best-effort lock release
                logger.exception("Failed to release check_metrics_due advisory lock")
            finally:
                lock_conn.close()
        session.close()


def _try_acquire_advisory_lock(session: object, key: int) -> tuple[object | None, bool]:
    """Try to grab a Postgres session advisory lock; no-op (acquired) elsewhere.

    Returns ``(lock_conn, acquired)``. On non-Postgres backends (SQLite tests)
    there is no lock, so it always reports acquired with ``lock_conn=None``.
    """
    bind = getattr(session, "bind", None)
    if bind is None or bind.dialect.name != "postgresql":
        return None, True
    engine = bind if isinstance(bind, Engine) else bind.engine
    lock_conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
    acquired = bool(
        lock_conn.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": key}).scalar()
    )
    if not acquired:
        lock_conn.close()
        return None, False
    return lock_conn, True


def _release_advisory_lock(lock_conn: object | None, key: int) -> None:
    """Best-effort release of an advisory lock acquired above."""
    if lock_conn is None:
        return
    try:
        lock_conn.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": key})  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - best-effort lock release
        logger.exception("Failed to release metric-definition dispatch advisory lock")
    finally:
        lock_conn.close()  # type: ignore[attr-defined]


def _metric_collection_in_progress(definition: MetricDefinition, *, now: datetime) -> bool:
    """Whether a non-stale collection is already running for this metric.

    The single ``last_collection_status`` column doubles as the one-active-job
    guard (there is no separate job table for catalog metrics). A ``running``
    marker older than the staleness window is treated as dead, so a crashed run
    can be re-dispatched instead of wedging the metric forever.
    """
    if definition.last_collection_status != COLLECTION_STATUS_RUNNING:
        return False
    activity_at = _normalize_job_timestamp(definition.updated_at)
    return now - activity_at < STALE_ACTIVE_SCAN_JOB_TIMEOUT


def _max_event_metric_bucket(
    session: Session,
    *,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
) -> datetime | None:
    if event_id is not None:
        condition = EventMetric.event_id == event_id
    elif event_type_id is not None:
        condition = EventMetric.event_type_id == event_type_id
    else:
        return None
    return session.execute(select(sa_func.max(EventMetric.bucket)).where(condition)).scalar()


def _event_composition_due(session: Session, definition: MetricDefinition) -> bool:
    """An event_composition metric is due when its source has newer buckets.

    It has no interval of its own; it re-derives from already-collected
    event_metrics, so "due" means the newest numerator event-metric bucket is
    ahead of the newest value we have composed.
    """
    source_max = _max_event_metric_bucket(
        session,
        event_id=definition.numerator_event_id,
        event_type_id=definition.numerator_event_type_id,
    )
    if source_max is None:
        return False
    composed_max = session.execute(
        select(sa_func.max(MetricValue.bucket)).where(
            MetricValue.metric_definition_id == definition.id
        )
    ).scalar()
    return composed_max is None or composed_max < source_max


def _metric_definition_due(
    session: Session, definition: MetricDefinition, *, now: datetime
) -> bool:
    """Whether a metric has a newly complete bucket (or source data) to collect."""
    kind = (
        definition.kind if isinstance(definition.kind, MetricKind) else MetricKind(definition.kind)
    )
    if kind is MetricKind.event_composition:
        return _event_composition_due(session, definition)
    # ``sql`` carries its own ``data_source_id``; ``fact`` takes its data source
    # from the referenced FactTable (so ``data_source_id`` is NULL). Both gate on
    # the metric's own collection ``interval``.
    if definition.interval is None:
        return False
    delta = get_interval(definition.interval).delta
    last_bucket = session.execute(
        select(sa_func.max(MetricValue.bucket)).where(
            MetricValue.metric_definition_id == definition.id,
            MetricValue.scan_config_id.is_(None),
        )
    ).scalar()
    if last_bucket is None:
        return True
    latest_complete = _floor_to_interval(now, delta) - delta
    return last_bucket < latest_complete


@celery_app.task(name="tripl.worker.tasks.metrics.check_metric_definitions_due")  # type: ignore[untyped-decorator]
def check_metric_definitions_due() -> dict[str, int]:
    """Dispatch ``collect_metric_definitions`` for every active metric that is due.

    Mirrors ``check_metrics_due``: a single advisory lock (distinct key)
    serialises the dispatcher across workers, and the per-metric
    ``last_collection_status`` marker prevents double-dispatching a metric whose
    collection is already running (stale ``running`` markers are reclaimed).
    """
    session = _get_sync_session()
    lock_conn = None
    try:
        lock_conn, acquired = _try_acquire_advisory_lock(
            session, _METRIC_DEFINITION_DISPATCH_ADVISORY_LOCK_KEY
        )
        if not acquired:
            logger.info(
                "check_metric_definitions_due: another dispatch run holds the "
                "advisory lock; skipping this tick"
            )
            return {"checked": 0, "dispatched": 0}

        definitions = (
            session.execute(
                select(MetricDefinition).where(MetricDefinition.status == MetricStatus.active)
            )
            .scalars()
            .all()
        )

        now = datetime.now(UTC)
        dispatched = 0
        # Fact metrics are collected in shared warehouse scans, so they are
        # grouped by interval (one bucket grid per group) and dispatched as a
        # single batch task per group. ``sql`` / ``event_composition`` metrics
        # have no shared scan to exploit and stay per-metric.
        fact_groups: dict[str, list[MetricDefinition]] = {}
        for definition in definitions:
            if _metric_collection_in_progress(definition, now=now):
                logger.info(
                    "Skipping collect_metric_definitions for %r: collection already running",
                    definition.name,
                )
                continue
            if not _metric_definition_due(session, definition, now=now):
                continue

            kind = (
                definition.kind
                if isinstance(definition.kind, MetricKind)
                else MetricKind(definition.kind)
            )
            if kind is MetricKind.fact and definition.interval is not None:
                fact_groups.setdefault(str(definition.interval), []).append(definition)
                continue

            # Mark running before dispatch (the one-active guard, analogous to
            # check_metrics_due creating a pending ScanJob first).
            definition.last_collection_status = COLLECTION_STATUS_RUNNING
            session.commit()

            logger.info(
                "Dispatching collect_metric_definitions for %r (kind=%s)",
                definition.name,
                definition.kind,
            )
            try:
                collect_metric_definitions.delay(str(definition.id))
            except Exception as exc:
                definition.last_collection_status = COLLECTION_STATUS_ERROR
                definition.last_collection_error = (
                    f"Failed to dispatch collect_metric_definitions: {exc}"
                )
                session.commit()
                raise
            dispatched += 1

        for interval_code, group in fact_groups.items():
            # Mark ALL members running before dispatch so the one-active guard
            # holds for the whole batch (mirrors the per-metric path above).
            for definition in group:
                definition.last_collection_status = COLLECTION_STATUS_RUNNING
            session.commit()

            metric_ids = [str(definition.id) for definition in group]
            logger.info(
                "Dispatching collect_fact_metrics_batch for %s fact metrics (interval=%s)",
                len(group),
                interval_code,
            )
            try:
                collect_fact_metrics_batch.delay(metric_ids)
            except Exception as exc:
                for definition in group:
                    definition.last_collection_status = COLLECTION_STATUS_ERROR
                    definition.last_collection_error = (
                        f"Failed to dispatch collect_fact_metrics_batch: {exc}"
                    )
                session.commit()
                raise
            dispatched += len(group)

        logger.info(
            "check_metric_definitions_due: %s metrics checked, %s dispatched",
            len(definitions),
            dispatched,
        )
        return {"checked": len(definitions), "dispatched": dispatched}

    except Exception:
        logger.exception("check_metric_definitions_due failed")
        raise
    finally:
        _release_advisory_lock(lock_conn, _METRIC_DEFINITION_DISPATCH_ADVISORY_LOCK_KEY)
        session.close()

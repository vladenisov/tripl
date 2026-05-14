"""Celery tasks for collecting time-bucketed event metrics from ClickHouse.

Uses the same cardinality analysis + event generation pipeline as the manual
scan task (analyze_cardinality / generate_events), then collects time-bucketed
counts and matches them to the generated events.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import delete, select
from sqlalchemy import func as sa_func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl import cache
from tripl.config import settings
from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
    group_json_value_paths,
)
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.adapters.base import BaseAdapter, ColumnInfo
from tripl.worker.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
    AnomalyDetectionSettings,
    DetectedAnomaly,
    SeriesPoint,
    detect_anomalies,
)
from tripl.worker.analyzers.cardinality import (
    _is_json_type,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.worker.analyzers.event_generator import (
    GenerationResult,
    _apply_name_format,
    _format_value,
    generate_events,
)
from tripl.worker.celery_app import celery_app
from tripl.worker.db import SyncSessionLocal
from tripl.worker.tasks.alerts import send_alert_delivery
from tripl.worker.utils.intervals import get_interval

logger = logging.getLogger(__name__)
ACTIVE_SCAN_JOB_STATUSES = (
    ScanJobStatus.pending.value,
    ScanJobStatus.running.value,
)
STALE_ACTIVE_SCAN_JOB_TIMEOUT = timedelta(minutes=30)
RECENT_SIGNAL_WINDOW = timedelta(hours=24)
MAX_BREAKDOWN_VALUE_LENGTH = 500


def _get_sync_session() -> Session:
    return SyncSessionLocal()


def _build_adapter(ds: DataSource) -> BaseAdapter:
    from tripl.crypto import decrypt_value
    from tripl.worker.adapters.clickhouse import ClickHouseAdapter

    password = decrypt_value(ds.password_encrypted)
    if ds.db_type == "clickhouse":
        return ClickHouseAdapter(
            host=ds.host,
            port=ds.port,
            database=ds.database_name,
            username=ds.username,
            password=password,
        )
    msg = f"Unsupported db_type: {ds.db_type}"
    raise ValueError(msg)


def _floor_to_interval(dt: datetime, delta: timedelta) -> datetime:
    """Floor a datetime to the nearest interval boundary."""
    epoch = datetime(2000, 1, 1, tzinfo=UTC)
    if dt.tzinfo is None:
        epoch = epoch.replace(tzinfo=None)
    total_seconds = delta.total_seconds()
    elapsed = (dt - epoch).total_seconds()
    floored = int(elapsed // total_seconds) * total_seconds
    return epoch + timedelta(seconds=floored)


def _ceil_to_interval(dt: datetime, delta: timedelta) -> datetime:
    floored = _floor_to_interval(dt, delta)
    if floored == dt:
        return floored
    return floored + delta


def _parse_task_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _resolve_collection_window(
    session: Session,
    *,
    config: ScanConfig,
    delta: timedelta,
    manual_time_from: str | None,
    manual_time_to: str | None,
) -> tuple[datetime, datetime, bool]:
    if (manual_time_from is None) != (manual_time_to is None):
        msg = "Both time_from and time_to are required for metrics replay"
        raise ValueError(msg)

    now = datetime.now(UTC)
    time_to = _floor_to_interval(now, delta)
    if manual_time_from is not None and manual_time_to is not None:
        requested_from = _parse_task_datetime(manual_time_from)
        requested_to = _parse_task_datetime(manual_time_to)
        if requested_from >= requested_to:
            msg = "time_from must be earlier than time_to"
            raise ValueError(msg)

        effective_from = _floor_to_interval(requested_from, delta)
        effective_to = _ceil_to_interval(requested_to, delta)
        latest_complete_boundary = _floor_to_interval(now, delta)
        if effective_to > latest_complete_boundary:
            msg = "time_to must not include the current incomplete interval"
            raise ValueError(msg)
        if effective_from >= effective_to:
            msg = "Replay window does not include a complete interval"
            raise ValueError(msg)
        return effective_from, effective_to, True

    last_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == config.id,
        )
    ).scalar()
    time_from = last_bucket - delta if last_bucket is not None else time_to - delta * 30
    return time_from, time_to, False


def _get_active_scan_job(session: Session, scan_config_id: uuid.UUID) -> ScanJob | None:
    """Return the newest pending/running job for a scan config, if any."""
    return session.execute(
        select(ScanJob)
        .where(
            ScanJob.scan_config_id == scan_config_id,
            ScanJob.status.in_(ACTIVE_SCAN_JOB_STATUSES),
        )
        .order_by(ScanJob.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _normalize_job_timestamp(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _get_scan_job_activity_at(job: ScanJob) -> datetime:
    activity_at = job.started_at or job.updated_at or job.created_at
    return _normalize_job_timestamp(activity_at)


def _fail_stale_active_scan_job(
    session: Session,
    job: ScanJob,
    *,
    now: datetime,
    scan_name: str,
) -> bool:
    activity_at = _get_scan_job_activity_at(job)
    if now - activity_at < STALE_ACTIVE_SCAN_JOB_TIMEOUT:
        return False

    logger.warning(
        "Marking stale active job %s for %r as failed; status=%s, last_activity=%s",
        job.id,
        scan_name,
        job.status,
        activity_at.isoformat(),
    )
    job.status = ScanJobStatus.failed.value
    job.completed_at = now
    job.error_message = (
        "Marked failed by scheduler after "
        f"{int(STALE_ACTIVE_SCAN_JOB_TIMEOUT.total_seconds() // 60)} minutes without progress"
    )
    session.commit()
    return True


def _ensure_event_type_with_fields(
    session: Session,
    project_id: uuid.UUID,
    et_name: str,
    columns: list[ColumnInfo],
    skip_columns: set[str],
) -> EventType:
    """Find or auto-create an EventType with FieldDefinitions for all columns."""
    et = session.execute(
        select(EventType).where(
            EventType.project_id == project_id,
            EventType.name == et_name,
        )
    ).scalar_one_or_none()

    if et is None:
        et = EventType(
            id=uuid.uuid4(),
            project_id=project_id,
            name=et_name,
            display_name=et_name,
            description="Auto-created from metrics collection",
        )
        session.add(et)
        session.flush()
        logger.info(f"Auto-created event type {et_name!r}")

    existing_fds = {fd.name for fd in et.field_definitions}
    for col in columns:
        if col.name in skip_columns:
            continue
        if col.name in existing_fds:
            continue
        fd = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=et.id,
            name=col.name,
            display_name=col.name,
            field_type="json" if _is_json_type(col.type_name) else "string",
            is_required=False,
            description=f"Auto-created ({col.type_name})",
        )
        session.add(fd)

    session.flush()
    session.refresh(et)
    return et


def _build_event_name_from_row(
    data_row: Sequence[object],
    col_meta: dict[str, dict[str, object]],
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    json_value_names: list[str],
    event_name_format: str | None,
) -> str | None:
    """Build event name from a CH row using col_meta (same logic as generate_events)."""
    kwargs: dict[str, str] = {}
    json_value_index = {
        name: n_reg + len(json_index) + idx for idx, name in enumerate(json_value_names)
    }

    for col_name, meta in col_meta.items():
        if meta.get("is_json"):
            j = json_index.get(col_name)
            if j is None:
                continue
            paths = data_row[n_reg + j]
            if paths:
                if isinstance(paths, (list, tuple)):
                    sorted_paths = sorted(str(p) for p in paths)
                else:
                    sorted_paths = [str(paths)]
                passthrough_paths = meta.get("json_passthrough_paths", [])
                if not isinstance(passthrough_paths, list):
                    passthrough_paths = []
                preserved_values = {
                    full_path: decode_json_path_value(data_row[json_value_index[full_path]])
                    for full_path in passthrough_paths
                    if full_path in json_value_index and full_path.startswith(f"{col_name}.")
                }
                value = build_json_value(
                    col_name,
                    sorted_paths,
                    preserved_values=preserved_values,
                )
            else:
                value = "{}"
        elif meta.get("is_low"):
            i = reg_index.get(col_name)
            if i is None:
                continue
            value = _format_value(data_row[i])
        else:
            # High-cardinality: use template
            template = meta.get("template")
            if not isinstance(template, str):
                continue
            value = template

        kwargs[col_name] = value
        if meta.get("is_json") and paths:
            for path in sorted_paths:
                full_path = f"{col_name}.{path}"
                if full_path in json_value_index:
                    kwargs[full_path] = format_json_path_value(
                        data_row[json_value_index[full_path]]
                    )
                else:
                    kwargs[full_path] = f"${{{full_path}}}"

    if not kwargs:
        return None

    if event_name_format:
        return _apply_name_format(event_name_format, kwargs)

    parts = []
    for k, v in kwargs.items():
        display = v if len(v) <= 80 else v[:77] + "..."
        parts.append(f"{k}={display}")
    return " | ".join(parts)


def _normalize_breakdown_value(value: object) -> str:
    formatted = _format_value(value)
    if len(formatted) <= MAX_BREAKDOWN_VALUE_LENGTH:
        return formatted
    return formatted[:MAX_BREAKDOWN_VALUE_LENGTH]


def _is_supported_metric_breakdown_column(
    config: ScanConfig,
    *,
    column: str,
    regular_cols: list[str],
) -> bool:
    return (
        column in regular_cols
        and column != config.event_type_column
        and column != config.time_column
    )


def _build_anomaly_settings(
    settings: ProjectAnomalySettings,
) -> AnomalyDetectionSettings:
    return AnomalyDetectionSettings(
        baseline_window_buckets=settings.baseline_window_buckets,
        min_history_buckets=settings.min_history_buckets,
        sigma_threshold=settings.sigma_threshold,
        min_expected_count=settings.min_expected_count,
    )


def _get_scan_json_value_path_map(config: ScanConfig) -> dict[str, list[str]]:
    return group_json_value_paths(config.json_value_paths)


def _get_project_anomaly_settings(
    session: Session,
    project_id: uuid.UUID,
) -> ProjectAnomalySettings | None:
    return session.execute(
        select(ProjectAnomalySettings).where(ProjectAnomalySettings.project_id == project_id)
    ).scalar_one_or_none()


def _load_scope_points(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    history_from: datetime,
    time_to: datetime,
) -> list[SeriesPoint]:
    if scope_type == SCOPE_PROJECT_TOTAL:
        rows = session.execute(
            select(EventMetric.bucket, sa_func.sum(EventMetric.count))
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
                EventMetric.bucket >= history_from,
                EventMetric.bucket < time_to,
            )
            .group_by(EventMetric.bucket)
            .order_by(EventMetric.bucket)
        ).all()
        return [SeriesPoint(bucket=bucket, count=int(count)) for bucket, count in rows]

    if scope_type == SCOPE_EVENT_TYPE:
        event_type_id = uuid.UUID(scope_ref)
        rows = session.execute(
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id == event_type_id,
                EventMetric.bucket >= history_from,
                EventMetric.bucket < time_to,
            )
            .order_by(EventMetric.bucket)
        ).all()
        return [SeriesPoint(bucket=bucket, count=count) for bucket, count in rows]

    event_id = uuid.UUID(scope_ref)
    rows = session.execute(
        select(EventMetric.bucket, EventMetric.count)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id == event_id,
            EventMetric.bucket >= history_from,
            EventMetric.bucket < time_to,
        )
        .order_by(EventMetric.bucket)
    ).all()
    return [SeriesPoint(bucket=bucket, count=count) for bucket, count in rows]


def _replace_scope_anomalies(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    evaluation_start: datetime,
    evaluation_end: datetime,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    anomalies: list[DetectedAnomaly],
) -> int:
    session.execute(
        delete(MetricAnomaly).where(
            MetricAnomaly.scan_config_id == scan_config_id,
            MetricAnomaly.scope_type == scope_type,
            MetricAnomaly.scope_ref == scope_ref,
            MetricAnomaly.bucket >= evaluation_start,
            MetricAnomaly.bucket < evaluation_end,
        )
    )

    for anomaly in anomalies:
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
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

    return len(anomalies)


def _load_breakdown_scope_points(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool,
    history_from: datetime,
    time_to: datetime,
) -> list[SeriesPoint]:
    query = (
        select(EventMetricBreakdown.bucket, sa_func.sum(EventMetricBreakdown.count))
        .where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.breakdown_column == breakdown_column,
            EventMetricBreakdown.breakdown_value == breakdown_value,
            EventMetricBreakdown.is_other.is_(is_other),
            EventMetricBreakdown.bucket >= history_from,
            EventMetricBreakdown.bucket < time_to,
        )
        .group_by(EventMetricBreakdown.bucket)
        .order_by(EventMetricBreakdown.bucket)
    )

    if scope_type == SCOPE_PROJECT_TOTAL:
        query = query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        query = query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id == uuid.UUID(scope_ref),
        )
    else:
        query = query.where(EventMetricBreakdown.event_id == uuid.UUID(scope_ref))

    rows = session.execute(query).all()
    return [SeriesPoint(bucket=bucket, count=int(count)) for bucket, count in rows]


def _replace_scope_breakdown_anomalies(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool,
    evaluation_start: datetime,
    evaluation_end: datetime,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    anomalies: list[DetectedAnomaly],
) -> int:
    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scan_config_id == scan_config_id,
            MetricBreakdownAnomaly.scope_type == scope_type,
            MetricBreakdownAnomaly.scope_ref == scope_ref,
            MetricBreakdownAnomaly.breakdown_column == breakdown_column,
            MetricBreakdownAnomaly.breakdown_value == breakdown_value,
            MetricBreakdownAnomaly.is_other.is_(is_other),
            MetricBreakdownAnomaly.bucket >= evaluation_start,
            MetricBreakdownAnomaly.bucket < evaluation_end,
        )
    )

    for anomaly in anomalies:
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
                scope_type=scope_type,
                scope_ref=scope_ref,
                event_id=event_id,
                event_type_id=event_type_id,
                bucket=anomaly.bucket,
                breakdown_column=breakdown_column,
                breakdown_value=breakdown_value,
                is_other=is_other,
                actual_count=anomaly.actual_count,
                expected_count=anomaly.expected_count,
                stddev=anomaly.stddev,
                z_score=anomaly.z_score,
                direction=anomaly.direction,
            )
        )

    return len(anomalies)


def _collect_scope_ids(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    history_from: datetime,
    evaluation_start: datetime,
    evaluation_end: datetime,
    scope_type: str,
) -> set[uuid.UUID]:
    metric_column = (
        EventMetric.event_type_id if scope_type == SCOPE_EVENT_TYPE else EventMetric.event_id
    )
    anomaly_column = (
        MetricAnomaly.event_type_id if scope_type == SCOPE_EVENT_TYPE else MetricAnomaly.event_id
    )

    ids = {
        value
        for value in session.execute(
            select(metric_column).where(
                EventMetric.scan_config_id == scan_config_id,
                metric_column.is_not(None),
                EventMetric.bucket >= history_from,
                EventMetric.bucket < evaluation_end,
            )
        ).scalars()
        if value is not None
    }
    ids.update(
        value
        for value in session.execute(
            select(anomaly_column).where(
                MetricAnomaly.scan_config_id == scan_config_id,
                MetricAnomaly.scope_type == scope_type,
                anomaly_column.is_not(None),
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        ).scalars()
        if value is not None
    )
    return ids


def _collect_breakdown_scope_keys(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    history_from: datetime,
    evaluation_start: datetime,
    evaluation_end: datetime,
    scope_type: str,
) -> set[tuple[uuid.UUID | None, uuid.UUID | None, str, str, bool]]:
    metric_id_column = (
        EventMetricBreakdown.event_type_id
        if scope_type == SCOPE_EVENT_TYPE
        else EventMetricBreakdown.event_id
    )
    anomaly_id_column = (
        MetricBreakdownAnomaly.event_type_id
        if scope_type == SCOPE_EVENT_TYPE
        else MetricBreakdownAnomaly.event_id
    )

    metric_query = select(
        EventMetricBreakdown.event_id,
        EventMetricBreakdown.event_type_id,
        EventMetricBreakdown.breakdown_column,
        EventMetricBreakdown.breakdown_value,
        EventMetricBreakdown.is_other,
    ).where(
        EventMetricBreakdown.scan_config_id == scan_config_id,
        EventMetricBreakdown.bucket >= history_from,
        EventMetricBreakdown.bucket < evaluation_end,
    )
    anomaly_query = select(
        MetricBreakdownAnomaly.event_id,
        MetricBreakdownAnomaly.event_type_id,
        MetricBreakdownAnomaly.breakdown_column,
        MetricBreakdownAnomaly.breakdown_value,
        MetricBreakdownAnomaly.is_other,
    ).where(
        MetricBreakdownAnomaly.scan_config_id == scan_config_id,
        MetricBreakdownAnomaly.scope_type == scope_type,
        MetricBreakdownAnomaly.bucket >= evaluation_start,
        MetricBreakdownAnomaly.bucket < evaluation_end,
    )

    if scope_type == SCOPE_PROJECT_TOTAL:
        metric_query = metric_query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
    else:
        metric_query = metric_query.where(metric_id_column.is_not(None))
        anomaly_query = anomaly_query.where(anomaly_id_column.is_not(None))

    keys: set[tuple[uuid.UUID | None, uuid.UUID | None, str, str, bool]] = set()
    for event_id, event_type_id, column, value, is_other in session.execute(metric_query).all():
        if scope_type == SCOPE_PROJECT_TOTAL:
            keys.add((None, None, column, value, bool(is_other)))
        else:
            keys.add((event_id, event_type_id, column, value, bool(is_other)))
    for event_id, event_type_id, column, value, is_other in session.execute(anomaly_query).all():
        if scope_type == SCOPE_PROJECT_TOTAL:
            keys.add((None, None, column, value, bool(is_other)))
        else:
            keys.add((event_id, event_type_id, column, value, bool(is_other)))
    return keys


def _classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
) -> str | None:
    if latest_metric_bucket is None or anomaly_bucket >= latest_metric_bucket:
        return "latest_scan"

    recent_cutoff = datetime.now(UTC)
    if anomaly_bucket.tzinfo is None:
        recent_cutoff = recent_cutoff.replace(tzinfo=None)
    recent_cutoff -= RECENT_SIGNAL_WINDOW
    if anomaly_bucket >= recent_cutoff:
        return "recent"

    return None


def _get_visible_signal_scope_keys(
    session: Session,
    scan_config_id: uuid.UUID,
) -> set[tuple[str, str]]:
    latest_metrics: dict[tuple[str, str], datetime] = {}

    latest_project_total_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
    ).scalar_one_or_none()
    if latest_project_total_bucket is not None:
        latest_metrics[(SCOPE_PROJECT_TOTAL, str(scan_config_id))] = latest_project_total_bucket

    for event_type_id, bucket in session.execute(
        select(EventMetric.event_type_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
        .group_by(EventMetric.event_type_id)
    ).all():
        if event_type_id is not None:
            latest_metrics[(SCOPE_EVENT_TYPE, str(event_type_id))] = bucket

    for event_id, bucket in session.execute(
        select(EventMetric.event_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
        )
        .group_by(EventMetric.event_id)
    ).all():
        if event_id is not None:
            latest_metrics[(SCOPE_EVENT, str(event_id))] = bucket

    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .where(MetricAnomaly.scan_config_id == scan_config_id)
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    return {
        key
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
        )
        is not None
    }


def _get_latest_metric_buckets(
    session: Session,
    scan_config_id: uuid.UUID,
) -> dict[tuple[str, str], datetime]:
    latest_metrics: dict[tuple[str, str], datetime] = {}
    latest_project_total_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
    ).scalar_one_or_none()
    if latest_project_total_bucket is not None:
        latest_metrics[(SCOPE_PROJECT_TOTAL, str(scan_config_id))] = latest_project_total_bucket

    for event_type_id, bucket in session.execute(
        select(EventMetric.event_type_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
        .group_by(EventMetric.event_type_id)
    ).all():
        if event_type_id is not None:
            latest_metrics[(SCOPE_EVENT_TYPE, str(event_type_id))] = bucket

    for event_id, bucket in session.execute(
        select(EventMetric.event_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
        )
        .group_by(EventMetric.event_id)
    ).all():
        if event_id is not None:
            latest_metrics[(SCOPE_EVENT, str(event_id))] = bucket

    return latest_metrics


def _build_monitoring_url(
    project_slug: str,
    *,
    scope_type: str,
    scope_ref: str,
) -> str | None:
    if not settings.app_base_url:
        return None
    base = settings.app_base_url.rstrip("/")
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"{base}/p/{project_slug}/monitoring/project-total/{scope_ref}"
    if scope_type == SCOPE_EVENT_TYPE:
        return f"{base}/p/{project_slug}/monitoring/event-type/{scope_ref}"
    return f"{base}/p/{project_slug}/monitoring/event/{scope_ref}"


def _build_event_details_url(project_slug: str, event_id: uuid.UUID | None) -> str | None:
    if not settings.app_base_url or event_id is None:
        return None
    base = settings.app_base_url.rstrip("/")
    return f"{base}/p/{project_slug}/events/detail/{event_id}"


def _get_project_slug(session: Session, project_id: uuid.UUID) -> str:
    slug = session.execute(
        select(Project.slug).where(Project.id == project_id)
    ).scalar_one_or_none()
    if slug is None:
        msg = f"Project {project_id} not found"
        raise ValueError(msg)
    return slug


def _get_latest_active_anomalies(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], MetricAnomaly]:
    latest_metrics = _get_latest_metric_buckets(session, config.id)
    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .where(MetricAnomaly.scan_config_id == config.id)
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    return {
        key: anomaly
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
        )
        == "latest_scan"
    }


def _build_alert_scope_names(
    session: Session,
    anomalies: list[MetricAnomaly],
) -> dict[tuple[str, str], str]:
    scope_names: dict[tuple[str, str], str] = {
        (SCOPE_PROJECT_TOTAL, anomaly.scope_ref): "All events"
        for anomaly in anomalies
        if anomaly.scope_type == SCOPE_PROJECT_TOTAL
    }

    event_type_ids = {
        anomaly.event_type_id for anomaly in anomalies if anomaly.event_type_id is not None
    }
    if event_type_ids:
        for event_type_id, display_name, name in session.execute(
            select(EventType.id, EventType.display_name, EventType.name).where(
                EventType.id.in_(event_type_ids)
            )
        ).all():
            scope_names[(SCOPE_EVENT_TYPE, str(event_type_id))] = display_name or name

    event_ids = {anomaly.event_id for anomaly in anomalies if anomaly.event_id is not None}
    if event_ids:
        for event_id, name in session.execute(
            select(Event.id, Event.name).where(Event.id.in_(event_ids))
        ).all():
            scope_names[(SCOPE_EVENT, str(event_id))] = name

    for anomaly in anomalies:
        key = (anomaly.scope_type, anomaly.scope_ref)
        scope_names.setdefault(key, anomaly.scope_ref)
    return scope_names


def _load_enabled_alert_destinations(
    session: Session,
    project_id: uuid.UUID,
) -> list[AlertDestination]:
    return list(
        session.execute(
            select(AlertDestination)
            .where(
                AlertDestination.project_id == project_id,
                AlertDestination.enabled.is_(True),
            )
            .order_by(AlertDestination.created_at.desc())
        )
        .scalars()
        .unique()
        .all()
    )


def _rule_matches_anomaly(
    rule: AlertRule,
    anomaly: MetricAnomaly,
) -> bool:
    if anomaly.scope_type == SCOPE_PROJECT_TOTAL and not rule.include_project_total:
        return False
    if anomaly.scope_type == SCOPE_EVENT_TYPE and not rule.include_event_types:
        return False
    if anomaly.scope_type == SCOPE_EVENT and not rule.include_events:
        return False
    if anomaly.direction == "spike" and not rule.notify_on_spike:
        return False
    if anomaly.direction == "drop" and not rule.notify_on_drop:
        return False
    if anomaly.expected_count < rule.min_expected_count:
        return False

    absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
    if absolute_delta < rule.min_absolute_delta:
        return False

    percent_delta = 0.0
    if anomaly.expected_count > 0:
        percent_delta = (absolute_delta / anomaly.expected_count) * 100
    if percent_delta < rule.min_percent_delta:
        return False

    return all(_filter_matches_anomaly(filter_row, anomaly) for filter_row in rule.filters)


def _filter_matches_anomaly(
    filter_row: AlertRuleFilter,
    anomaly: MetricAnomaly,
) -> bool:
    if filter_row.field == "event_type":
        actual = str(anomaly.event_type_id) if anomaly.event_type_id is not None else None
    elif filter_row.field == "event":
        actual = str(anomaly.event_id) if anomaly.event_id is not None else None
    elif filter_row.field == "direction":
        actual = "up" if anomaly.direction == "spike" else "down"
    else:
        return True

    if actual is None:
        return True

    values = set(filter_row.values or [])
    if filter_row.operator in ("eq", "in"):
        return actual in values
    if filter_row.operator in ("ne", "not_in"):
        return actual not in values
    return True


def _build_delivery_snapshot(
    config: ScanConfig,
    *,
    project_slug: str,
    rule: AlertRule,
    destination: AlertDestination,
    anomalies: list[MetricAnomaly],
    scope_names: dict[tuple[str, str], str],
) -> dict[str, object]:
    return {
        "project_slug": project_slug,
        "scan_name": config.name,
        "destination_name": destination.name,
        "rule_name": rule.name,
        "channel": destination.type,
        "matched_count": len(anomalies),
        "items": [
            {
                "scope_type": anomaly.scope_type,
                "scope_ref": anomaly.scope_ref,
                "scope_name": scope_names[(anomaly.scope_type, anomaly.scope_ref)],
                "direction": anomaly.direction,
                "actual_count": anomaly.actual_count,
                "expected_count": round(anomaly.expected_count),
                "absolute_delta": round(abs(anomaly.actual_count - anomaly.expected_count)),
                "percent_delta": (
                    abs(anomaly.actual_count - anomaly.expected_count)
                    / anomaly.expected_count
                    * 100
                    if anomaly.expected_count > 0
                    else 0.0
                ),
                "details_path": _build_event_details_url(project_slug, anomaly.event_id),
                "monitoring_path": _build_monitoring_url(
                    project_slug,
                    scope_type=anomaly.scope_type,
                    scope_ref=anomaly.scope_ref,
                ),
            }
            for anomaly in anomalies
        ],
    }


def _prepare_alert_deliveries(
    session: Session,
    config: ScanConfig,
    *,
    scan_job_id: uuid.UUID | None,
) -> list[uuid.UUID]:
    active_anomalies = _get_latest_active_anomalies(session, config)
    destinations = _load_enabled_alert_destinations(session, config.project_id)
    if not destinations:
        return []

    now = datetime.now(UTC)
    project_slug = _get_project_slug(session, config.project_id)
    scope_names = _build_alert_scope_names(session, list(active_anomalies.values()))
    delivery_ids: list[uuid.UUID] = []

    for destination in destinations:
        enabled_rules = [rule for rule in destination.rules if rule.enabled]
        if not enabled_rules:
            continue

        for rule in enabled_rules:
            existing_states = {
                (state.scope_type, state.scope_ref): state
                for state in session.execute(
                    select(AlertRuleState).where(
                        AlertRuleState.rule_id == rule.id,
                        AlertRuleState.scan_config_id == config.id,
                    )
                ).scalars()
            }

            matched_anomalies = [
                anomaly
                for key, anomaly in active_anomalies.items()
                if _rule_matches_anomaly(rule, anomaly)
            ]
            matched_keys = {
                (anomaly.scope_type, anomaly.scope_ref) for anomaly in matched_anomalies
            }

            for key, existing_state in existing_states.items():
                if existing_state.is_active and key not in matched_keys:
                    existing_state.is_active = False
                    existing_state.closed_at = now

            anomalies_to_send: list[MetricAnomaly] = []
            for anomaly in matched_anomalies:
                key = (anomaly.scope_type, anomaly.scope_ref)
                current_state = existing_states.get(key)
                should_send = False
                if current_state is None:
                    current_state = AlertRuleState(
                        rule_id=rule.id,
                        scan_config_id=config.id,
                        scope_type=anomaly.scope_type,
                        scope_ref=anomaly.scope_ref,
                        is_active=True,
                        opened_at=now,
                        closed_at=None,
                        last_anomaly_bucket=anomaly.bucket,
                    )
                    session.add(current_state)
                    existing_states[key] = current_state
                    should_send = True
                else:
                    if not current_state.is_active:
                        current_state.is_active = True
                        current_state.opened_at = now
                        current_state.closed_at = None
                        should_send = True
                    elif (
                        current_state.last_notified_at is None
                        or (
                            current_state.last_anomaly_bucket is None
                            or anomaly.bucket > current_state.last_anomaly_bucket
                        )
                        and now - current_state.last_notified_at
                        >= timedelta(minutes=rule.cooldown_minutes)
                    ):
                        should_send = True
                    current_state.last_anomaly_bucket = max(
                        anomaly.bucket,
                        current_state.last_anomaly_bucket or anomaly.bucket,
                    )
                if should_send:
                    anomalies_to_send.append(anomaly)

            if not anomalies_to_send:
                continue

            payload_snapshot = _build_delivery_snapshot(
                config,
                project_slug=project_slug,
                rule=rule,
                destination=destination,
                anomalies=anomalies_to_send,
                scope_names=scope_names,
            )
            delivery = AlertDelivery(
                project_id=config.project_id,
                scan_config_id=config.id,
                scan_job_id=scan_job_id,
                destination_id=destination.id,
                rule_id=rule.id,
                status=AlertDeliveryStatus.pending.value,
                channel=destination.type,
                matched_count=len(anomalies_to_send),
                payload_snapshot=payload_snapshot,
            )
            session.add(delivery)
            session.flush()

            for anomaly in anomalies_to_send:
                absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
                percent_delta = (
                    absolute_delta / anomaly.expected_count * 100
                    if anomaly.expected_count > 0
                    else 0.0
                )
                session.add(
                    AlertDeliveryItem(
                        delivery_id=delivery.id,
                        scope_type=anomaly.scope_type,
                        scope_ref=anomaly.scope_ref,
                        scope_name=scope_names[(anomaly.scope_type, anomaly.scope_ref)],
                        event_type_id=anomaly.event_type_id,
                        event_id=anomaly.event_id,
                        bucket=anomaly.bucket,
                        direction=anomaly.direction,
                        actual_count=anomaly.actual_count,
                        expected_count=round(anomaly.expected_count),
                        absolute_delta=round(absolute_delta),
                        percent_delta=percent_delta,
                        details_path=_build_event_details_url(
                            project_slug,
                            anomaly.event_id,
                        ),
                        monitoring_path=_build_monitoring_url(
                            project_slug,
                            scope_type=anomaly.scope_type,
                            scope_ref=anomaly.scope_ref,
                        ),
                    )
                )
            delivery_ids.append(delivery.id)

    return delivery_ids


def _recalculate_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    project_settings = _get_project_anomaly_settings(session, config.project_id)
    if project_settings is None or not project_settings.anomaly_detection_enabled:
        session.execute(delete(MetricAnomaly).where(MetricAnomaly.scan_config_id == config.id))
        session.flush()
        return 0

    if not config.interval:
        return 0

    interval_spec = get_interval(config.interval)
    history_from = evaluation_start - interval_spec.delta * project_settings.baseline_window_buckets
    settings = _build_anomaly_settings(project_settings)
    anomalies_detected = 0

    if project_settings.detect_project_total:
        points = _load_scope_points(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_PROJECT_TOTAL,
            scope_ref=str(config.id),
            history_from=history_from,
            time_to=evaluation_end,
        )
        anomalies_detected += _replace_scope_anomalies(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_PROJECT_TOTAL,
            scope_ref=str(config.id),
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            event_id=None,
            event_type_id=None,
            anomalies=detect_anomalies(
                points,
                interval=interval_spec.delta,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                settings=settings,
            ),
        )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_PROJECT_TOTAL,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_event_types:
        for event_type_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
        ):
            scope_ref = str(event_type_id)
            points = _load_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=event_type_id,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_EVENT_TYPE,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_events:
        for event_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
        ):
            scope_ref = str(event_id)
            points = _load_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=event_id,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_EVENT,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    session.flush()
    return anomalies_detected


def _recalculate_metric_breakdown_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    project_settings = _get_project_anomaly_settings(session, config.project_id)
    if project_settings is None or not project_settings.anomaly_detection_enabled:
        session.execute(
            delete(MetricBreakdownAnomaly).where(MetricBreakdownAnomaly.scan_config_id == config.id)
        )
        session.flush()
        return 0

    if not config.interval or not config.metric_breakdown_columns:
        session.execute(
            delete(MetricBreakdownAnomaly).where(MetricBreakdownAnomaly.scan_config_id == config.id)
        )
        session.flush()
        return 0

    interval_spec = get_interval(config.interval)
    history_from = evaluation_start - interval_spec.delta * project_settings.baseline_window_buckets
    settings = _build_anomaly_settings(project_settings)
    anomalies_detected = 0

    if project_settings.detect_project_total:
        for _event_id, _event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_PROJECT_TOTAL,
        ):
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_PROJECT_TOTAL,
                scope_ref=str(config.id),
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_PROJECT_TOTAL,
                scope_ref=str(config.id),
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_PROJECT_TOTAL,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_event_types:
        for _event_id, event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
        ):
            if event_type_id is None:
                continue
            scope_ref = str(event_type_id)
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=event_type_id,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_EVENT_TYPE,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_events:
        for event_id, _event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
        ):
            if event_id is None:
                continue
            scope_ref = str(event_id)
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=event_id,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_EVENT,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    session.flush()
    return anomalies_detected


def _upsert_event_metrics_rows(
    session: Session,
    *,
    rows: list[dict[str, object]],
    constraint: str,
) -> None:
    if not rows:
        return

    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(EventMetric).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=["scan_config_id", "event_id", "bucket"]
            if constraint == "uq_event_metric_config_event_bucket"
            else ["scan_config_id", "event_type_id", "bucket"],
            set_={"count": sqlite_stmt.excluded.count},
        )
        session.execute(sqlite_stmt)
        return

    pg_stmt = pg_insert(EventMetric).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint=constraint,
        set_={"count": pg_stmt.excluded.count},
    )
    session.execute(pg_stmt)


def _upsert_event_metric_breakdown_rows(
    session: Session,
    *,
    rows: list[dict[str, object]],
    constraint: str,
) -> None:
    if not rows:
        return

    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(EventMetricBreakdown).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=[
                "scan_config_id",
                "event_id" if constraint == "event" else "event_type_id",
                "bucket",
                "breakdown_column",
                "breakdown_value",
                "is_other",
            ],
            set_={"count": sqlite_stmt.excluded.count, "is_other": sqlite_stmt.excluded.is_other},
        )
        session.execute(sqlite_stmt)
        return

    pg_constraint = (
        "uq_event_metric_breakdown_config_event_bucket_value"
        if constraint == "event"
        else "uq_event_metric_breakdown_config_type_bucket_value"
    )
    pg_stmt = pg_insert(EventMetricBreakdown).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint=pg_constraint,
        set_={"count": pg_stmt.excluded.count, "is_other": pg_stmt.excluded.is_other},
    )
    session.execute(pg_stmt)


def _delete_event_metrics_window(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime,
    time_to: datetime,
) -> int:
    result = session.execute(
        delete(EventMetric).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.bucket >= time_from,
            EventMetric.bucket < time_to,
        )
    )
    rowcount = getattr(result, "rowcount", 0)
    return int(rowcount or 0)


def _delete_event_metric_breakdowns_window(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime,
    time_to: datetime,
) -> int:
    result = session.execute(
        delete(EventMetricBreakdown).where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.bucket >= time_from,
            EventMetricBreakdown.bucket < time_to,
        )
    )
    rowcount = getattr(result, "rowcount", 0)
    return int(rowcount or 0)


def _collect_metric_breakdown_rows(
    *,
    adapter: BaseAdapter,
    config: ScanConfig,
    interval_ch_interval: str,
    regular_cols: list[str],
    json_cols: list[str],
    json_value_path_map: dict[str, list[str]],
    time_from: datetime,
    time_to: datetime,
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    gen_results: dict[str, GenerationResult],
    single_result: GenerationResult | None,
    et_by_name: dict[str, EventType],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime, str, str, bool], int] = {}
    type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime, str, str, bool], int] = {}
    et_col_idx = reg_index.get(config.event_type_column) if config.event_type_column else None

    breakdown_columns: list[str] = []
    seen_breakdown_columns: set[str] = set()
    for configured_column in config.metric_breakdown_columns or []:
        if configured_column in seen_breakdown_columns:
            continue
        seen_breakdown_columns.add(configured_column)
        if _is_supported_metric_breakdown_column(
            config,
            column=configured_column,
            regular_cols=regular_cols,
        ):
            breakdown_columns.append(configured_column)
            continue
        logger.warning(
            "Skipping unsupported metric breakdown column %r for scan %s",
            configured_column,
            config.id,
        )

    if not breakdown_columns:
        return [], []

    _col_names, breakdown_json_value_names, rows = adapter.get_time_bucketed_breakdown_counts_multi(
        config.base_query,
        config.time_column or "",
        interval_ch_interval,
        breakdown_columns,
        regular_cols,
        json_cols,
        json_value_path_map,
        time_from,
        time_to,
        values_limit=config.metric_breakdown_values_limit,
    )
    logger.info(
        "Got %s bucketed breakdown rows for %s from ClickHouse",
        len(rows),
        ", ".join(breakdown_columns),
    )

    for row in rows:
        bucket = cast(datetime, row[0])
        breakdown_column = str(row[1])
        breakdown_value = _normalize_breakdown_value(row[2])
        is_other = bool(row[3])
        data_row = row[4:]
        cnt = int(cast(int | str | float, row[-1]))
        col_meta: dict[str, dict[str, object]]
        events_by_name: dict[str, Event]
        event_type_id: uuid.UUID | None

        if config.event_type_column and et_col_idx is not None:
            et_name = str(data_row[et_col_idx])
            event_type = et_by_name.get(et_name)
            if event_type is None:
                continue
            event_type_id = event_type.id
            gen_result: GenerationResult | None = gen_results.get(et_name)
            if gen_result is None:
                continue
            col_meta = gen_result.col_meta
            events_by_name = gen_result.events_by_name
        else:
            event_type_id = config.event_type_id
            if single_result is None:
                continue
            col_meta = single_result.col_meta
            events_by_name = single_result.events_by_name

        event_name = _build_event_name_from_row(
            data_row,
            col_meta,
            reg_index,
            json_index,
            n_reg,
            breakdown_json_value_names,
            config.event_name_format,
        )

        if event_name:
            ev = events_by_name.get(event_name)
            if isinstance(ev, Event):
                key = (
                    config.id,
                    ev.id,
                    bucket,
                    breakdown_column,
                    breakdown_value,
                    is_other,
                )
                event_agg[key] = event_agg.get(key, 0) + cnt

        if event_type_id:
            key = (
                config.id,
                event_type_id,
                bucket,
                breakdown_column,
                breakdown_value,
                is_other,
            )
            type_agg[key] = type_agg.get(key, 0) + cnt

    event_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": ev_id,
            "event_type_id": None,
            "bucket": bucket,
            "breakdown_column": column,
            "breakdown_value": value,
            "is_other": is_other,
            "count": total,
        }
        for (sc_id, ev_id, bucket, column, value, is_other), total in event_agg.items()
    ]
    type_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": None,
            "event_type_id": et_id,
            "bucket": bucket,
            "breakdown_column": column,
            "breakdown_value": value,
            "is_other": is_other,
            "count": total,
        }
        for (sc_id, et_id, bucket, column, value, is_other), total in type_agg.items()
    ]
    return event_rows, type_rows


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.metrics.collect_metrics",
    bind=True,
    max_retries=0,
)
def collect_metrics(
    self: object,
    scan_config_id: str,
    job_id: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
) -> dict[str, object]:
    """Collect time-bucketed event counts from ClickHouse and store in event_metrics.

    Phase 1: sync events using the exact same pipeline as the manual scan
             (analyze_cardinality + generate_events).
    Phase 2: query time-bucketed counts, match rows to events, UPSERT metrics.
    """
    session = _get_sync_session()
    adapter = None
    job: ScanJob | None = None

    try:
        config = session.get(ScanConfig, uuid.UUID(scan_config_id))
        if config is None:
            msg = f"ScanConfig {scan_config_id} not found"
            raise ValueError(msg)

        if not config.time_column or not config.interval:
            logger.info(f"ScanConfig {scan_config_id}: time_column or interval not set, skipping")
            return {"skipped": True}

        if job_id is not None:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job is None:
                msg = f"ScanJob {job_id} not found"
                raise ValueError(msg)
            if job.scan_config_id != config.id:
                msg = f"ScanJob {job_id} does not belong to ScanConfig {scan_config_id}"
                raise ValueError(msg)

            job.status = ScanJobStatus.running.value
            job.started_at = job.started_at or datetime.now(UTC)
            job.completed_at = None
            job.error_message = None
        else:
            job = ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.running.value,
                started_at=datetime.now(UTC),
            )
            session.add(job)
        session.commit()

        visible_signals_before = _get_visible_signal_scope_keys(session, config.id)

        ds = session.get(DataSource, config.data_source_id)
        if ds is None:
            msg = f"DataSource for config {scan_config_id} not found"
            raise ValueError(msg)

        adapter = _build_adapter(ds)
        adapter.test_connection()

        # Get columns (same as scan task)
        columns = adapter.get_columns(config.base_query)
        if config.time_column:
            columns = [c for c in columns if c.name != config.time_column]
        logger.info(f"Found {len(columns)} columns in base query")

        skip_cols = set()
        if config.event_type_column:
            skip_cols.add(config.event_type_column)
        if config.time_column:
            skip_cols.add(config.time_column)
        json_value_path_map = _get_scan_json_value_path_map(config)

        # ---- PHASE 1: Sync events via exact scan pipeline ----

        gen_results: dict[str, GenerationResult] = {}
        single_result: GenerationResult | None = None

        if config.event_type_column:
            # Grouped scan: same as _scan_with_grouping in scan.py
            group_values, grouped_analyses = analyze_cardinality_grouped(
                adapter,
                config.base_query,
                columns,
                group_column=config.event_type_column,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_path_map,
            )
            logger.info(
                f"Grouped scan: {len(group_values)} groups for {config.event_type_column!r}"
            )

            for et_name in group_values:
                et = _ensure_event_type_with_fields(
                    session,
                    config.project_id,
                    et_name,
                    columns,
                    skip_cols,
                )
                field_defs = {fd.name: fd for fd in et.field_definitions}
                result = generate_events(
                    session,
                    config.project_id,
                    et.id,
                    grouped_analyses[et_name],
                    field_defs,
                    cardinality_threshold=config.cardinality_threshold,
                    event_type_column=config.event_type_column,
                    time_column=config.time_column,
                    event_name_format=config.event_name_format,
                )
                gen_results[et_name] = result
                logger.info(
                    f"  {et_name!r}: {result.events_created} created, "
                    f"{result.events_skipped} updated"
                )

        elif config.event_type_id:
            # Single event type: same as run_scan single-type path
            analysis = analyze_cardinality(
                adapter,
                config.base_query,
                columns,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_path_map,
            )

            event_type = session.get(EventType, config.event_type_id)
            if event_type is None:
                msg = f"EventType {config.event_type_id} not found"
                raise ValueError(msg)

            field_defs = {fd.name: fd for fd in event_type.field_definitions}
            single_result = generate_events(
                session,
                config.project_id,
                config.event_type_id,
                analysis,
                field_defs,
                cardinality_threshold=config.cardinality_threshold,
                event_type_column=config.event_type_column,
                time_column=config.time_column,
                event_name_format=config.event_name_format,
            )
            logger.info(
                f"Single scan: {single_result.events_created} created, "
                f"{single_result.events_skipped} updated"
            )
        else:
            msg = "Either event_type_id or event_type_column must be specified"
            raise ValueError(msg)

        session.commit()

        # ---- PHASE 2: Collect time-bucketed metrics ----

        assert config.interval is not None
        interval_spec = get_interval(config.interval)
        delta = interval_spec.delta
        time_from_dt, time_to_dt, is_replay = _resolve_collection_window(
            session,
            config=config,
            delta=delta,
            manual_time_from=time_from,
            manual_time_to=time_to,
        )

        logger.info(
            f"Collecting metrics: {time_from_dt.isoformat()} to {time_to_dt.isoformat()}, "
            f"interval={config.interval}, replay={is_replay}"
        )

        # Split columns for the CH query (same split as cardinality.py uses)
        regular_cols = [c.name for c in columns if not _is_json_type(c.type_name)]
        json_cols = [c.name for c in columns if _is_json_type(c.type_name)]

        col_names, json_value_names, rows = adapter.get_time_bucketed_counts(
            config.base_query,
            config.time_column,
            interval_spec.ch_interval,
            regular_cols,
            json_cols,
            json_value_path_map,
            time_from_dt,
            time_to_dt,
        )
        logger.info(f"Got {len(rows)} bucketed rows from ClickHouse")

        metrics_deleted = _delete_event_metrics_window(
            session,
            scan_config_id=config.id,
            time_from=time_from_dt,
            time_to=time_to_dt,
        )
        breakdown_metrics_deleted = _delete_event_metric_breakdowns_window(
            session,
            scan_config_id=config.id,
            time_from=time_from_dt,
            time_to=time_to_dt,
        )

        # Collect totals from Phase 1 for result_summary
        total_created = 0
        total_skipped = 0
        total_vars = 0
        total_cols = 0
        all_details: list[str] = []
        if single_result:
            total_created += single_result.events_created
            total_skipped += single_result.events_skipped
            total_vars += single_result.variables_created
            total_cols = max(total_cols, single_result.columns_analyzed)
            all_details.extend(single_result.details)
        for gr in gen_results.values():
            total_created += gr.events_created
            total_skipped += gr.events_skipped
            total_vars += gr.variables_created
            total_cols = max(total_cols, gr.columns_analyzed)
            all_details.extend(gr.details)

        if not rows:
            anomalies_detected = _recalculate_metric_anomalies(
                session,
                config,
                evaluation_start=time_from_dt,
                evaluation_end=time_to_dt,
            )
            breakdown_anomalies_detected = _recalculate_metric_breakdown_anomalies(
                session,
                config,
                evaluation_start=time_from_dt,
                evaluation_end=time_to_dt,
            )
            delivery_ids = _prepare_alert_deliveries(
                session,
                config,
                scan_job_id=job.id if job else None,
            )
            visible_signals_after = _get_visible_signal_scope_keys(session, config.id)
            signals_added = len(visible_signals_after - visible_signals_before)
            signals_removed = len(visible_signals_before - visible_signals_after)
            result_summary: dict[str, object] = {
                "mode": "metrics_replay" if is_replay else "metrics_collection",
                "time_from": time_from_dt.isoformat(),
                "time_to": time_to_dt.isoformat(),
                "events_created": total_created,
                "events_skipped": total_skipped,
                "variables_created": total_vars,
                "columns_analyzed": total_cols,
                "event_metrics": 0,
                "type_metrics": 0,
                "breakdown_event_metrics": 0,
                "breakdown_type_metrics": 0,
                "metrics_deleted": metrics_deleted,
                "breakdown_metrics_deleted": breakdown_metrics_deleted,
                "anomalies_detected": anomalies_detected,
                "breakdown_anomalies_detected": breakdown_anomalies_detected,
                "signals_added": signals_added,
                "signals_removed": signals_removed,
                "alerts_queued": len(delivery_ids),
                "details": all_details,
            }
            if job:
                job.status = ScanJobStatus.completed.value
                job.completed_at = datetime.now(UTC)
                job.result_summary = result_summary
            session.commit()
            cache.sync_delete_prefix(cache.prefix_signals())
            cache.sync_delete_prefix(cache.prefix_projects())
            for delivery_id in delivery_ids:
                send_alert_delivery.delay(str(delivery_id))
            return result_summary

        # Build indices for row navigation (same layout as BreakdownAnalysis)
        reg_index = {name: i for i, name in enumerate(regular_cols)}
        json_index = {name: i for i, name in enumerate(json_cols)}
        n_reg = len(regular_cols)

        # Event type lookup (for grouped mode)
        et_by_name: dict[str, EventType] = {}
        if config.event_type_column:
            all_ets = (
                session.execute(select(EventType).where(EventType.project_id == config.project_id))
                .scalars()
                .all()
            )
            et_by_name = {et.name: et for et in all_ets}

        # Aggregate metrics: (scan_config_id, event_id, bucket) -> count
        event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
        # (scan_config_id, event_type_id, bucket) -> count
        type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}

        et_col_idx = reg_index.get(config.event_type_column) if config.event_type_column else None

        for row in rows:
            bucket = cast(datetime, row[0])
            data_row = row[1:]  # strip _bucket; _cnt is at the end but not indexed by col_meta
            cnt = int(cast(int | str | float, row[-1]))
            col_meta: dict[str, dict[str, object]]
            events_by_name: dict[str, Event]
            event_type_id: uuid.UUID | None

            # Determine event type and get the matching gen result
            if config.event_type_column and et_col_idx is not None:
                et_name = str(data_row[et_col_idx])
                event_type = et_by_name.get(et_name)
                if event_type is None:
                    continue
                event_type_id = event_type.id
                gen_result: GenerationResult | None = gen_results.get(et_name)
                if gen_result is None:
                    continue
                col_meta = gen_result.col_meta
                events_by_name = gen_result.events_by_name
            else:
                event_type_id = config.event_type_id
                if single_result is None:
                    continue
                col_meta = single_result.col_meta
                events_by_name = single_result.events_by_name

            # Build event name from row (same logic as generate_events)
            event_name = _build_event_name_from_row(
                data_row,
                col_meta,
                reg_index,
                json_index,
                n_reg,
                json_value_names,
                config.event_name_format,
            )

            if event_name:
                ev = events_by_name.get(event_name)
                if isinstance(ev, Event):
                    key = (config.id, ev.id, bucket)
                    event_agg[key] = event_agg.get(key, 0) + cnt

            if event_type_id:
                key = (config.id, event_type_id, bucket)
                type_agg[key] = type_agg.get(key, 0) + cnt

        # Build metrics rows for UPSERT
        event_rows: list[dict[str, object]] = [
            {
                "id": uuid.uuid4(),
                "scan_config_id": sc_id,
                "event_id": ev_id,
                "event_type_id": None,
                "bucket": bucket,
                "count": total,
            }
            for (sc_id, ev_id, bucket), total in event_agg.items()
        ]
        type_rows: list[dict[str, object]] = [
            {
                "id": uuid.uuid4(),
                "scan_config_id": sc_id,
                "event_id": None,
                "event_type_id": et_id,
                "bucket": bucket,
                "count": total,
            }
            for (sc_id, et_id, bucket), total in type_agg.items()
        ]
        breakdown_event_rows, breakdown_type_rows = _collect_metric_breakdown_rows(
            adapter=adapter,
            config=config,
            interval_ch_interval=interval_spec.ch_interval,
            regular_cols=regular_cols,
            json_cols=json_cols,
            json_value_path_map=json_value_path_map,
            time_from=time_from_dt,
            time_to=time_to_dt,
            reg_index=reg_index,
            json_index=json_index,
            n_reg=n_reg,
            gen_results=gen_results,
            single_result=single_result,
            et_by_name=et_by_name,
        )

        _upsert_event_metrics_rows(
            session,
            rows=event_rows,
            constraint="uq_event_metric_config_event_bucket",
        )
        _upsert_event_metrics_rows(
            session,
            rows=type_rows,
            constraint="uq_event_metric_config_type_bucket",
        )
        _upsert_event_metric_breakdown_rows(
            session,
            rows=breakdown_event_rows,
            constraint="event",
        )
        _upsert_event_metric_breakdown_rows(
            session,
            rows=breakdown_type_rows,
            constraint="type",
        )

        session.commit()

        n_ev = len(event_rows)
        n_tp = len(type_rows)
        n_breakdown_ev = len(breakdown_event_rows)
        n_breakdown_tp = len(breakdown_type_rows)
        logger.info(
            "Upserted %s event metrics + %s type metrics + "
            "%s event breakdown metrics + %s type breakdown metrics",
            n_ev,
            n_tp,
            n_breakdown_ev,
            n_breakdown_tp,
        )
        anomalies_detected = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=time_from_dt,
            evaluation_end=time_to_dt,
        )
        breakdown_anomalies_detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=time_from_dt,
            evaluation_end=time_to_dt,
        )
        delivery_ids = _prepare_alert_deliveries(
            session,
            config,
            scan_job_id=job.id if job else None,
        )
        visible_signals_after = _get_visible_signal_scope_keys(session, config.id)
        signals_added = len(visible_signals_after - visible_signals_before)
        signals_removed = len(visible_signals_before - visible_signals_after)

        result_summary = {
            "mode": "metrics_replay" if is_replay else "metrics_collection",
            "time_from": time_from_dt.isoformat(),
            "time_to": time_to_dt.isoformat(),
            "events_created": total_created,
            "events_skipped": total_skipped,
            "variables_created": total_vars,
            "columns_analyzed": total_cols,
            "event_metrics": n_ev,
            "type_metrics": n_tp,
            "breakdown_event_metrics": n_breakdown_ev,
            "breakdown_type_metrics": n_breakdown_tp,
            "metrics_deleted": metrics_deleted,
            "breakdown_metrics_deleted": breakdown_metrics_deleted,
            "anomalies_detected": anomalies_detected,
            "breakdown_anomalies_detected": breakdown_anomalies_detected,
            "signals_added": signals_added,
            "signals_removed": signals_removed,
            "alerts_queued": len(delivery_ids),
            "details": all_details,
        }

        if job:
            job.status = ScanJobStatus.completed.value
            job.completed_at = datetime.now(UTC)
            job.result_summary = result_summary
        session.commit()
        # Fresh anomalies → invalidate project summaries + signals cache so
        # dashboards reflect the new state immediately (TTL would add up to
        # 30–60s of staleness on a manual scan trigger).
        cache.sync_delete_prefix(cache.prefix_signals())
        cache.sync_delete_prefix(cache.prefix_projects())
        for delivery_id in delivery_ids:
            send_alert_delivery.delay(str(delivery_id))

        return result_summary

    except Exception as exc:
        logger.exception(f"Metrics collection failed for {scan_config_id}")
        if job:
            try:
                session.rollback()
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = str(exc)
                session.commit()
            except Exception:
                session.rollback()
        else:
            session.rollback()
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()


@celery_app.task(name="tripl.worker.tasks.metrics.check_metrics_due")  # type: ignore[untyped-decorator]
def check_metrics_due() -> dict[str, int]:
    """Check which scan configs are due for metrics collection and dispatch tasks."""
    session = _get_sync_session()
    try:
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
            active_job = _get_active_scan_job(session, config.id)
            if active_job is not None:
                if _fail_stale_active_scan_job(
                    session,
                    active_job,
                    now=now,
                    scan_name=config.name,
                ):
                    active_job = None
                else:
                    logger.info(
                        f"Skipping collect_metrics for {config.name!r}: "
                        f"active job {active_job.id} is {active_job.status}"
                    )
                    continue

            if active_job is not None:
                logger.info(
                    f"Skipping collect_metrics for {config.name!r}: "
                    f"active job {active_job.id} is {active_job.status}"
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
        session.close()

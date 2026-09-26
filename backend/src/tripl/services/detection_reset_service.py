"""Project-wide, owner-only reset of stored detections (danger zone).

Two categories are cleared independently:

- **Anomalies** — ``metric_anomalies`` + ``metric_breakdown_anomalies``. Catalog
  monitoring signals (catalog/anomalies inbox) are *derived* from
  ``metric_anomalies`` rows, so deleting the anomalies clears the signals too;
  there is no separate signal table to touch.
- **Drifts** — ``schema_drifts`` + ``distribution_drifts``.

Both operations are destructive and irreversible unless called with
``dry_run=True``, which counts the same rows and deletes nothing. They use bulk
``delete(...).where(...)`` with ``synchronize_session=False`` (no ORM objects are
loaded), commit, and return per-table deleted counts. They are idempotent: a
second call over the same (now-empty) period deletes nothing and returns zeros.

Anomaly scoping is dual because ``metric``-scope catalog anomalies are
project-global with a ``NULL`` ``scan_config_id`` and are keyed by ``scope_ref``
(the ``MetricDefinition`` id), mirroring
``worker/tasks/metrics/signals.py``:
    (scan_config_id IN project's scan_configs)
    OR (scan_config_id IS NULL AND scope_type = 'metric'
        AND scope_ref IN project's metric-definition ids)
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute
from sqlalchemy.sql.elements import ColumnElement

from tripl.core.analyzers.anomaly_detector import SCOPE_METRIC
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift


async def _count_or_delete(
    session: AsyncSession,
    model: type[object],
    conditions: list[ColumnElement[bool]],
    *,
    dry_run: bool,
) -> int:
    """Delete the rows matching *conditions*, or only count them on a dry run.

    One filter feeds both statements, so the preview can never describe a
    different set of rows than the delete would remove.
    """
    if dry_run:
        count = await session.execute(select(func.count()).select_from(model).where(*conditions))
        return int(count.scalar() or 0)
    result = await session.execute(
        delete(model).where(*conditions).execution_options(synchronize_session=False)
    )
    return int(getattr(result, "rowcount", 0) or 0)


def _period_conditions(
    column: InstrumentedAttribute[datetime],
    *,
    before: datetime | None,
    after: datetime | None,
) -> list[ColumnElement[bool]]:
    """Half-open period filter on *column*: ``after <= column < before``.

    Both bounds are optional; passing neither deletes across all time.
    """
    conditions: list[ColumnElement[bool]] = []
    if after is not None:
        conditions.append(column >= after)
    if before is not None:
        conditions.append(column < before)
    return conditions


async def reset_project_anomalies(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    before: datetime | None,
    after: datetime | None,
    dry_run: bool = False,
) -> dict[str, int]:
    """Delete every metric + breakdown anomaly in *project_id* within the period.

    Returns per-table deleted counts. Commits; idempotent.
    """
    project_scan_configs = select(ScanConfig.id).where(ScanConfig.project_id == project_id)
    # ``scope_ref`` stores ``str(metric_definition_id)`` (see signals.py); load the
    # ids and format them the same way so the comparison matches regardless of how
    # UUIDs are stored on the backing dialect.
    metric_scope_refs = [
        str(metric_id)
        for metric_id in (
            await session.execute(
                select(MetricDefinition.id).where(MetricDefinition.project_id == project_id)
            )
        )
        .scalars()
        .all()
    ]

    anomaly_scope = or_(
        MetricAnomaly.scan_config_id.in_(project_scan_configs),
        and_(
            MetricAnomaly.scan_config_id.is_(None),
            MetricAnomaly.scope_type == SCOPE_METRIC,
            MetricAnomaly.scope_ref.in_(metric_scope_refs),
        ),
    )
    anomaly_count = await _count_or_delete(
        session,
        MetricAnomaly,
        [anomaly_scope, *_period_conditions(MetricAnomaly.bucket, before=before, after=after)],
        dry_run=dry_run,
    )

    # Breakdown anomalies always carry a non-NULL ``scan_config_id`` (metric-scope
    # rows have no breakdowns), so scan-config scoping is complete on its own.
    breakdown_count = await _count_or_delete(
        session,
        MetricBreakdownAnomaly,
        [
            MetricBreakdownAnomaly.scan_config_id.in_(
                select(ScanConfig.id).where(ScanConfig.project_id == project_id)
            ),
            *_period_conditions(MetricBreakdownAnomaly.bucket, before=before, after=after),
        ],
        dry_run=dry_run,
    )

    if not dry_run:
        await session.commit()
    return {
        "metric_anomalies": anomaly_count,
        "metric_breakdown_anomalies": breakdown_count,
    }


async def reset_project_drifts(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    before: datetime | None,
    after: datetime | None,
    dry_run: bool = False,
) -> dict[str, int]:
    """Delete schema + distribution drifts in *project_id* within the period.

    Schema drifts filter ``detected_at``; distribution drifts filter ``bucket``.
    Schema drifts are scoped via their event type, including rows whose deleted
    scan config left ``scan_config_id`` null. Distribution drifts are scoped via
    the project's scan configs. Returns per-table deleted counts. Commits;
    idempotent.
    """
    schema_count = await _count_or_delete(
        session,
        SchemaDrift,
        [
            SchemaDrift.event_type_id.in_(
                select(EventType.id).where(EventType.project_id == project_id)
            ),
            *_period_conditions(SchemaDrift.detected_at, before=before, after=after),
        ],
        dry_run=dry_run,
    )
    distribution_count = await _count_or_delete(
        session,
        DistributionDrift,
        [
            DistributionDrift.scan_config_id.in_(
                select(ScanConfig.id).where(ScanConfig.project_id == project_id)
            ),
            *_period_conditions(DistributionDrift.bucket, before=before, after=after),
        ],
        dry_run=dry_run,
    )

    if not dry_run:
        await session.commit()
    return {
        "schema_drifts": schema_count,
        "distribution_drifts": distribution_count,
    }

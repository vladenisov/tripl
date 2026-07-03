"""Project-wide, owner-only reset of stored detections (danger zone).

Two categories are cleared independently:

- **Anomalies** — ``metric_anomalies`` + ``metric_breakdown_anomalies``. Catalog
  monitoring signals (catalog/anomalies inbox) are *derived* from
  ``metric_anomalies`` rows, so deleting the anomalies clears the signals too;
  there is no separate signal table to touch.
- **Drifts** — ``schema_drifts`` + ``distribution_drifts``.

Both operations are destructive and irreversible. They use bulk
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

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute
from sqlalchemy.sql.elements import ColumnElement

from tripl.core.analyzers.anomaly_detector import SCOPE_METRIC
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift


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
    anomaly_result = await session.execute(
        delete(MetricAnomaly)
        .where(
            anomaly_scope,
            *_period_conditions(MetricAnomaly.bucket, before=before, after=after),
        )
        .execution_options(synchronize_session=False)
    )

    # Breakdown anomalies always carry a non-NULL ``scan_config_id`` (metric-scope
    # rows have no breakdowns), so scan-config scoping is complete on its own.
    breakdown_result = await session.execute(
        delete(MetricBreakdownAnomaly)
        .where(
            MetricBreakdownAnomaly.scan_config_id.in_(
                select(ScanConfig.id).where(ScanConfig.project_id == project_id)
            ),
            *_period_conditions(MetricBreakdownAnomaly.bucket, before=before, after=after),
        )
        .execution_options(synchronize_session=False)
    )

    await session.commit()
    return {
        "metric_anomalies": int(getattr(anomaly_result, "rowcount", 0) or 0),
        "metric_breakdown_anomalies": int(getattr(breakdown_result, "rowcount", 0) or 0),
    }


async def reset_project_drifts(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    before: datetime | None,
    after: datetime | None,
) -> dict[str, int]:
    """Delete schema + distribution drifts in *project_id* within the period.

    Schema drifts filter ``detected_at``; distribution drifts filter ``bucket``.
    Both are scoped via ``scan_config_id`` -> the project's scan configs. Returns
    per-table deleted counts. Commits; idempotent.
    """
    schema_result = await session.execute(
        delete(SchemaDrift)
        .where(
            SchemaDrift.scan_config_id.in_(
                select(ScanConfig.id).where(ScanConfig.project_id == project_id)
            ),
            *_period_conditions(SchemaDrift.detected_at, before=before, after=after),
        )
        .execution_options(synchronize_session=False)
    )
    distribution_result = await session.execute(
        delete(DistributionDrift)
        .where(
            DistributionDrift.scan_config_id.in_(
                select(ScanConfig.id).where(ScanConfig.project_id == project_id)
            ),
            *_period_conditions(DistributionDrift.bucket, before=before, after=after),
        )
        .execution_options(synchronize_session=False)
    )

    await session.commit()
    return {
        "schema_drifts": int(getattr(schema_result, "rowcount", 0) or 0),
        "distribution_drifts": int(getattr(distribution_result, "rowcount", 0) or 0),
    }

from __future__ import annotations

import uuid

from sqlalchemy import Float, ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import MetricScopeType
from tripl.models.enum_types import db_enum

# The false-positive ratchet: one inbox click makes the detector stricter on the
# scope that produced the alert. Kept here (rather than in the alerting service)
# because detection is the only consumer and these bounds define the stored
# values, not the request that writes them.
#
# Arithmetic preserved verbatim from the project-wide ratchet it replaces, so an
# instance that has already been tuned keeps ratcheting in the same steps:
#   sigma  -> min(max(current, 3.0) + 0.5, 10.0)
#   count  -> min(max(current + 5, 10), 1000)
# Note the count FLOOR is applied after the step, matching the original.
RATCHET_SIGMA_STEP = 0.5
RATCHET_SIGMA_FLOOR = 3.0
RATCHET_SIGMA_CAP = 10.0
RATCHET_MIN_COUNT_STEP = 5
RATCHET_MIN_COUNT_FLOOR = 10
RATCHET_MIN_COUNT_CAP = 1000

# The scopes a ratchet can act on: the ones whose detection actually reads
# ``sigma_threshold`` / ``min_expected_count`` in ``detect_anomalies``. The drift
# and release-regression scopes also reach the inbox, but they are scored by PSI
# / drift / regression models that never look at these two knobs — ratcheting on
# them used to silently make unrelated VOLUME detection stricter across the whole
# project, which is exactly the over-reach this table removes.
RATCHETABLE_SCOPE_TYPES = frozenset(
    {
        MetricScopeType.project_total.value,
        MetricScopeType.event_type.value,
        MetricScopeType.event.value,
        MetricScopeType.metric.value,
    }
)


def ratchet_sigma_threshold(current: float | None) -> float:
    return min(
        max(float(current or RATCHET_SIGMA_FLOOR), RATCHET_SIGMA_FLOOR) + RATCHET_SIGMA_STEP,
        RATCHET_SIGMA_CAP,
    )


def ratchet_min_expected_count(current: int | None) -> int:
    return min(
        max(int(current or 0) + RATCHET_MIN_COUNT_STEP, RATCHET_MIN_COUNT_FLOOR),
        RATCHET_MIN_COUNT_CAP,
    )


class AnomalyScopeOverride(UUIDMixin, TimestampMixin, Base):
    """Per-scope detector sensitivity, written by the false-positive ratchet.

    Keyed exactly the way an anomaly keys itself — ``(scan_config_id,
    scope_type, scope_ref)``, mirroring ``MetricAnomaly`` — because that is the
    only key the detection loops can honour. ``scan_config_id`` is NULL for
    ``metric``-scope rows (catalog metric series are project-global and carry a
    NULL config on ``MetricAnomaly`` too), even though the ALERT DELIVERY that
    produced the click is always attributed to some scan config.

    Overrides are ABSOLUTE values, not deltas off the project settings: the
    ratchet is permanent and does not decay, and the number an operator sees in
    Detection settings is absolute, so the override speaks the same vocabulary.
    Deleting the row is the undo — the scope falls straight back to the
    project-wide setting.
    """

    __tablename__ = "anomaly_scope_overrides"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            name="uq_anomaly_scope_override_scope",
        ),
        # SQL treats NULLs as DISTINCT, so the composite constraint above never
        # fires for ``metric``-scope rows (NULL scan_config_id) and two clicks on
        # the same metric would insert twice. This partial unique index excludes
        # the NULL column and only covers the NULL space, exactly as
        # ``uq_metric_anomaly_metric_scope`` does for MetricAnomaly.
        Index(
            "uq_anomaly_scope_override_metric_scope",
            "project_id",
            "scope_type",
            "scope_ref",
            unique=True,
            postgresql_where=text("scan_config_id IS NULL"),
            sqlite_where=text("scan_config_id IS NULL"),
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    # NULL for ``metric`` scope (project-global catalog series). Every other
    # scope partitions by config, like the anomaly rows themselves.
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
        nullable=True,
    )
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    # Human label captured at ratchet time so Detection settings can name the
    # scope without joining events / event types / metric definitions, and so a
    # deleted event still reads as something other than a bare UUID.
    scope_name: Mapped[str] = mapped_column(String(255), default="", server_default="")
    sigma_threshold: Mapped[float] = mapped_column(Float)
    min_expected_count: Mapped[int] = mapped_column(Integer)
    false_positive_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin
from tripl.models.domain_enums import MetricScopeType, ReleaseRegressionKind
from tripl.models.enum_types import db_enum


class ReleaseRegression(UUIDMixin, Base):
    """A detected per-release regression for an event (or event type).

    Captures that, relative to the previous active release, an event either
    disappeared (``kind = "missing"``) or fired materially less than its
    previous-release composition would predict (``kind = "volume_drop"``). One
    row per (scan, scope, new release); recomputed in full on every scan.

    The model itself — maturity gate, comparison window, composition-share
    normalization, and the missing/volume_drop split — is stated in
    ``tripl.core.analyzers.release_regression``, which implements it.
    """

    __tablename__ = "release_regressions"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "version",
            name="uq_release_regression_scope_version",
        ),
        Index(
            "ix_release_regression_scan_scope",
            "scan_config_id",
            "scope_type",
            "scope_ref",
        ),
        Index("ix_release_regression_event", "event_id"),
        Index("ix_release_regression_event_type", "event_type_id"),
    )

    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"),
        nullable=True,
    )
    app_version_column: Mapped[str] = mapped_column(String(255))
    version: Mapped[str] = mapped_column(String(500))  # the release under test (v_new)
    previous_version: Mapped[str] = mapped_column(String(500))  # baseline release (v_prev)
    kind: Mapped[str] = mapped_column(db_enum(ReleaseRegressionKind, "release_regression_kind"))
    observed_count: Mapped[int] = mapped_column(BigInteger)
    expected_count: Mapped[float] = mapped_column(Float)
    ratio: Mapped[float] = mapped_column(Float)
    share_prev: Mapped[float] = mapped_column(Float)
    share_new: Mapped[float] = mapped_column(Float)
    release_share: Mapped[float] = mapped_column(Float)
    window_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    window_to: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

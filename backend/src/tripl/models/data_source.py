from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.scan_config import ScanConfig


class DBType(enum.StrEnum):
    clickhouse = "clickhouse"
    postgres = "postgres"


class TestStatus(enum.StrEnum):
    success = "success"
    failed = "failed"


class DataSource(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "data_sources"
    __table_args__ = (UniqueConstraint("name", name="uq_data_source_name"),)

    name: Mapped[str] = mapped_column(String(255))
    db_type: Mapped[str] = mapped_column(String(20))  # clickhouse, bigquery, ...
    host: Mapped[str] = mapped_column(String(500))
    port: Mapped[int] = mapped_column(Integer, default=8123)
    database_name: Mapped[str] = mapped_column(String(255))
    username: Mapped[str] = mapped_column(String(255), default="")
    password_encrypted: Mapped[str] = mapped_column(Text, default="")
    extra_params: Mapped[dict[str, object] | None] = mapped_column(sa.JSON, nullable=True)

    last_test_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    last_test_status: Mapped[str | None] = mapped_column(String(16), nullable=True, default=None)
    last_test_message: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)

    scan_configs: Mapped[list[ScanConfig]] = relationship(
        back_populates="data_source", cascade="all, delete-orphan", lazy="selectin"
    )

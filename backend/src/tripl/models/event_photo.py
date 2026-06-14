from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import EventPhotoKind, EventPhotoStorageBackend
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.event import Event


class EventPhoto(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "event_photos"
    __table_args__ = (Index("ix_event_photo_event_order", "event_id", "sort_order"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    uploaded_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    original_filename: Mapped[str] = mapped_column(String(500), default="")
    content_type: Mapped[str] = mapped_column(String(120), default="")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)

    # Attachment shape. "photo" rows have storage_backend/storage_key populated
    # and no external_url; "figma" rows store the embed URL and leave the
    # storage_* columns NULL (no blob is uploaded).
    kind: Mapped[str] = mapped_column(
        db_enum(EventPhotoKind, "event_photo_kind"),
        default=EventPhotoKind.photo.value,
        server_default=EventPhotoKind.photo.value,
    )
    external_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)

    # "local" or "gcs" — drives URL resolution and delete behavior. NULL for
    # figma-kind rows that have no uploaded blob.
    storage_backend: Mapped[str | None] = mapped_column(
        db_enum(EventPhotoStorageBackend, "event_photo_storage_backend"), nullable=True
    )
    # Relative key under the configured storage root. Same shape for both
    # backends, e.g. "events/<event_id>/<photo_id>.jpg".
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    event: Mapped[Event] = relationship(lazy="selectin")

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class EventPhotoComment(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "event_photo_comments"

    photo_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("event_photos.id", ondelete="CASCADE"))
    # Self-FK for threaded replies. NULL = top-level comment.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_photo_comments.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    body: Mapped[str] = mapped_column(Text)

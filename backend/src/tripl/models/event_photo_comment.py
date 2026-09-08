from __future__ import annotations

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class EventPhotoComment(UUIDMixin, TimestampMixin, Base):
    """A threaded comment, anchored either on one attachment or on the event.

    One table for both because they are the same object: threaded, authored,
    plain text, and deliberately NOT plan content — no snapshot, no approval
    hash, no search index, nothing that reaches whoever implements the event.
    An event-anchored row is the discussion the analyst asked for ("not a
    Title and not a Description — it raises something"); a photo-anchored row
    is the same conversation pinned to one frame.

    Exactly one anchor is set. ``photo_id`` had to become nullable for that,
    which is also why every query meaning "the attachment threads" filters on
    ``photo_id`` rather than reading the whole table: an event thread must stay
    out of ``build_plan_snapshot``, out of the branch deep copy, and out of the
    merge carry-back.
    """

    __tablename__ = "event_photo_comments"
    __table_args__ = (
        CheckConstraint(
            "(photo_id IS NULL) <> (event_id IS NULL)",
            name="ck_event_photo_comment_one_anchor",
        ),
        Index("ix_event_photo_comment_event", "event_id"),
    )

    photo_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_photos.id", ondelete="CASCADE"), nullable=True
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=True
    )
    # Self-FK for threaded replies. NULL = top-level comment.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_photo_comments.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    body: Mapped[str] = mapped_column(Text)

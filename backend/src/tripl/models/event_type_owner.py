from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class EventTypeOwner(UUIDMixin, TimestampMixin, Base):
    """A user who owns (is responsible for) an event type on the live plan.

    Owners gate plan-branch merges: a branch that touches an owned event type
    requires an approval from at least one of its owners. Rows live on main
    event types only — when a branch is created, owners are not deep-copied
    (this is runtime metadata, not part of the design canvas).
    """

    __tablename__ = "event_type_owners"
    __table_args__ = (
        UniqueConstraint("event_type_id", "user_id", name="uq_event_type_owner"),
    )

    event_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("event_types.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

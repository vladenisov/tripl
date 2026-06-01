from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class PlanBranchComment(UUIDMixin, TimestampMixin, Base):
    """Threaded discussion on a branch (review notes)."""

    __tablename__ = "plan_branch_comments"
    __table_args__ = (Index("ix_plan_branch_comment_branch", "branch_id"),)

    branch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plan_branches.id", ondelete="CASCADE"))
    # Self-FK for threaded replies. NULL = top-level comment.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("plan_branch_comments.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text)

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class PlanBranchReviewer(UUIDMixin, TimestampMixin, Base):
    """A user assigned to review a working branch (intent, not an approval)."""

    __tablename__ = "plan_branch_reviewers"
    __table_args__ = (UniqueConstraint("branch_id", "user_id", name="uq_plan_branch_reviewer"),)

    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class PlanBranchApproval(UUIDMixin, Base):
    """Records that a user approved a branch. Cleared when the branch goes back
    to draft/changes_requested so stale approvals don't gate a later merge."""

    __tablename__ = "plan_branch_approvals"
    __table_args__ = (
        UniqueConstraint("branch_id", "user_id", name="uq_plan_branch_approval"),
    )

    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

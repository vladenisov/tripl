from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class ProjectBranchSettings(UUIDMixin, Base):
    """Per-project merge policy for plan branches.

    ``min_approvals`` is the number of distinct user approvals a branch needs
    before it may merge (1 matches the historical behavior: the approve
    transition itself records one approval). ``block_self_approval`` stops the
    branch author from approving their own branch — off by default so
    single-user projects keep a working merge flow.
    """

    __tablename__ = "project_branch_settings"
    __table_args__ = (UniqueConstraint("project_id", name="uq_project_branch_settings_project"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    min_approvals: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    block_self_approval: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
    )

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class ProjectTrackerConfig(UUIDMixin, Base):
    """Per-project issue-tracker integration (Jira for v1).

    Kept separate from the alerting destinations so a project can wire branch →
    implementation-ticket automation without touching its alert channels.
    ``tracker_type`` is retained for a future Linear backend. Owner-gated because
    it stores an API token and drives outbound ticket creation. Like
    ``ProjectBranchSettings`` the row is only materialized on the first PATCH, so
    a project without a config simply rides the defaults.
    """

    __tablename__ = "project_tracker_configs"
    __table_args__ = (UniqueConstraint("project_id", name="uq_project_tracker_config_project"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    tracker_type: Mapped[str] = mapped_column(String, default="jira", server_default="jira")
    base_url: Mapped[str] = mapped_column(String, default="", server_default="")
    project_key: Mapped[str] = mapped_column(String, default="", server_default="")
    auth_email: Mapped[str] = mapped_column(String, default="", server_default="")
    api_token_encrypted: Mapped[str] = mapped_column(String, default="", server_default="")
    issue_type: Mapped[str] = mapped_column(String, default="Task", server_default="Task")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
    )

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class ApiKey(UUIDMixin, TimestampMixin, Base):
    """Long-lived bearer token a user can give to non-browser clients.

    Two scopes are supported in v1:
      - ``read``  — GET endpoints only; write surfaces return 403.
      - ``write`` — full editor-level access (subject to the user's role).

    Orthogonal to scope, a key may be bound to a single project via
    ``project_id``. A bound key only authenticates ``/projects/{slug}/...``
    routes for that project; any other project (or a non-project route) is
    rejected with 403. ``project_id`` is ``NULL`` for unscoped keys, which
    keep full cross-project access — that's the legacy default.

    The raw secret is shown to the operator exactly once at creation. Only
    ``key_hash`` (sha-256 of the raw string) is stored; the displayed
    ``key_prefix`` is a short non-secret slice the UI can show in a list so
    operators recognise the key without exposing it.
    """

    __tablename__ = "api_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(100))
    key_prefix: Mapped[str] = mapped_column(String(20), index=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scope: Mapped[str] = mapped_column(String(20))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

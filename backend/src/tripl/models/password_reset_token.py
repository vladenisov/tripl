from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UtcDateTime, UUIDMixin


class PasswordResetToken(UUIDMixin, TimestampMixin, Base):
    """Single-use, time-limited handle for the self-service password reset flow.

    The raw token is **never** stored — only its keyed HMAC-SHA256 digest
    (``auth_utils.hash_session_token``, 64-char hex), exactly like
    ``UserSession.session_token_hash``. A leaked column is therefore useless
    without ``SECRET_KEY``. ``used_at`` enforces single use and doubles as an
    audit marker; cleanup of a user's other outstanding tokens relies on the
    ``ON DELETE CASCADE`` foreign key plus explicit deletes in the service.
    """

    __tablename__ = "password_reset_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime(), index=True)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

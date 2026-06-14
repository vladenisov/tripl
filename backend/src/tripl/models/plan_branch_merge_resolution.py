from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import MergeResolutionChoice
from tripl.models.enum_types import db_enum


class PlanBranchMergeResolution(UUIDMixin, TimestampMixin, Base):
    """A per-field resolution captured during inline 3-way conflict review.

    When the same field of the same entity (event_type for now) is changed on
    both main (ours) and the branch (theirs) since the branch's base snapshot,
    the merge can't pick one automatically. The reviewer records a choice on
    each conflicted field — ``ours`` or ``theirs`` — and the merge engine
    applies the picks instead of blanket "branch wins".

    Cleared automatically on transitions that invalidate review state
    (submit/request_changes/reopen) so a re-opened branch starts a fresh round.
    """

    __tablename__ = "plan_branch_merge_resolutions"
    __table_args__ = (
        UniqueConstraint(
            "branch_id",
            "entity_type",
            "entity_name",
            "field_name",
            name="uq_plan_branch_merge_resolution",
        ),
    )

    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True
    )
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_name: Mapped[str] = mapped_column(String(255))
    field_name: Mapped[str] = mapped_column(String(80))
    # "ours" = keep main's value (do not apply the branch change for this field)
    # "theirs" = take the branch's value (default merge behavior)
    choice: Mapped[str] = mapped_column(db_enum(MergeResolutionChoice, "merge_resolution_choice"))
    # Reserved for future custom-value resolutions. Not used by the v1 engine.
    custom_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

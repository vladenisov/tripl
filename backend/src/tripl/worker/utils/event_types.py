"""Resolve (and, when absent, create) the EventType a scanned group writes into.

Lives here rather than in ``worker.tasks.metrics.generation`` because the scan
task needs it too, and importing a metrics task module for one pure helper would
drag the whole ``collect_metrics`` task graph into ``worker.tasks.scan``'s import
path — the same reasoning that put ``reserved_columns`` in this package.

Both grouped paths go through this one function so that a manual **Run** and a
scheduled collection leave the catalog in the same state. Before tripl-0zpq.45
only the scheduled path created: a manual grouped run merely *looked up* the
event type by name and skipped the group when it was missing, so a Catalog-only
config — which by definition never reaches the scheduler — created zero events
forever, while the dry run cheerfully promised the type "would be added".
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.core.adapters.base import ColumnInfo
from tripl.core.analyzers.cardinality import _is_json_type
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.worker.plan_scope import main_branch_id

logger = logging.getLogger(__name__)


def ensure_event_type_with_fields(
    session: Session,
    project_id: uuid.UUID,
    et_name: str,
    columns: list[ColumnInfo],
    skip_columns: set[str],
) -> EventType:
    """Find or auto-create an EventType with FieldDefinitions for all columns."""
    # Scans and metrics collection target the main plan; a working branch
    # deep-copies event types under the same names, so the lookup must be
    # branch-scoped — and the created row must land on main, which it does
    # because ``EventType.branch_id``'s column default resolves to it.
    et = session.execute(
        select(EventType).where(
            EventType.project_id == project_id,
            EventType.branch_id == main_branch_id(session, project_id),
            EventType.name == et_name,
        )
    ).scalar_one_or_none()

    if et is None:
        et = EventType(
            id=uuid.uuid4(),
            project_id=project_id,
            name=et_name,
            display_name=et_name,
            description="Auto-created from metrics collection",
        )
        session.add(et)
        session.flush()
        logger.info(f"Auto-created event type {et_name!r}")

    existing_fds = {fd.name for fd in et.field_definitions}
    for col in columns:
        if col.name in skip_columns:
            continue
        if col.name in existing_fds:
            continue
        fd = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=et.id,
            name=col.name,
            display_name=col.name,
            field_type="json" if _is_json_type(col.type_name) else "string",
            is_required=False,
            description=f"Auto-created ({col.type_name})",
        )
        session.add(fd)

    session.flush()
    session.refresh(et)
    return et

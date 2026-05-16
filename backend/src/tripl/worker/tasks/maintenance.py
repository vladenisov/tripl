"""Periodic housekeeping for storage-bound tables.

Currently: prune SchemaDrift rows past their retention horizon. The drift
table only re-upserts rows that still represent live drift, so anything
older than DRIFT_RETENTION_DAYS no longer corresponds to anything the
catalog should surface.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session

from tripl.models.schema_drift import SchemaDrift
from tripl.services.schema_drift_service import DRIFT_RETENTION_DAYS
from tripl.worker.celery_app import celery_app
from tripl.worker.db import SyncSessionLocal

logger = logging.getLogger(__name__)


def _get_sync_session() -> Session:
    return SyncSessionLocal()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.maintenance.cleanup_schema_drifts",
)
def cleanup_schema_drifts() -> dict[str, object]:
    cutoff = datetime.now(UTC) - timedelta(days=DRIFT_RETENTION_DAYS)
    session = _get_sync_session()
    try:
        result = session.execute(delete(SchemaDrift).where(SchemaDrift.detected_at < cutoff))
        session.commit()
        deleted = int(getattr(result, "rowcount", 0) or 0)
        logger.info("Pruned %d schema_drifts rows older than %s", deleted, cutoff.isoformat())
        return {"deleted": deleted, "cutoff": cutoff.isoformat()}
    finally:
        session.close()

import uuid
from datetime import datetime

from pydantic import BaseModel

from tripl.models.scan_job import ScanJobStatus


class ScanJobResponse(BaseModel):
    id: uuid.UUID
    scan_config_id: uuid.UUID
    status: ScanJobStatus
    started_at: datetime | None
    completed_at: datetime | None
    result_summary: dict[str, object] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScanPreviewJobResponse(BaseModel):
    id: uuid.UUID
    status: ScanJobStatus
    started_at: datetime | None
    completed_at: datetime | None
    # When status == "completed", holds the ScanConfigPreviewResponse payload
    # (columns / rows / json_columns); null while pending/running or on failure.
    result_summary: dict[str, object] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScanActivityItem(BaseModel):
    """One scan config's run activity, as the Scans list shows it."""

    scan_config_id: uuid.UUID
    # Newest job by ``created_at`` (ties broken by id), or None: never run.
    latest_job: ScanJobResponse | None
    # Consecutive failed runs, newest first, looking past queued and running
    # jobs, over the WHOLE history rather than a capped page of it. Both the
    # Scans list and a scan's detail page tag their "failed last N runs" with
    # it (each falls back to its own page's count while this is loading).
    failing_streak: int
    # Rows read by jobs that finished (or, still running, started) inside the
    # window: ``query_rows_scanned``, else ``scan_rows_processed``, per job.
    rows_read_24h: int


class ScanActivityResponse(BaseModel):
    """Per-scan activity for a project, aggregated in SQL (tripl-fj5g.11)."""

    window_from: datetime
    window_to: datetime
    items: list[ScanActivityItem]

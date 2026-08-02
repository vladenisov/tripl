import uuid
from datetime import datetime

from pydantic import BaseModel


class ImplementationTicketResponse(BaseModel):
    """One tracker ticket opened for a merged plan branch (read-only surface).

    Everything here is written by the merge/poll worker; the API never accepts
    a ticket from a client. ``external_url`` is ``""`` when the tracker replied
    without an issue key, so the UI must fall back to plain text rather than
    render a link to nowhere.
    """

    id: uuid.UUID
    project_id: uuid.UUID
    branch_id: uuid.UUID
    tracker_type: str
    external_id: str | None
    external_key: str | None
    external_url: str
    status: str
    summary: str
    event_ids: list[str]
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None

    model_config = {"from_attributes": True}

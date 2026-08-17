"""Plan-reality reconciliation: shadow event inbox, dead events, coverage."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.coverage_metric import CoverageMetric
from tripl.models.event import Event, EventStatus
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.models.shadow_event_candidate import (
    SHADOW_STATUS_ACCEPTED,
    SHADOW_STATUS_DISMISSED,
    SHADOW_STATUS_NEW,
    ShadowEventCandidate,
)
from tripl.schemas.event import EventBulkUpdate, EventCreate
from tripl.schemas.reconciliation import (
    CoverageBucket,
    CoverageResponse,
    CoverageSummary,
    DeadEventItem,
    DeadEventListResponse,
    ShadowEventAcceptRequest,
    ShadowEventAcceptResponse,
    ShadowEventCandidateResponse,
    ShadowEventDismissResponse,
    ShadowEventListResponse,
)
from tripl.services import event_service
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug

DEFAULT_DEAD_EVENT_DAYS = 30
DEFAULT_COVERAGE_DAYS = 14

# Terminal lifecycle states a dead event may be retired into. Kept here (rather
# than in tripl.schemas.reconciliation) so the bulk-archive request/response
# travel with the service that owns the behaviour.
_ARCHIVE_STATUSES = (EventStatus.deprecated, EventStatus.archived)


class DeadEventArchiveRequest(BaseModel):
    """Bulk-retire request for dead events.

    ``status`` is constrained to the two terminal lifecycle states so the
    action can only deprecate or archive — never resurrect — an event.
    """

    event_ids: list[uuid.UUID] = Field(min_length=1)
    status: EventStatus = EventStatus.archived

    @field_validator("status")
    @classmethod
    def _validate_terminal_status(cls, value: EventStatus) -> EventStatus:
        if value not in _ARCHIVE_STATUSES:
            raise ValueError("status must be 'archived' or 'deprecated'")
        return value


class DeadEventArchiveResponse(BaseModel):
    event_ids: list[uuid.UUID]
    status: EventStatus
    archived_count: int


def _not_an_archived_identity(project_id: uuid.UUID) -> ColumnElement[bool]:
    """Anti-join excluding candidates whose identity belongs to an archived event.

    Archiving means "put it away", so the identity is in the plan and by
    definition not an unmapped event. The collector stopped writing these
    (tripl-w3ms), but rows written before that shipped would otherwise sit in the
    inbox forever: accepting one only 409s on the duplicate source identity, so
    there is no way for the user to clear it. Deliberately not branch-scoped —
    this listing has no branch, and an event archived on any branch is still one
    somebody chose to retire.
    """
    return ~(
        select(Event.id)
        .where(
            Event.project_id == project_id,
            Event.status == EventStatus.archived,
            # `source_name or name`, matching how the collector builds the
            # archived identity set (generation.py
            # `_archived_identities_by_event_type`) and how `events_by_name` is
            # keyed. A hand-created event has no source_name, so comparing the
            # column alone silently failed to match exactly the rows a user is
            # most likely to archive by hand: the two halves of one rule have to
            # agree, or the inbox keeps showing a candidate the collector has
            # already stopped writing.
            func.coalesce(Event.source_name, Event.name) == ShadowEventCandidate.event_name,
        )
        .exists()
    )


async def list_shadow_events(
    session: AsyncSession,
    slug: str,
    *,
    status: str | None = None,
    limit: int = 100,
) -> ShadowEventListResponse:
    project_id = await get_project_id_by_slug(session, slug)
    not_archived = _not_an_archived_identity(project_id)

    query = (
        # display_name is what every other surface labels an event type with
        # (activity_service.py:76, alert_payload.py:58) — projecting the internal
        # `name` here made Reconciliation the odd one out (tripl-w9od).
        select(
            ShadowEventCandidate,
            ScanConfig.name,
            func.coalesce(EventType.display_name, EventType.name),
        )
        .join(ScanConfig, ScanConfig.id == ShadowEventCandidate.scan_config_id)
        .outerjoin(EventType, EventType.id == ShadowEventCandidate.event_type_id)
        .where(ShadowEventCandidate.project_id == project_id, not_archived)
        .order_by(ShadowEventCandidate.observed_count.desc())
        .limit(limit)
    )
    if status:
        query = query.where(ShadowEventCandidate.status == status)

    rows = (await session.execute(query)).all()
    total = (
        await session.scalar(
            select(func.count(ShadowEventCandidate.id)).where(
                ShadowEventCandidate.project_id == project_id,
                not_archived,
                *((ShadowEventCandidate.status == status,) if status else ()),
            )
        )
    ) or 0
    new_count = (
        await session.scalar(
            select(func.count(ShadowEventCandidate.id)).where(
                ShadowEventCandidate.project_id == project_id,
                ShadowEventCandidate.status == SHADOW_STATUS_NEW,
                not_archived,
            )
        )
    ) or 0

    items = [
        ShadowEventCandidateResponse(
            id=candidate.id,
            scan_config_id=candidate.scan_config_id,
            scan_config_name=scan_name,
            event_type_id=candidate.event_type_id,
            event_type_name=event_type_name,
            event_name=candidate.event_name,
            observed_count=candidate.observed_count,
            first_seen_at=candidate.first_seen_at,
            last_seen_at=candidate.last_seen_at,
            status=candidate.status,
            accepted_event_id=candidate.accepted_event_id,
        )
        for candidate, scan_name, event_type_name in rows
    ]
    return ShadowEventListResponse(items=items, total=int(total), new_count=int(new_count))


async def _get_candidate(
    session: AsyncSession,
    project_id: uuid.UUID,
    candidate_id: uuid.UUID,
) -> ShadowEventCandidate:
    candidate = await session.scalar(
        select(ShadowEventCandidate).where(
            ShadowEventCandidate.id == candidate_id,
            ShadowEventCandidate.project_id == project_id,
        )
    )
    if candidate is None:
        raise HTTPException(status_code=404, detail="Shadow event candidate not found")
    return candidate


async def accept_shadow_event(
    session: AsyncSession,
    slug: str,
    candidate_id: uuid.UUID,
    data: ShadowEventAcceptRequest,
    *,
    user_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> ShadowEventAcceptResponse:
    project_id = await get_project_id_by_slug(session, slug)
    candidate = await _get_candidate(session, project_id, candidate_id)
    if candidate.status != SHADOW_STATUS_NEW:
        raise HTTPException(
            status_code=409,
            detail=f"Candidate already {candidate.status}",
        )

    event_type_id = data.event_type_id or candidate.event_type_id
    if event_type_id is None:
        raise HTTPException(
            status_code=422,
            detail="event_type_id is required: the candidate has no detected event type",
        )

    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    existing = await session.scalar(
        select(Event.id).where(
            Event.project_id == project_id,
            Event.branch_id == resolved_branch_id,
            Event.source_name == candidate.event_name,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="An event with this source identity already exists (possibly archived)",
        )

    event = await event_service.create_event(
        session,
        slug,
        EventCreate(
            event_type_id=event_type_id,
            name=data.name or candidate.event_name,
            status="live",
        ),
        branch_id=branch_id,
    )
    # The scan identity is what the metrics collector matches on — without it
    # the accepted event would never attach to warehouse data.
    event.source_name = candidate.event_name

    candidate.status = SHADOW_STATUS_ACCEPTED
    candidate.accepted_event_id = event.id
    candidate.resolved_by = user_id
    candidate.resolved_at = datetime.now(UTC)
    await session.commit()

    return ShadowEventAcceptResponse(
        candidate_id=candidate.id,
        event_id=event.id,
        status=SHADOW_STATUS_ACCEPTED,
    )


async def dismiss_shadow_event(
    session: AsyncSession,
    slug: str,
    candidate_id: uuid.UUID,
    *,
    user_id: uuid.UUID,
) -> ShadowEventDismissResponse:
    project_id = await get_project_id_by_slug(session, slug)
    candidate = await _get_candidate(session, project_id, candidate_id)
    if candidate.status != SHADOW_STATUS_NEW:
        raise HTTPException(
            status_code=409,
            detail=f"Candidate already {candidate.status}",
        )

    candidate.status = SHADOW_STATUS_DISMISSED
    candidate.resolved_by = user_id
    candidate.resolved_at = datetime.now(UTC)
    await session.commit()

    return ShadowEventDismissResponse(
        candidate_id=candidate.id,
        status=SHADOW_STATUS_DISMISSED,
    )


async def list_dead_events(
    session: AsyncSession,
    slug: str,
    *,
    days: int = DEFAULT_DEAD_EVENT_DAYS,
) -> DeadEventListResponse:
    project_id = await get_project_id_by_slug(session, slug)
    main_branch_id = await resolve_branch_id(session, project_id, None)
    cutoff = datetime.now(UTC) - timedelta(days=days)

    rows = (
        await session.execute(
            select(Event, func.coalesce(EventType.display_name, EventType.name))
            .join(EventType, EventType.id == Event.event_type_id)
            .where(
                Event.project_id == project_id,
                Event.branch_id == main_branch_id,
                Event.status.in_(["implemented", "live"]),
                # An event that HAS been seen and then went quiet is dead
                # regardless of when its plan row was written. The grace period
                # covers only the never-seen case, where a freshly authored
                # event legitimately has no data yet. Gating both cases on
                # created_at hid genuinely stale events behind a young plan row
                # and made every backdated demo event permanently unflaggable
                # (tripl-jfm3.58).
                (
                    (Event.last_seen_at.is_(None) & (Event.created_at < cutoff))
                    | (Event.last_seen_at < cutoff)
                ),
            )
            .order_by(Event.last_seen_at.asc().nulls_first(), Event.name)
        )
    ).all()

    items = [
        DeadEventItem(
            event_id=event.id,
            name=event.name,
            event_type_id=event.event_type_id,
            event_type_name=event_type_name,
            last_seen_at=event.last_seen_at,
            created_at=event.created_at,
        )
        for event, event_type_name in rows
    ]
    return DeadEventListResponse(items=items, total=len(items), days=days)


async def archive_dead_events(
    session: AsyncSession,
    slug: str,
    data: DeadEventArchiveRequest,
    *,
    user_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> DeadEventArchiveResponse:
    """Bulk-retire dead events into a terminal lifecycle state.

    Delegates to the canonical ``event_service.bulk_update_events`` status path:
    it resolves the branch, asserts every id belongs to it (404 otherwise),
    records change history, reindexes search and busts the project cache inside a
    single transaction. ``status`` is already validated to be deprecated/archived
    by ``DeadEventArchiveRequest``.
    """
    # Dedup while preserving order so a repeated id is counted (and echoed) once.
    unique_ids = list(dict.fromkeys(data.event_ids))
    await event_service.bulk_update_events(
        session,
        slug,
        EventBulkUpdate(event_ids=unique_ids, status=data.status),
        branch_id=branch_id,
        user_id=user_id,
    )
    return DeadEventArchiveResponse(
        event_ids=unique_ids,
        status=data.status,
        archived_count=len(unique_ids),
    )


async def get_coverage(
    session: AsyncSession,
    slug: str,
    *,
    days: int = DEFAULT_COVERAGE_DAYS,
    scan_config_id: uuid.UUID | None = None,
) -> CoverageResponse:
    project_id = await get_project_id_by_slug(session, slug)
    time_from = datetime.now(UTC) - timedelta(days=days)

    query = (
        select(
            CoverageMetric.bucket,
            func.sum(CoverageMetric.total_count),
            func.sum(CoverageMetric.matched_count),
        )
        .join(ScanConfig, ScanConfig.id == CoverageMetric.scan_config_id)
        .where(
            ScanConfig.project_id == project_id,
            CoverageMetric.bucket >= time_from,
        )
        .group_by(CoverageMetric.bucket)
        .order_by(CoverageMetric.bucket)
    )
    if scan_config_id is not None:
        query = query.where(CoverageMetric.scan_config_id == scan_config_id)

    rows = (await session.execute(query)).all()
    items = [
        CoverageBucket(
            bucket=bucket,
            total_count=int(total or 0),
            matched_count=int(matched or 0),
        )
        for bucket, total, matched in rows
    ]
    total_sum = sum(item.total_count for item in items)
    matched_sum = sum(item.matched_count for item in items)
    coverage_pct = (matched_sum / total_sum * 100) if total_sum else 0.0
    return CoverageResponse(
        items=items,
        summary=CoverageSummary(
            total_count=total_sum,
            matched_count=matched_sum,
            coverage_pct=round(coverage_pct, 2),
        ),
        days=days,
    )

"""The discussion on an event: threaded, authored, and not part of the plan.

Every other text box on an event ships to whoever implements it — ``description``
is its own indexed search column, the catalog tooltip and a line in the Markdown
pasted into the ticket — so a question typed there arrives as if it were the
spec. This is the box for the question instead (tripl-h2sx.25).

Same table as the photo threads, a different anchor. Nothing here reaches
``build_plan_snapshot``, the branch deep copy, the merge, the approval hash or
the search index, because every one of those selects on ``photo_id``.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event import Event
from tripl.models.event_photo_comment import EventPhotoComment
from tripl.services._branch_counterparts import main_counterparts
from tripl.services.project_service import get_project_id_by_slug


async def thread_event(session: AsyncSession, slug: str, event_id: uuid.UUID) -> Event:
    """The row this event's discussion lives on: the main twin of a branch copy.

    An event has ONE discussion. Deep-copying it onto every branch would fork
    the conversation, and merging the forks back is exactly the machinery that
    turned a comment into an unmergeable branch (tripl-h2sx.28). Reading through
    to the twin — the tripl-kjhi.9 pattern, nothing written back — means a
    question raised on a branch is the same question main can answer.

    An event that exists only on a branch has no twin yet, so it keeps its own
    thread until the merge gives it a row on main.
    """
    project_id = await get_project_id_by_slug(session, slug)
    event = (
        await session.execute(
            select(Event).where(Event.id == event_id, Event.project_id == project_id)
        )
    ).scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    twins = await main_counterparts(session, project_id=project_id, events=[event])
    return twins.get(event.id, event)


async def list_comments(
    session: AsyncSession, slug: str, event_id: uuid.UUID
) -> list[EventPhotoComment]:
    event = await thread_event(session, slug, event_id)
    rows = await session.execute(
        select(EventPhotoComment)
        .where(EventPhotoComment.event_id == event.id)
        .order_by(EventPhotoComment.created_at.asc())
    )
    return list(rows.scalars().all())


async def create_comment(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    *,
    body: str,
    parent_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
) -> EventPhotoComment:
    event = await thread_event(session, slug, event_id)
    if parent_id is not None:
        parent = await session.get(EventPhotoComment, parent_id)
        if parent is None or parent.event_id != event.id:
            raise HTTPException(status_code=400, detail="parent_id must belong to this event")

    comment = EventPhotoComment(
        event_id=event.id,
        photo_id=None,
        parent_id=parent_id,
        user_id=user_id,
        body=body.strip(),
    )
    session.add(comment)
    await session.commit()
    await session.refresh(comment)
    return comment


async def delete_comment(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    comment_id: uuid.UUID,
) -> None:
    event = await thread_event(session, slug, event_id)
    comment = await session.get(EventPhotoComment, comment_id)
    if comment is None or comment.event_id != event.id:
        raise HTTPException(status_code=404, detail="Comment not found")
    await session.delete(comment)
    await session.commit()

"""The discussion on an event: threaded, authored, and not part of the plan.

Every other text box on an event ships to whoever implements it — ``description``
is its own indexed search column, the catalog tooltip and a line in the Markdown
pasted into the ticket — so a question typed there arrives as if it were the
spec. This is the box for the question instead (tripl-h2sx.25).

Same table as the photo threads, a different anchor. Nothing here reaches
``build_plan_snapshot``, the branch deep copy, the approval hash or the search
index, because every one of those selects on ``photo_id``. The merge does one
thing with it and only one: a thread hanging on a BRANCH row is moved to main —
onto the twin that row already reads through, else the row the merge gives the
event (``_move_event_threads_to_main``, tripl-0zpq.122).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import NamedTuple

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from tripl.models.event import Event
from tripl.models.event_photo_comment import (
    EVENT_COMMENT_STATUS_OPEN,
    EVENT_COMMENT_STATUS_RESOLVED,
    EVENT_COMMENT_STATUS_SNOOZED,
    EventPhotoComment,
)
from tripl.models.event_type import EventType
from tripl.schemas.event_photo import EventCommentActionRequest
from tripl.services._branch_counterparts import main_counterparts
from tripl.services.project_service import get_project_id_by_slug


class EventThread(NamedTuple):
    """Where an event's discussion is written, and every row it is read from."""

    # The row a NEW thread is anchored on: the main twin of a branch copy, else
    # the event itself.
    home: Event
    # ``home`` plus the event's own row. The two differ only for a branch row
    # that has a twin, and that row can still hold a thread of its own — one
    # started before main had the event (tripl-0zpq.122).
    anchors: frozenset[uuid.UUID]


async def event_thread(session: AsyncSession, slug: str, event_id: uuid.UUID) -> EventThread:
    """The rows this event's discussion lives on: the main twin of a branch copy.

    An event has ONE discussion. Deep-copying it onto every branch would fork
    the conversation, and merging the forks back is exactly the machinery that
    turned a comment into an unmergeable branch (tripl-h2sx.28). Reading through
    to the twin — the tripl-kjhi.9 pattern, nothing written back — means a
    question raised on a branch is the same question main can answer.

    An event that exists only on a branch has no twin yet, so it keeps its own
    thread until the merge moves it onto the row it gives the event on main.
    A twin can also appear WITHOUT a merge — a scan creates the main row for
    that identity, or someone authors it on main — and reading only the twin
    from then on hid every thread the branch row already held, the note typed
    at creation included (tripl-0zpq.122). So a branch row reads its own anchor
    as well as its twin's; it just never starts a new thread there once the
    twin exists.

    Main's own row reads only its own anchor: a question drafted on a branch
    main has not merged reaches main with the merge, like the rest of the
    branch.
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
    home = twins.get(event.id, event)
    return EventThread(home=home, anchors=frozenset({home.id, event.id}))


async def list_comments(
    session: AsyncSession, slug: str, event_id: uuid.UUID
) -> list[EventPhotoComment]:
    thread = await event_thread(session, slug, event_id)
    rows = await session.execute(
        select(EventPhotoComment)
        .where(EventPhotoComment.event_id.in_(list(thread.anchors)))
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
    thread = await event_thread(session, slug, event_id)
    anchor_id = thread.home.id
    if parent_id is not None:
        parent = await session.get(EventPhotoComment, parent_id)
        if parent is None or parent.event_id is None or parent.event_id not in thread.anchors:
            raise HTTPException(status_code=400, detail="parent_id must belong to this event")
        # A reply joins its parent's thread wherever that hangs, so a thread
        # stays on one anchor. Both bulk moves rely on that — the branch
        # merge's and ``_merge_event_into_group``'s, each one UPDATE by anchor —
        # and so does deleting a branch: whole threads go, not a parent on one
        # row with its answers stranded on another.
        #
        # Not a guarantee under concurrency. Nothing here waits for a merge of
        # this event's branch: while one is in flight, its uncommitted move has
        # already taken the parent to main but this read still sees it on the
        # branch row, so the reply lands there. Once the merge commits, the
        # question is on main and its answer on the branch row, which main does
        # not read and the branch's deletion takes with it (tripl-0zpq.290).
        anchor_id = parent.event_id

    comment = EventPhotoComment(
        event_id=anchor_id,
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
    thread = await event_thread(session, slug, event_id)
    comment = await session.get(EventPhotoComment, comment_id)
    if comment is None or comment.event_id not in thread.anchors:
        raise HTTPException(status_code=404, detail="Comment not found")
    await session.delete(comment)
    await session.commit()


def unanswered_clause(now: datetime | None = None) -> ColumnElement[bool]:
    """Top-level event threads that still want an answer.

    A LAPSED snooze counts as open again, and that is decided here at read time
    rather than written back by a sweeper: a stored flag would be wrong for
    exactly as long as it took the next job to run, and the whole point of the
    snooze is that nobody is watching the thread in the meantime.

    Replies are excluded: the thread is the unit that gets answered, so a
    three-reply conversation is one open question, not four.
    """
    moment = now or datetime.now(UTC)
    return and_(
        EventPhotoComment.event_id.is_not(None),
        EventPhotoComment.parent_id.is_(None),
        or_(
            EventPhotoComment.status == EVENT_COMMENT_STATUS_OPEN,
            and_(
                EventPhotoComment.status == EVENT_COMMENT_STATUS_SNOOZED,
                EventPhotoComment.snoozed_until <= moment,
            ),
        ),
    )


async def apply_comment_action(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    comment_id: uuid.UUID,
    data: EventCommentActionRequest,
    user_id: uuid.UUID | None,
) -> EventPhotoComment:
    """Resolve, snooze or reopen one thread.

    Refused on a reply (400): resolution belongs to the thread, and letting a
    reply carry its own would make "is this question answered" a question with
    several contradictory answers.
    """
    thread = await event_thread(session, slug, event_id)
    comment = await session.get(EventPhotoComment, comment_id)
    if comment is None or comment.event_id not in thread.anchors:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.parent_id is not None:
        raise HTTPException(
            status_code=400,
            detail="Only a top-level comment carries resolution state",
        )

    now = datetime.now(UTC)
    if data.action == "resolve":
        comment.status = EVENT_COMMENT_STATUS_RESOLVED
        comment.resolved_at = now
        comment.resolved_by = user_id
        comment.snoozed_until = None
    elif data.action == "snooze":
        comment.status = EVENT_COMMENT_STATUS_SNOOZED
        comment.snoozed_until = data.snoozed_until
        comment.resolved_at = None
        comment.resolved_by = user_id
    else:
        comment.status = EVENT_COMMENT_STATUS_OPEN
        comment.resolved_at = None
        comment.resolved_by = None
        comment.snoozed_until = None

    # OMITTED and EXPLICITLY NULL are different requests and only
    # ``model_fields_set`` tells them apart — the distinction schema_drift_service
    # had to learn the hard way, where assigning unconditionally erased a note an
    # earlier action had stored. Reopening still clears it: a reopened thread has
    # no resolution any more.
    if data.action == "reopen":
        comment.resolution_note = None
    elif "note" in data.model_fields_set:
        comment.resolution_note = data.note

    await session.commit()
    await session.refresh(comment)
    return comment


def _identity_column() -> ColumnElement[str]:
    """The scan identity as SQL: ``source_name`` where there is one, else ``name``.

    The same key ``_branch_counterparts._identity`` computes in Python, spelled
    for the database so a branch row can be paired with its main twin without
    loading either.
    """
    return func.coalesce(Event.source_name, Event.name)


async def events_with_open_questions(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    main_branch_id: uuid.UUID,
) -> set[uuid.UUID]:
    """Ids ON THIS BRANCH whose discussion has an unanswered thread.

    An event has ONE discussion, hanging on its main twin, so a branch listing
    cannot simply match comment rows against branch ids — the filter would come
    back empty on every branch and read as "no open questions" rather than as a
    question the filter cannot answer.

    Two small queries: the anchors that hold an open thread, then the branch rows
    that pair with them. The first set is bounded by how many questions people
    have actually left unanswered, not by the size of the catalog.
    """
    anchors = set(
        (
            await session.execute(
                # Joined to events for the project scope, not filtered afterwards:
                # the comment table spans every project on the instance, and an
                # unscoped set would put another project's threads into this
                # project's IN list.
                select(EventPhotoComment.event_id)
                .join(Event, Event.id == EventPhotoComment.event_id)
                .where(Event.project_id == project_id, unanswered_clause())
                .distinct()
            )
        )
        .scalars()
        .all()
    )
    if not anchors or branch_id == main_branch_id:
        # On main the anchor IS the row. A branch-only event also anchors its own
        # thread, which the union below keeps.
        return {anchor for anchor in anchors if anchor is not None}

    # Main's anchors only. Another branch's own row can hold a thread on the
    # same key — two branches each drafting "checkout:new_tap" — and matching
    # through it listed this branch's row under "has open questions" beside a
    # count of ?0, since that thread is no anchor of this row (tripl-0zpq.122).
    keys = (
        await session.execute(
            select(EventType.name, _identity_column())
            .select_from(Event)
            .join(EventType, EventType.id == Event.event_type_id)
            .where(Event.id.in_(anchors), Event.branch_id == main_branch_id)
        )
    ).all()
    if not keys:
        return {anchor for anchor in anchors if anchor is not None}
    branch_ids = (
        (
            await session.execute(
                select(Event.id)
                .select_from(Event)
                .join(EventType, EventType.id == Event.event_type_id)
                .where(
                    Event.project_id == project_id,
                    Event.branch_id == branch_id,
                    tuple_(EventType.name, _identity_column()).in_([tuple(k) for k in keys]),
                )
            )
        )
        .scalars()
        .all()
    )
    # Union, not replacement: an event that exists only on this branch has no
    # twin and keeps its own thread, and a thread started before the twin
    # existed stays on the branch row until the merge moves it. The key match
    # reaches the twin on main and the union the row's own anchor — the same
    # two anchors ``open_question_counts`` adds up (tripl-0zpq.122). Anchors
    # on other branches ride along in the set but never match a row listed
    # here, which is scoped to this branch.
    return set(branch_ids) | {anchor for anchor in anchors if anchor is not None}


async def open_question_counts(
    session: AsyncSession, *, project_id: uuid.UUID, events: Sequence[Event]
) -> dict[uuid.UUID, int]:
    """Event id → unanswered threads on its discussion, twin-aware.

    Counted over the same anchors ``event_thread`` reads: the twin's and the
    row's own. Counting the twin alone showed ?0 on a branch row that
    ``events_with_open_questions`` had just matched through its own anchor
    (tripl-0zpq.122).

    Page-sized: the twin lookup and the count are one round of queries over the
    rows being rendered, the same budget ``attach_main_last_seen`` spends.
    """
    if not events:
        return {}
    twins = await main_counterparts(session, project_id=project_id, events=events)
    anchors_by_event = {ev.id: {ev.id, twins.get(ev.id, ev).id} for ev in events}
    rows = (
        await session.execute(
            select(EventPhotoComment.event_id, func.count(EventPhotoComment.id))
            .where(
                EventPhotoComment.event_id.in_(
                    {anchor for anchors in anchors_by_event.values() for anchor in anchors}
                ),
                unanswered_clause(),
            )
            .group_by(EventPhotoComment.event_id)
        )
    ).all()
    by_anchor = {anchor: count for anchor, count in rows}
    return {
        event_id: sum(by_anchor.get(anchor, 0) for anchor in anchors)
        for event_id, anchors in anchors_by_event.items()
    }

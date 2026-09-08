"""The discussion anchored on an event rather than on one of its attachments.

Feedback item 4 (tripl-h2sx.25): "somewhere to write notes and comments — not a
Title, and not a Description, because it does not describe the event, it raises
something for discussion." The object already existed; only its anchor and its
surface were wrong.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.event import Event
from tripl.models.event_photo_comment import EventPhotoComment
from tripl.services.plan_revision_service import build_plan_snapshot
from tripl.tests.conftest import TestSessionLocal


async def _setup_event(client: AsyncClient, slug: str) -> str:
    project = await client.post(
        "/api/v1/projects", json={"name": slug, "slug": slug, "description": ""}
    )
    assert project.status_code == 201
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    assert et.status_code == 201
    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et.json()["id"], "name": "purchase:success"},
    )
    assert event.status_code == 201
    return str(event.json()["id"])


@pytest.mark.asyncio
async def test_an_event_carries_a_thread_without_any_attachment(client: AsyncClient) -> None:
    """The old anchor was photo_id and nothing else, so there was no comment
    surface at all until somebody uploaded an image."""
    slug = "ev-discussion"
    event_id = await _setup_event(client, slug)
    base = f"/api/v1/projects/{slug}/events/{event_id}/comments"

    assert (await client.get(base)).json() == []

    top = await client.post(base, json={"body": "should this fire on cancel too?"})
    assert top.status_code == 201
    assert top.json()["photo_id"] is None
    assert top.json()["event_id"] == event_id

    reply = await client.post(
        base, json={"body": "no — cancel has its own event", "parent_id": top.json()["id"]}
    )
    assert reply.status_code == 201
    assert reply.json()["parent_id"] == top.json()["id"]

    listed = await client.get(base)
    assert [row["body"] for row in listed.json()] == [
        "should this fire on cancel too?",
        "no — cancel has its own event",
    ]

    gone = await client.delete(f"{base}/{reply.json()['id']}")
    assert gone.status_code == 204
    assert [row["body"] for row in (await client.get(base)).json()] == [
        "should this fire on cancel too?"
    ]


@pytest.mark.asyncio
async def test_a_reply_must_belong_to_this_events_thread(client: AsyncClient) -> None:
    slug = "ev-discussion-parent"
    first_event_id = await _setup_event(client, slug)
    event_types = await client.get(f"/api/v1/projects/{slug}/event-types")
    other = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": event_types.json()[0]["id"], "name": "purchase:failed"},
    )
    assert other.status_code == 201
    other_event_id = other.json()["id"]

    posted = await client.post(
        f"/api/v1/projects/{slug}/events/{first_event_id}/comments",
        json={"body": "here"},
    )
    assert posted.status_code == 201

    crossed = await client.post(
        f"/api/v1/projects/{slug}/events/{other_event_id}/comments",
        json={"body": "over there", "parent_id": posted.json()["id"]},
    )
    assert crossed.status_code == 400


@pytest.mark.asyncio
async def test_the_discussion_is_not_plan_content(client: AsyncClient) -> None:
    """The reason for a separate box in the first place: Description ships to
    whoever implements the event. A question must not.

    Concretely, the thread stays out of ``build_plan_snapshot`` — which is what
    keeps it out of the plan hash, the branch diff and the approval gate, since
    all three read that payload.
    """
    slug = "ev-discussion-snapshot"
    event_id = await _setup_event(client, slug)

    async with TestSessionLocal() as session:
        event = await session.get(Event, uuid.UUID(event_id))
        assert event is not None
        before = await build_plan_snapshot(session, event.project_id, branch_id=event.branch_id)

    posted = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/comments",
        json={"body": "raising this for discussion"},
    )
    assert posted.status_code == 201

    async with TestSessionLocal() as session:
        event = await session.get(Event, uuid.UUID(event_id))
        assert event is not None
        after = await build_plan_snapshot(session, event.project_id, branch_id=event.branch_id)
    assert after == before


@pytest.mark.asyncio
async def test_a_branch_copy_reads_and_writes_the_events_one_discussion(
    client: AsyncClient,
) -> None:
    """One event, one conversation. A branch copy resolves to its twin on main
    rather than forking the thread — the fork is what let a comment block a
    merge (tripl-h2sx.28)."""
    slug = "ev-discussion-branch"
    main_event_id = await _setup_event(client, slug)
    on_main = await client.post(
        f"/api/v1/projects/{slug}/events/{main_event_id}/comments",
        json={"body": "asked on main"},
    )
    assert on_main.status_code == 201

    branch = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": "feature"})
    assert branch.status_code == 201
    branch_id = branch.json()["id"]

    async with TestSessionLocal() as session:
        branch_event = (
            (await session.execute(select(Event).where(Event.branch_id == uuid.UUID(branch_id))))
            .scalars()
            .first()
        )
        assert branch_event is not None
        branch_event_id = branch_event.id
    assert str(branch_event_id) != main_event_id

    branch_base = f"/api/v1/projects/{slug}/events/{branch_event_id}/comments"
    # The branch reads main's thread…
    assert [row["body"] for row in (await client.get(branch_base)).json()] == ["asked on main"]
    # …and answering from the branch lands on the same thread, not a copy.
    answered = await client.post(branch_base, json={"body": "answered from the branch"})
    assert answered.status_code == 201
    assert answered.json()["event_id"] == main_event_id

    main_base = f"/api/v1/projects/{slug}/events/{main_event_id}/comments"
    assert [row["body"] for row in (await client.get(main_base)).json()] == [
        "asked on main",
        "answered from the branch",
    ]

    async with TestSessionLocal() as session:
        anchored_on_the_copy = (
            (
                await session.execute(
                    select(EventPhotoComment).where(EventPhotoComment.event_id == branch_event_id)
                )
            )
            .scalars()
            .all()
        )
    assert list(anchored_on_the_copy) == []

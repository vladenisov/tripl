import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import tripl.alerting_validation as av
from tripl.crypto import encrypt_value
from tripl.models.event import Event, EventStatus
from tripl.models.event_type import EventType
from tripl.models.implementation_ticket import ImplementationTicket
from tripl.models.plan_branch import PlanBranch
from tripl.models.project import Project
from tripl.models.project_tracker_config import ProjectTrackerConfig
from tripl.tests.conftest import TestSessionLocal
from tripl.worker.tasks import implementation_tickets as impl_tasks


def _patch_public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve any tracker host to a public IP so the SSRF guard passes without
    real DNS (hermetic + no network dependency)."""

    def fake_getaddrinfo(host: str, *args: object, **kwargs: object):
        return [(2, 1, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(av.socket, "getaddrinfo", fake_getaddrinfo)


def _tracker_config(project_id: uuid.UUID) -> ProjectTrackerConfig:
    return ProjectTrackerConfig(
        project_id=project_id,
        enabled=True,
        tracker_type="jira",
        base_url="https://example.atlassian.net",
        project_key="ENG",
        auth_email="alice@example.com",
        api_token_encrypted=encrypt_value("api-token-1"),
        issue_type="Task",
    )


async def _seed_event_parents(
    session: AsyncSession, project_id: uuid.UUID, branch_id: uuid.UUID
) -> uuid.UUID:
    """Create the PlanBranch + EventType that ``Event`` rows FK to.

    ``Event.branch_id`` and ``Event.event_type_id`` are non-null FKs; production
    Postgres rejects the fabricated ids these tests used, so seed real parents
    and flush them before their child events. Returns the event_type_id to use.
    """
    session.add(PlanBranch(id=branch_id, project_id=project_id, name="feature"))
    await session.flush()
    event_type_id = uuid.uuid4()
    session.add(
        EventType(
            id=event_type_id,
            project_id=project_id,
            branch_id=branch_id,
            name="impl-tickets",
            display_name="Impl Tickets",
        )
    )
    await session.flush()
    return event_type_id


def _event(
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    event_type_id: uuid.UUID,
    name: str,
    status: EventStatus,
) -> Event:
    return Event(
        id=uuid.uuid4(),
        project_id=project_id,
        branch_id=branch_id,
        event_type_id=event_type_id,
        name=name,
        status=status.value,
    )


@pytest.mark.asyncio
async def test_create_implementation_ticket_creates_row_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_public_dns(monkeypatch)
    project_id = uuid.uuid4()
    branch_id = uuid.uuid4()
    event = None
    async with TestSessionLocal() as session:
        session.add(Project(id=project_id, name="Tick", slug="tick", description=""))
        session.add(_tracker_config(project_id))
        event_type_id = await _seed_event_parents(session, project_id, branch_id)
        event = _event(
            project_id, branch_id, event_type_id, "purchase:success", EventStatus.ready_for_dev
        )
        session.add(event)
        await session.commit()
    event_id = str(event.id)

    calls: dict[str, object] = {}

    def fake_post_json(url, body, headers=None):  # noqa: ANN001, ANN202
        calls["url"] = url
        calls["body"] = body
        return {"id": "10001", "key": "ENG-1"}

    monkeypatch.setattr(impl_tasks, "_post_json", fake_post_json)

    async with TestSessionLocal() as session:
        await impl_tasks._create_ticket(
            session,
            str(project_id),
            str(branch_id),
            [event_id],
            "Implement 1 event(s) from branch 'feature'",
        )

    assert calls["url"] == "https://example.atlassian.net/rest/api/3/issue"
    async with TestSessionLocal() as session:
        tickets = (await session.execute(select(ImplementationTicket))).scalars().all()
        assert len(tickets) == 1
        ticket = tickets[0]
        assert ticket.external_id == "10001"
        assert ticket.external_key == "ENG-1"
        assert ticket.external_url == "https://example.atlassian.net/browse/ENG-1"
        assert ticket.status == "open"
        assert ticket.tracker_type == "jira"
        assert ticket.event_ids == [event_id]
        assert ticket.branch_id == branch_id

    # Idempotency: a second call for the same branch must NOT create a duplicate.
    async with TestSessionLocal() as session:
        await impl_tasks._create_ticket(
            session, str(project_id), str(branch_id), [event_id], "again"
        )
    async with TestSessionLocal() as session:
        remaining = (await session.execute(select(ImplementationTicket))).scalars().all()
        assert len(remaining) == 1


@pytest.mark.asyncio
async def test_create_implementation_ticket_skips_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_public_dns(monkeypatch)
    project_id = uuid.uuid4()
    branch_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(Project(id=project_id, name="Off", slug="off", description=""))
        config = _tracker_config(project_id)
        config.enabled = False
        session.add(config)
        await session.commit()

    def fake_post_json(url, body, headers=None):  # noqa: ANN001, ANN202
        raise AssertionError("must not call the tracker when disabled")

    monkeypatch.setattr(impl_tasks, "_post_json", fake_post_json)

    async with TestSessionLocal() as session:
        await impl_tasks._create_ticket(
            session, str(project_id), str(branch_id), [str(uuid.uuid4())], "s"
        )
    async with TestSessionLocal() as session:
        assert (await session.execute(select(ImplementationTicket))).scalars().all() == []


@pytest.mark.asyncio
async def test_sync_implementation_tickets_closes_and_marks_implemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_public_dns(monkeypatch)
    project_id = uuid.uuid4()
    branch_id = uuid.uuid4()
    ticket_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(Project(id=project_id, name="Sync", slug="sync", description=""))
        session.add(_tracker_config(project_id))
        event_type_id = await _seed_event_parents(session, project_id, branch_id)
        ready = _event(project_id, branch_id, event_type_id, "ready-evt", EventStatus.ready_for_dev)
        live = _event(project_id, branch_id, event_type_id, "live-evt", EventStatus.live)
        session.add_all([ready, live])
        await session.flush()
        ready_id, live_id = ready.id, live.id
        session.add(
            ImplementationTicket(
                id=ticket_id,
                project_id=project_id,
                branch_id=branch_id,
                tracker_type="jira",
                external_id="10001",
                external_key="ENG-1",
                external_url="https://example.atlassian.net/browse/ENG-1",
                status="open",
                summary="s",
                event_ids=[str(ready_id), str(live_id)],
            )
        )
        await session.commit()

    def fake_status(get_json, *, base_url, auth_email, api_token, issue_key):  # noqa: ANN001, ANN202
        return "done"

    monkeypatch.setattr(impl_tasks, "_get_jira_issue_status", fake_status)

    async with TestSessionLocal() as session:
        await impl_tasks._sync_tickets(session)

    async with TestSessionLocal() as session:
        ticket = (
            await session.execute(
                select(ImplementationTicket).where(ImplementationTicket.id == ticket_id)
            )
        ).scalar_one()
        assert ticket.status == "closed"
        assert ticket.closed_at is not None

        ready_after = await session.get(Event, ready_id)
        live_after = await session.get(Event, live_id)
        # A pre-implemented event is promoted...
        assert ready_after.status == EventStatus.implemented.value
        # ...but a higher-ranked live event is NEVER downgraded.
        assert live_after.status == EventStatus.live.value


@pytest.mark.asyncio
async def test_sync_implementation_tickets_leaves_open_when_not_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_public_dns(monkeypatch)
    project_id = uuid.uuid4()
    branch_id = uuid.uuid4()
    ticket_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(Project(id=project_id, name="Open", slug="open", description=""))
        session.add(_tracker_config(project_id))
        event_type_id = await _seed_event_parents(session, project_id, branch_id)
        evt = _event(project_id, branch_id, event_type_id, "still-open", EventStatus.ready_for_dev)
        session.add(evt)
        await session.flush()
        evt_id = evt.id
        session.add(
            ImplementationTicket(
                id=ticket_id,
                project_id=project_id,
                branch_id=branch_id,
                tracker_type="jira",
                external_id="10001",
                external_key="ENG-2",
                external_url="https://example.atlassian.net/browse/ENG-2",
                status="open",
                summary="s",
                event_ids=[str(evt_id)],
            )
        )
        await session.commit()

    def fake_status(get_json, *, base_url, auth_email, api_token, issue_key):  # noqa: ANN001, ANN202
        return "indeterminate"

    monkeypatch.setattr(impl_tasks, "_get_jira_issue_status", fake_status)

    async with TestSessionLocal() as session:
        await impl_tasks._sync_tickets(session)

    async with TestSessionLocal() as session:
        ticket = (
            await session.execute(
                select(ImplementationTicket).where(ImplementationTicket.id == ticket_id)
            )
        ).scalar_one()
        assert ticket.status == "open"
        assert ticket.closed_at is None
        evt_after = await session.get(Event, evt_id)
        assert evt_after.status == EventStatus.ready_for_dev.value

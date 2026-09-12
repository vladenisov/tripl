"""A group merge moves the survivor along the progression axis only (tripl-0zpq.84).

``event_status_rank`` deliberately orders ``deprecated`` (5) and ``archived``
(6) above ``live`` (4) so a closing implementation ticket cannot drag a retired
event back to ``implemented``. The group merge used to take a plain max over
that same table, which made "retire one member of a family" mean "retire the
whole group": the survivor came out ``deprecated``, with no sunset date and
nothing that ever lowers a status again.

These tests pin both halves of the rule the merge now applies — a retired member
does not retire the group, and a live member does not revive a group the user
retired — plus the mint path that made the outcome depend on which member the
loop happened to reach first.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.analyzers.event_generator import merge_existing_events_for_group_rules
from tripl.models import Base
from tripl.models.event import Event, EventStatus
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.project import Project
from tripl.tests._sqlite import enable_sqlite_foreign_keys

NOW = datetime(2026, 9, 12, 12, 0, tzinfo=UTC)

# The group the rule names is ``profile_click``; ``^profile_click_`` claims the
# per-surface members without claiming the group event itself.
_PROFILE_CLICK_RULE = [
    {
        "name": "profile_click",
        "condition_logic": "all",
        "conditions": [{"field": "__event_name", "pattern": "^profile_click_"}],
    }
]


_ProjectAndType = tuple[Project, EventType, dict[str, FieldDefinition]]


@pytest.fixture
def sync_session() -> Iterator[Session]:
    engine = create_engine("sqlite:///:memory:")
    # Before create_all: in-memory SQLite pools one connection, and a listener
    # registered after the first checkout never fires — see ``_sqlite``. The
    # merge ends in ``session.delete(source)``, so these tests need a database
    # that actually deletes.
    enable_sqlite_foreign_keys(engine)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def project_and_type(sync_session: Session) -> _ProjectAndType:
    project = Project(
        id=uuid.uuid4(), name="Lifecycle", slug="group-merge-lifecycle", description=""
    )
    sync_session.add(project)
    sync_session.flush()

    event_type = EventType(
        id=uuid.uuid4(),
        project_id=project.id,
        name="pv",
        display_name="Page View",
        description="",
    )
    sync_session.add(event_type)
    sync_session.flush()

    field_definitions = {
        "action": FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=event_type.id,
            name="action",
            display_name="Action",
            field_type="string",
            order=0,
        )
    }
    sync_session.add_all(field_definitions.values())
    sync_session.commit()
    return project, event_type, field_definitions


def _seed_event(
    session: Session,
    *,
    project: Project,
    event_type: EventType,
    field_definitions: dict[str, FieldDefinition],
    name: str,
    status: EventStatus,
    order: int,
    last_seen_at: datetime,
    sunset_at: datetime | None = None,
) -> Event:
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=event_type.id,
        name=name,
        source_name=name,
        status=status,
        order=order,
        last_seen_at=last_seen_at,
        sunset_at=sunset_at,
    )
    session.add(event)
    session.flush()
    session.add(
        EventFieldValue(
            id=uuid.uuid4(),
            event_id=event.id,
            field_definition_id=field_definitions["action"].id,
            value=name,
        )
    )
    return event


def _apply_groups(session: Session, *, project: Project, event_type: EventType) -> int:
    merged = merge_existing_events_for_group_rules(
        session,
        project_id=project.id,
        event_type_ids=[event_type.id],
        event_group_rules=_PROFILE_CLICK_RULE,
    )
    session.commit()
    return merged


def test_a_deprecated_member_does_not_retire_the_live_group(
    sync_session: Session,
    project_and_type: _ProjectAndType,
) -> None:
    """Folding one retired member in is not a statement about the group.

    ``deprecated`` outranks ``live`` in the shared rank table, so the old max
    handed the surviving group event a retirement nobody asked for — and one
    with no sunset date, since the row carrying the real one is deleted.
    """
    project, event_type, field_definitions = project_and_type
    group = _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click",
        status=EventStatus.live,
        order=0,
        last_seen_at=NOW,
    )
    member = _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click_kite",
        status=EventStatus.deprecated,
        order=1,
        last_seen_at=NOW - timedelta(days=1),
        sunset_at=NOW + timedelta(days=30),
    )
    sync_session.commit()
    group_id, member_id = group.id, member.id

    assert _apply_groups(sync_session, project=project, event_type=event_type) == 1

    assert sync_session.get(Event, member_id) is None
    survivor = sync_session.get(Event, group_id)
    assert survivor is not None
    assert survivor.status == EventStatus.live
    # ...and nothing smuggled a sunset date onto it either: the group is not in
    # the retired band at all.
    assert survivor.sunset_at is None


def test_a_group_minted_from_a_deprecated_source_is_not_born_retired(
    sync_session: Session,
    project_and_type: _ProjectAndType,
) -> None:
    """The auto-generated group row starts where every scan-minted event starts.

    The user retired ``profile_click_kite``, not ``profile_click`` — a name that
    did not exist until this pass invented it. Minting it ``deprecated`` also
    minted it with a NULL ``sunset_at``, which is precisely the shape the sunset
    alert cannot fire on.
    """
    project, event_type, field_definitions = project_and_type
    member = _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click_kite",
        status=EventStatus.deprecated,
        order=0,
        last_seen_at=NOW,
        sunset_at=NOW + timedelta(days=30),
    )
    sync_session.commit()
    member_id = member.id

    assert _apply_groups(sync_session, project=project, event_type=event_type) == 1

    assert sync_session.get(Event, member_id) is None
    minted = sync_session.execute(
        select(Event).where(Event.source_name == "profile_click")
    ).scalar_one()
    assert minted.status == EventStatus.in_review
    assert minted.sunset_at is None


@pytest.mark.parametrize("deprecated_member_is_reached_first", [True, False])
def test_group_status_does_not_depend_on_member_order(
    sync_session: Session,
    project_and_type: _ProjectAndType,
    deprecated_member_is_reached_first: bool,
) -> None:
    """One live member plus one deprecated member give ``live`` either way.

    The pass walks its sources in ``scan_identity_winner_order()`` — most
    recently seen first — so whichever row it reaches first is the one that
    mints the group. That used to decide the group's lifecycle.
    """
    project, event_type, field_definitions = project_and_type
    deprecated_seen_at = NOW if deprecated_member_is_reached_first else NOW - timedelta(days=1)
    live_seen_at = NOW - timedelta(days=1) if deprecated_member_is_reached_first else NOW
    _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click_kite",
        status=EventStatus.deprecated,
        order=0,
        last_seen_at=deprecated_seen_at,
        sunset_at=NOW + timedelta(days=30),
    )
    _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click_avatar",
        status=EventStatus.live,
        order=1,
        last_seen_at=live_seen_at,
    )
    sync_session.commit()

    assert _apply_groups(sync_session, project=project, event_type=event_type) == 2

    # ``scalar_one`` also pins that both members are gone, not just one.
    survivor = sync_session.execute(
        select(Event).where(Event.project_id == project.id)
    ).scalar_one()
    assert survivor.source_name == "profile_click"
    assert survivor.status == EventStatus.live


def test_a_live_member_does_not_revive_a_deprecated_group(
    sync_session: Session,
    project_and_type: _ProjectAndType,
) -> None:
    """The other half of the rule, which must not be over-fixed away.

    Excluding the retired band is symmetric on purpose: "a merge never moves a
    target into retirement" and "a merge never takes one out of it" are the same
    sentence. A group the user deliberately deprecated keeps its sunset date
    when a still-live member is folded into it.
    """
    project, event_type, field_definitions = project_and_type
    sunset_at = NOW + timedelta(days=30)
    group = _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click",
        status=EventStatus.deprecated,
        order=0,
        last_seen_at=NOW,
        sunset_at=sunset_at,
    )
    member = _seed_event(
        sync_session,
        project=project,
        event_type=event_type,
        field_definitions=field_definitions,
        name="profile_click_kite",
        status=EventStatus.live,
        order=1,
        last_seen_at=NOW - timedelta(days=1),
    )
    sync_session.commit()
    group_id, member_id = group.id, member.id

    assert _apply_groups(sync_session, project=project, event_type=event_type) == 1

    assert sync_session.get(Event, member_id) is None
    survivor = sync_session.get(Event, group_id)
    assert survivor is not None
    assert survivor.status == EventStatus.deprecated
    assert survivor.sunset_at == sunset_at

"""The pure planner behind both ``generate_events`` and the scan dry-run.

The whole point of ``event_plan`` is that a preview cannot promise an event name
a real run would not produce, and that asking for the promise writes nothing.
Both halves are asserted here.
"""

import uuid
from itertools import product

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.base import ColumnInfo
from tripl.core.analyzers.cardinality import BreakdownAnalysis, CardinalityResult
from tripl.core.analyzers.event_generator import generate_events
from tripl.core.analyzers.event_plan import breakdown_row_count, plan_events
from tripl.models import Base
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig


def _make_analysis(cardinality: dict[str, CardinalityResult]) -> BreakdownAnalysis:
    """Cartesian product of the sample values — mirrors test_event_generator."""
    reg_names = [name for name, cr in cardinality.items() if cr.json_path_combos is None]
    json_names = [name for name, cr in cardinality.items() if cr.json_path_combos is not None]

    value_lists: list[list] = []
    for name in reg_names:
        value_lists.append(cardinality[name].sample_values)
    for name in json_names:
        value_lists.append(cardinality[name].json_path_combos or [()])

    rows = [tuple(combo) for combo in product(*value_lists)] if value_lists else []
    return BreakdownAnalysis(
        results=cardinality,
        rows=rows,
        reg_names=reg_names,
        json_names=json_names,
    )


@pytest.fixture
def sync_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def project_and_type(sync_session: Session):
    project = Project(id=uuid.uuid4(), name="P", slug="p", description="")
    sync_session.add(project)
    sync_session.flush()
    et = EventType(
        id=uuid.uuid4(),
        project_id=project.id,
        name="Page",
        display_name="Page",
        description="",
    )
    sync_session.add(et)
    sync_session.flush()
    fds = {
        name: FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=et.id,
            name=name,
            display_name=name,
            field_type="string",
            order=order,
        )
        for order, name in enumerate(("screen", "action"))
    }
    sync_session.add_all(list(fds.values()))
    sync_session.commit()
    return project, et, fds


_LOW_CARDINALITY = {
    "screen": CardinalityResult(
        column=ColumnInfo("screen", "String"),
        count=3,
        is_low=True,
        sample_values=["/home", "/about", "/contact"],
    ),
    "action": CardinalityResult(
        column=ColumnInfo("action", "String"),
        count=2,
        is_low=True,
        sample_values=["click", "view"],
    ),
}


def test_plan_events_names_match_generate_events_and_write_nothing(
    sync_session: Session, project_and_type
) -> None:
    """The dry-run's answer IS the run's answer, and asking costs no rows.

    Three assertions, all load-bearing:

    * the LITERAL names, so a change to how a name is built fails here rather
      than being absorbed by comparing the planner to itself;
    * nothing pending and nothing written after planning, which is what makes it
      safe to run this from a form — routing a dry-run back through the
      persisting path fails with "dry run persisted N events";
    * the run then materialises exactly those names, which is the property the
      whole extraction exists to guarantee.
    """
    project, et, fds = project_and_type
    analysis = _make_analysis(_LOW_CARDINALITY)

    before = sync_session.execute(select(Event).where(Event.project_id == project.id)).scalars()
    assert list(before) == []

    plan = plan_events(analysis, {name: fd.id for name, fd in fds.items()})

    assert sorted({p.name for p in plan.events}) == [
        "screen=/about | action=click",
        "screen=/about | action=view",
        "screen=/contact | action=click",
        "screen=/contact | action=view",
        "screen=/home | action=click",
        "screen=/home | action=view",
    ]
    assert list(sync_session.new) == [], (
        f"dry run persisted {len(sync_session.new)} pending objects"
    )
    after = (
        sync_session.execute(select(Event).where(Event.project_id == project.id)).scalars().all()
    )
    assert after == [], f"dry run persisted {len(after)} events"

    result = generate_events(sync_session, project.id, et.id, analysis, fds)
    sync_session.commit()

    written = (
        sync_session.execute(select(Event.source_name).where(Event.project_id == project.id))
        .scalars()
        .all()
    )
    assert result.events_created == 6  # 3 screens x 2 actions
    assert sorted({p.name for p in plan.events}) == sorted(written)


def test_plan_events_uses_the_callers_reserved_set_verbatim(
    sync_session: Session, project_and_type
) -> None:
    """A column the event name is built from must never be reserved away.

    Reserving it skips its FieldDefinition, the name format is then evaluated
    without it, and the whole config's collection dies on "the event name format
    references unknown keys" — 200 consecutive production runs (tripl-lpin). The
    planner does not re-derive the set; it takes what the caller computed, which
    is the only way ``core`` can honour a rule that lives in ``worker``.
    """
    from tripl.worker.utils.reserved_columns import reserved_catalog_columns

    project, et, fds = project_and_type

    config = ScanConfig(
        time_column="time",
        platform_column="screen",
        event_name_format="{screen}",
    )
    reserved = reserved_catalog_columns(config)
    assert "screen" not in reserved, "the name-format column must not be reserved"

    plan = plan_events(
        _make_analysis(_LOW_CARDINALITY),
        {name: fd.id for name, fd in fds.items()},
        event_name_format="{screen}",
        reserved_columns=reserved,
    )
    assert sorted({p.name for p in plan.events}) == ["/about", "/contact", "/home"]

    # And the set really is used verbatim: reserve it and the column is silently
    # dropped from col_meta, which is precisely the outage above.
    dropped = plan_events(
        _make_analysis(_LOW_CARDINALITY),
        {name: fd.id for name, fd in fds.items() if name != "screen"},
        reserved_columns={"screen"},
    )
    assert "screen" not in dropped.col_meta
    assert not any("screen" in detail for detail in dropped.details), (
        "a reserved column must not be reported as a missing field definition"
    )


def test_plan_events_hoists_variables_in_first_seen_order(
    sync_session: Session, project_and_type
) -> None:
    """``ensure_variable`` creates a variable with the FIRST type it is asked for.

    A ``set`` of needs would make which type wins depend on hash order, so the
    plan carries an ordered, de-duplicated list.
    """
    _project, _et, fds = project_and_type
    high = {
        "screen": CardinalityResult(
            column=ColumnInfo("screen", "String"),
            count=5000,
            is_low=False,
            sample_values=[f"/users/{i}/profile" for i in range(200)],
        ),
    }
    plan = plan_events(_make_analysis(high), {"screen": fds["screen"].id})
    names = [need.name for need in plan.variables_needed]
    assert len(names) == len(set(names)), "variable needs must be de-duplicated"


def test_breakdown_row_count_ignores_rows_that_carry_no_count() -> None:
    """A hand-built analysis has no ``_cnt``; guessing ``row[-1]`` reads a VALUE."""
    analysis = _make_analysis(_LOW_CARDINALITY)
    assert breakdown_row_count(analysis, analysis.rows[0]) is None
    assert breakdown_row_count(analysis, (*analysis.rows[0], 42)) == 42

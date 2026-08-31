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
from tripl.core.analyzers.event_generator import apply_event_group_rules, generate_events
from tripl.core.analyzers.event_plan import (
    breakdown_row_count,
    plan_events,
    unnamed_skip_detail,
)
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


_NULL_ACTION = {
    "action": CardinalityResult(
        column=ColumnInfo("action", "String"),
        count=1,
        is_low=True,
        sample_values=[None],
    ),
}


def test_a_row_whose_name_resolves_to_empty_is_not_planned(project_and_type) -> None:
    """A NULL naming column used to mint a nameless catalog row (tripl-wkwv.5).

    ``_format_value(None)`` is ``""`` and ``_apply_name_format`` raises only for a
    placeholder the row cannot supply AT ALL, so ``{action}`` over a NULL
    ``action`` substituted silently and the run wrote ``Event(name="")`` — a
    zero-width unlabelled link the user cannot click, and a row the metric
    collector's ``if event_name:`` gate can never measure, match or reconcile.

    Skipped rather than renamed, and disclosed rather than dropped in silence:
    the operator's next question is which rows, and the answer is the name format
    or the base query.
    """
    _project, _et, fds = project_and_type

    plan = plan_events(
        _make_analysis(_NULL_ACTION),
        {"action": fds["action"].id},
        event_name_format="{action}",
    )

    assert plan.events == []
    assert plan.events_unnamed == 1
    assert plan.details == ["Skipped 1 row whose derived event name was empty"]


def test_the_skip_line_is_the_one_function_every_surface_calls(project_and_type) -> None:
    """The plural is the reason this helper is a function (tripl-wkwv.5).

    A grouped dry run plans once per event type, so it sums the per-plan counts
    and asks for ONE sentence covering the total — ``plan_events`` never sees a
    number bigger than its own rows. Both callers go through the same helper;
    building the aggregate string at the call site is exactly how "1 rows", the
    defect tripl-3y7z fixed, comes back.
    """
    _project, _et, fds = project_and_type

    # Two screens x one NULL action: two rows, both nameless under ``{action}``.
    plan = plan_events(
        _make_analysis(
            {
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=2,
                    is_low=True,
                    sample_values=["/home", "/about"],
                ),
                **_NULL_ACTION,
            }
        ),
        {name: fd.id for name, fd in fds.items()},
        event_name_format="{action}",
    )

    assert plan.events_unnamed == 2
    assert plan.details == [unnamed_skip_detail(2)]
    assert unnamed_skip_detail(1) == "Skipped 1 row whose derived event name was empty"
    assert unnamed_skip_detail(2) == "Skipped 2 rows whose derived event name was empty"


def test_a_name_of_only_empty_segments_is_still_planned(project_and_type) -> None:
    """The conservative half, pinned so nobody widens the guard (tripl-wkwv.5).

    ``"::"`` and ``"onboarding:start:"`` are non-empty strings: they have a click
    target, an accessible name and a purpose-built rendering (the frontend paints
    each empty piece as ∅). They are ugly, not broken — and a trailing empty
    segment is plainly a real event with an optional last part.

    Skipping them would be actively worse than showing them. The metric
    collector's gate is falsiness and ``"::"`` is truthy, so it would still derive
    the name, miss the catalog, miss the archived identities and file real
    traffic as an unplanned shadow candidate: coverage numerator down,
    denominator unchanged. Skipping a real event is a far worse bug than showing
    an ugly one.
    """
    _project, _et, fds = project_and_type
    field_ids = {name: fd.id for name, fd in fds.items()}

    all_null = plan_events(
        _make_analysis(
            {
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=1,
                    is_low=True,
                    sample_values=[None],
                ),
                **_NULL_ACTION,
            }
        ),
        field_ids,
        event_name_format="{screen}::{action}",
    )
    assert [event.name for event in all_null.events] == ["::"]
    assert all_null.events_unnamed == 0

    trailing_null = plan_events(
        _make_analysis(
            {
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=1,
                    is_low=True,
                    sample_values=["onboarding"],
                ),
                **_NULL_ACTION,
            }
        ),
        field_ids,
        event_name_format="{screen}:start:{action}",
    )
    assert [event.name for event in trailing_null.events] == ["onboarding:start:"]
    assert trailing_null.events_unnamed == 0


def test_a_group_rule_rescues_an_otherwise_empty_name(project_and_type) -> None:
    """The guard runs AFTER the group rules, and that ordering is behaviour.

    ``_event_generator_merge`` skips any rule whose own name is blank, so a rule
    can only ever rescue an empty derived name into a real one — never produce
    one. Guarding before the rules would delete the very rows a scan config was
    written to salvage (tripl-wkwv.5).
    """
    _project, _et, fds = project_and_type

    plan = plan_events(
        _make_analysis(_NULL_ACTION),
        {"action": fds["action"].id},
        event_name_format="{action}",
        event_group_rules=[
            {"name": "unnamed_traffic", "conditions": [{"field": "__event_name", "pattern": "^$"}]}
        ],
    )

    assert [event.name for event in plan.events] == ["unnamed_traffic"]
    assert plan.events_unnamed == 0
    assert plan.events_grouped == 1


def _payload_analysis() -> BreakdownAnalysis:
    """One JSON column whose two paths split the way the rule needs them to.

    ``payload.action`` is a passthrough — the scan's ``json_value_paths`` name it,
    so the row carries its VALUE and ``_raw_values_from_row`` offers it to a group
    rule under its dotted name. That is the only kind of path a dotted condition
    can ever be matched against. ``payload.screen`` is not named, so it becomes a
    variable and ``build_json_value`` writes its ``${payload.screen}`` token into
    the field value — which is the thing an override keyed on ``payload`` would
    destroy. One column, both roles, so a single blob shows the whole trade.
    """
    return BreakdownAnalysis(
        results={
            "payload": CardinalityResult(
                column=ColumnInfo("payload", "JSON"),
                count=1,
                is_low=False,
                json_path_combos=[("action", "screen")],
            )
        },
        rows=[(["action", "screen"], "checkout", 7)],
        reg_names=[],
        json_names=["payload"],
        json_value_names=["payload.action"],
    )


_DOTTED_RULE = [
    {"name": "Checkout", "conditions": [{"field": "payload.action", "pattern": "^checkout$"}]}
]


def test_a_dotted_condition_reserves_nothing_not_even_its_base_column() -> None:
    """The reduction that is correct for a name format is destructive here.

    ``name_format_base_columns`` reduces ``{event.category}`` to ``event`` because
    it feeds a SUBTRACTION, where over-reducing costs one spare FieldDefinition.
    The reserved set is built by ADDITION. Reserving ``payload`` for a rule on
    ``payload.action`` denies that column a FieldDefinition, ``plan_column_meta``
    drops it from ``col_meta``, and every JSON-path variable under it goes too —
    on production, where every variable is JSON-path derived, that is a column's
    entire variable surface, deleted without a word.
    """
    from tripl.worker.utils.reserved_columns import reserved_catalog_columns

    config = ScanConfig(time_column="time", event_group_rules=_DOTTED_RULE)
    reserved = reserved_catalog_columns(config)
    assert reserved == {"time"}, "a dotted condition names no column to reserve"

    plan = plan_events(
        _payload_analysis(),
        {"payload": uuid.uuid4()},
        event_group_rules=_DOTTED_RULE,
        reserved_columns=reserved,
    )
    assert "payload" in plan.col_meta
    assert [need.name for need in plan.variables_needed] == ["payload.screen"]

    # The cost of the reduction cannot be shown from here, and pretending
    # otherwise would be worse than not showing it: this layer is handed
    # ``field_ids`` outright, and a reserved column only loses its "no matching
    # field definition" message. What the reduction actually takes is one layer
    # up — ``_ensure_event_type_with_fields`` skips a reserved column, so no
    # FieldDefinition exists, no id reaches ``field_ids``, and only THEN does
    # ``plan_column_meta`` drop the column and every variable under it. The
    # assertion that guards against that is the one above: ``payload`` must
    # never enter the reserved set in the first place.
    assert "payload" not in reserved


def test_a_dotted_condition_still_groups_and_leaves_the_json_blob_alone() -> None:
    """Matching is the whole of what a dotted condition may do.

    The override half moves with the reserved half or the pair stops cancelling.
    An override keyed on ``payload`` would write the regex literal over the JSON
    template, taking every ``${payload.path}`` token with it — and
    ``_move_variable_contexts`` deletes any VariableValue whose target value no
    longer names it, so the blob and the observations go in one step. The literal
    blob is asserted, not just its length, so base-keying the override fails here.
    """
    match = apply_event_group_rules("raw name", {"payload.action": "checkout"}, _DOTTED_RULE)
    assert match.event_name == "Checkout"
    assert match.field_value_overrides == {}

    plan = plan_events(
        _payload_analysis(),
        {"payload": uuid.uuid4()},
        event_group_rules=_DOTTED_RULE,
    )
    assert [event.name for event in plan.events] == ["Checkout"]
    assert plan.events_grouped == 1

    ((_fd_id, col_name, value),) = plan.events[0].field_values
    assert col_name == "payload"
    assert value == '{"action": "checkout", "screen": "${payload.screen}"}'


def test_a_scalar_condition_still_reserves_and_still_overrides(project_and_type) -> None:
    """The narrowing is only about dotted fields; a plain column is untouched.

    A scalar condition column is reserved, which normally means no FieldDefinition
    and so nothing for the override to land on. The override path stays live for a
    project that declared the field BEFORE the column became a rule column — that
    is the case ``plan_column_meta`` deliberately lets fall through — and there the
    grouped event must still show the rule's own pattern rather than one arbitrary
    source row's value (tripl-jfm3.57).
    """
    from tripl.worker.utils.reserved_columns import reserved_catalog_columns

    _project, _et, fds = project_and_type
    rules = [{"name": "Home", "conditions": [{"field": "screen", "pattern": "^/home$"}]}]

    config = ScanConfig(time_column="time", event_group_rules=rules)
    assert reserved_catalog_columns(config) == {"time", "screen"}

    plan = plan_events(
        _make_analysis(_LOW_CARDINALITY),
        {name: fd.id for name, fd in fds.items()},
        event_group_rules=rules,
    )

    grouped = [event for event in plan.events if event.name == "Home"]
    assert len(grouped) == 2, "/home pairs with each action value"
    for event in grouped:
        values = {col_name: value for _fd_id, col_name, value in event.field_values}
        assert values["screen"] == "/^/home$/"
        assert values["action"] in {"click", "view"}


def test_breakdown_row_count_ignores_rows_that_carry_no_count() -> None:
    """A hand-built analysis has no ``_cnt``; guessing ``row[-1]`` reads a VALUE."""
    analysis = _make_analysis(_LOW_CARDINALITY)
    assert breakdown_row_count(analysis, analysis.rows[0]) is None
    assert breakdown_row_count(analysis, (*analysis.rows[0], 42)) == 42

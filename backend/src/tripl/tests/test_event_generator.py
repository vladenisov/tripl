"""Unit tests for the event generator module."""

import uuid
from datetime import UTC, datetime
from itertools import product

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.base import ColumnInfo
from tripl.core.analyzers.cardinality import BreakdownAnalysis, CardinalityResult
from tripl.core.analyzers.event_generator import (
    _ensure_variable,
    _resolve_main_branch_id,
    generate_events,
    merge_existing_events_for_group_rules,
)
from tripl.models import Base
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.plan_branch import BranchKind, BranchStatus, PlanBranch
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.tests._sqlite import enable_sqlite_foreign_keys


def _make_analysis(
    cardinality: dict[str, CardinalityResult],
) -> BreakdownAnalysis:
    """Build a BreakdownAnalysis with all row combinations from sample_values."""
    reg_names = [name for name, cr in cardinality.items() if cr.json_path_combos is None]
    json_names = [name for name, cr in cardinality.items() if cr.json_path_combos is not None]

    # Build rows as cartesian product of sample values (regular) / path combos (json)
    value_lists: list[list] = []
    for name in reg_names:
        value_lists.append(cardinality[name].sample_values)
    for name in json_names:
        combos = cardinality[name].json_path_combos or [()]
        value_lists.append(combos)

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
    # Before create_all: the pooled connection is opened by the first statement,
    # and a listener registered after that never fires. Without the pragma the
    # merge tests below cannot fail — see ``_sqlite``.
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
def project_and_type(sync_session: Session):
    project = Project(
        id=uuid.uuid4(),
        name="Test Project",
        slug="test-eg",
        description="",
    )
    sync_session.add(project)
    sync_session.flush()

    et = EventType(
        id=uuid.uuid4(),
        project_id=project.id,
        name="pv",
        display_name="Page View",
        description="",
    )
    sync_session.add(et)
    sync_session.flush()

    fd_screen = FieldDefinition(
        id=uuid.uuid4(),
        event_type_id=et.id,
        name="screen",
        display_name="Screen",
        field_type="string",
        order=0,
    )
    fd_action = FieldDefinition(
        id=uuid.uuid4(),
        event_type_id=et.id,
        name="action",
        display_name="Action",
        field_type="string",
        order=1,
    )
    fd_payload = FieldDefinition(
        id=uuid.uuid4(),
        event_type_id=et.id,
        name="payload",
        display_name="Payload",
        field_type="json",
        order=2,
    )
    sync_session.add_all([fd_screen, fd_action, fd_payload])
    sync_session.flush()
    sync_session.commit()

    return project, et, {"screen": fd_screen, "action": fd_action, "payload": fd_payload}


def _seed_scan_config(sync_session: Session, project: Project) -> uuid.UUID:
    """Persist the minimum data source + scan config an EventMetric can point at."""
    from tripl.models.data_source import DataSource
    from tripl.models.scan_config import ScanConfig

    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"wh-{uuid.uuid4().hex[:8]}",
        db_type="clickhouse",
        host="localhost",
        port=9000,
        database_name="db",
        username="u",
    )
    sync_session.add(data_source)
    sync_session.flush()
    scan_config = ScanConfig(
        id=uuid.uuid4(),
        project_id=project.id,
        data_source_id=data_source.id,
        name="main scan",
        base_query="SELECT 1",
    )
    sync_session.add(scan_config)
    sync_session.flush()
    return scan_config.id


class TestEventGeneration:
    def test_low_cardinality_generates_concrete_events(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        cardinality = {
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
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
        )
        sync_session.commit()

        assert result.events_created == 6  # 3 screens × 2 actions
        assert result.events_skipped == 0

        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert len(events) == 6

    def test_high_cardinality_generates_templated_events(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=5000,
                is_low=False,
                sample_values=[f"/users/{i}/profile" for i in range(200)],
            ),
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=2,
                is_low=True,
                sample_values=["click", "view"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
        )
        sync_session.commit()

        # screen → 1 template, action → 2 values = 2 events
        assert result.events_created == 2
        assert result.variables_created >= 1

        # Check variable was created
        variables = (
            sync_session.execute(select(Variable).where(Variable.project_id == project.id))
            .scalars()
            .all()
        )
        assert len(variables) >= 1

        contexts = (
            sync_session.execute(
                select(VariableValue).where(VariableValue.project_id == project.id)
            )
            .scalars()
            .all()
        )
        assert len(contexts) == 2
        assert {context.value_kind for context in contexts} == {"high"}
        assert {context.observed_count for context in contexts} == {200}
        assert all(len(context.values) == 20 for context in contexts)

    def test_variable_context_keeps_all_low_cardinality_variable_values(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        values = [f"group_cat{i % 12}_{i}" for i in range(120)]
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=120,
                is_low=False,
                sample_values=values,
            ),
        }
        analysis = _make_analysis(cardinality)
        generate_events(sync_session, project.id, et.id, analysis, fds, cardinality_threshold=100)
        sync_session.commit()

        contexts = (
            sync_session.execute(
                select(VariableValue).where(
                    VariableValue.project_id == project.id,
                    VariableValue.value_kind == "low",
                )
            )
            .scalars()
            .all()
        )
        assert len(contexts) == 1
        assert contexts[0].observed_count == 12
        assert contexts[0].values == sorted(f"cat{i}" for i in range(12))

    def test_variable_contexts_are_replaced_on_rescan(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type

        first = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=150,
                is_low=False,
                sample_values=[f"firstvalue{i:03d}" for i in range(150)],
            ),
        }
        generate_events(sync_session, project.id, et.id, _make_analysis(first), fds)
        sync_session.commit()

        second = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=150,
                is_low=False,
                sample_values=[f"secondvalue{i:03d}" for i in range(150)],
            ),
        }
        generate_events(sync_session, project.id, et.id, _make_analysis(second), fds)
        sync_session.commit()

        context = sync_session.execute(select(VariableValue)).scalar_one()
        assert all(value.startswith("secondvalue") for value in context.values)
        assert not any(value.startswith("firstvalue") for value in context.values)

    def test_rescan_preserves_replay_enriched_empty_variable_context_values(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        cardinality = {
            "payload": CardinalityResult(
                column=ColumnInfo("payload", "JSON"),
                count=1,
                is_low=False,
                json_path_combos=[("user.id",)],
            ),
        }
        analysis = _make_analysis(cardinality)
        generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()

        context = sync_session.execute(select(VariableValue)).scalar_one()
        assert context.source_column == "payload.user.id"
        assert context.observed_count == 0
        assert context.values == []

        context.observed_count = 2
        context.values = ["u1", "u2"]
        sync_session.commit()

        generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()

        context = sync_session.execute(select(VariableValue)).scalar_one()
        assert context.value_kind == "high"
        assert context.observed_count == 2
        assert context.values == ["u1", "u2"]

    def _seed_curated_event_with_context(
        self,
        sync_session: Session,
        project,
        et,
        fds,
        *,
        screen_is_authored: bool,
    ) -> VariableValue:
        """A hand-curated event whose ``screen`` reads ``${myvar}``, plus its context.

        The generated identity for the analysis below is ``screen=/home |
        action=click``, so the scan matches this event instead of creating one.
        """
        variable = Variable(
            id=uuid.uuid4(),
            project_id=project.id,
            name="myvar",
            source_name="myvar",
            variable_type="string",
        )
        event = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name="Curated",
            source_name="screen=/home | action=click",
            order=0,
            status="live",
        )
        sync_session.add_all([variable, event])
        sync_session.flush()
        sync_session.add_all(
            [
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fds["screen"].id,
                    value="${myvar}",
                    is_authored=screen_is_authored,
                ),
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fds["action"].id,
                    value="click",
                    is_authored=True,
                ),
            ]
        )
        context = VariableValue(
            id=uuid.uuid4(),
            project_id=project.id,
            variable_id=variable.id,
            event_id=event.id,
            field_definition_id=fds["screen"].id,
            source_column="screen",
            value_kind="low",
            observed_count=42,
            values=["curated_a", "curated_b"],
        )
        sync_session.add(context)
        sync_session.flush()
        sync_session.commit()
        return context

    @staticmethod
    def _low_card_analysis() -> BreakdownAnalysis:
        """Both columns low-cardinality, so the run detects NO variables at all."""
        return _make_analysis(
            {
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=1,
                    is_low=True,
                    sample_values=["/home"],
                ),
                "action": CardinalityResult(
                    column=ColumnInfo("action", "String"),
                    count=1,
                    is_low=True,
                    sample_values=["click"],
                ),
            }
        )

    def test_rescan_keeps_variable_contexts_behind_authored_field_values(
        self, sync_session: Session, project_and_type
    ):
        """A scan must not wipe contexts hanging off values it is not allowed to write.

        The scan used to delete EVERY variable context for the event type before
        re-recording, so a curated ``${myvar}`` template it enumerates literally
        (low cardinality → no variable observations) lost its recorded values on
        the first scan — which is how a fresh demo emptied its own "Variables &
        value drift" chapter (bd tripl-jfm3.56).
        """
        project, et, fds = project_and_type
        context = self._seed_curated_event_with_context(
            sync_session, project, et, fds, screen_is_authored=True
        )

        result = generate_events(sync_session, project.id, et.id, self._low_card_analysis(), fds)
        sync_session.commit()
        assert result.events_created == 0
        assert result.events_skipped == 1

        survived = sync_session.get(VariableValue, context.id)
        assert survived is not None
        assert survived.observed_count == 42
        assert survived.values == ["curated_a", "curated_b"]
        # The authored template is still what the events table shows.
        field_value = sync_session.execute(
            select(EventFieldValue).where(
                EventFieldValue.event_id == survived.event_id,
                EventFieldValue.field_definition_id == fds["screen"].id,
            )
        ).scalar_one()
        assert field_value.value == "${myvar}"

    def test_rescan_drops_variable_contexts_whose_field_value_it_rewrote(
        self, sync_session: Session, project_and_type
    ):
        """The same context IS stale once the scan overwrites the value it describes."""
        project, et, fds = project_and_type
        context = self._seed_curated_event_with_context(
            sync_session, project, et, fds, screen_is_authored=False
        )

        generate_events(sync_session, project.id, et.id, self._low_card_analysis(), fds)
        sync_session.commit()

        assert sync_session.get(VariableValue, context.id) is None
        field_value = sync_session.execute(
            select(EventFieldValue).where(
                EventFieldValue.field_definition_id == fds["screen"].id,
            )
        ).scalar_one()
        assert field_value.value == "/home"

    def test_event_name_column_enumerated_despite_high_cardinality(
        self, sync_session: Session, project_and_type
    ):
        """A high-cardinality column used as the event name must enumerate one event per
        distinct value instead of collapsing into a single ${col} template."""
        project, et, fds = project_and_type
        actions = [f"evt_{i}" for i in range(150)]
        cardinality = {
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=150,
                is_low=False,
                sample_values=actions,
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{action}",
        )
        sync_session.commit()

        assert result.events_created == 150
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        names = {e.name for e in events}
        assert "${action}" not in names
        assert "evt_0" in names
        assert "evt_149" in names

    def test_group_rule_collapses_matching_generated_events(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        cardinality = {
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=3,
                is_low=True,
                sample_values=["button:primary", "button:secondary", "page:view"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{action}",
            event_group_rules=[
                {
                    "name": "button events",
                    "condition_logic": "all",
                    "conditions": [{"field": "action", "pattern": "^button:"}],
                }
            ],
        )
        sync_session.commit()

        assert result.events_created == 2
        assert result.events_skipped == 1
        assert result.events_grouped == 2

        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert {event.source_name for event in events} == {"button events", "page:view"}
        grouped_event = next(event for event in events if event.source_name == "button events")
        action_value = sync_session.execute(
            select(EventFieldValue.value).where(
                EventFieldValue.event_id == grouped_event.id,
                EventFieldValue.field_definition_id == fds["action"].id,
            )
        ).scalar_one()
        assert action_value == "/^button:/"

    def test_group_collapse_into_existing_event_does_not_duplicate_field_values(
        self, sync_session: Session, project_and_type
    ):
        """Regression: several scan rows collapsing (via a group rule) into one
        pre-existing event must not re-insert the same
        ``(event_id, field_definition_id)`` pair and violate
        ``uq_event_field_value_event_field``.

        The existing event is loaded at scan start with its ``field_values``
        eagerly populated and *without* the action field. Each collapsing row
        used to queue a fresh ``EventFieldValue`` because the queued value never
        showed up in the already-loaded relationship — producing two inserts
        for the same pair in a single flush.
        """
        project, et, fds = project_and_type
        existing = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name="button events",
            source_name="button events",
            order=0,
            status="live",
        )
        sync_session.add(existing)
        sync_session.commit()

        cardinality = {
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=2,
                is_low=True,
                sample_values=["button:primary", "button:secondary"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{action}",
            event_group_rules=[
                {
                    "name": "button events",
                    "condition_logic": "all",
                    "conditions": [{"field": "action", "pattern": "^button:"}],
                }
            ],
        )
        sync_session.commit()

        assert result.events_created == 0
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert {event.source_name for event in events} == {"button events"}

        field_values = (
            sync_session.execute(
                select(EventFieldValue).where(EventFieldValue.event_id == existing.id)
            )
            .scalars()
            .all()
        )
        # Exactly one row for (event_id, action) — not two.
        action_values = [fv for fv in field_values if fv.field_definition_id == fds["action"].id]
        assert len(action_values) == 1

    def test_group_rule_merges_existing_matching_events_and_metrics(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        # A real ScanConfig row, not a fabricated uuid: EventMetric.scan_config_id
        # is a NOT NULL foreign key, and the engine now enforces it.
        scan_config_id = _seed_scan_config(sync_session, project)
        bucket = datetime(2026, 4, 12, 10, 0)
        old_events: list[Event] = []
        for index, action in enumerate(["button:primary", "button:secondary"]):
            event = Event(
                id=uuid.uuid4(),
                project_id=project.id,
                event_type_id=et.id,
                name=action,
                source_name=action,
                order=index,
                status="implemented",
            )
            sync_session.add(event)
            sync_session.flush()
            sync_session.add(
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fds["action"].id,
                    value=action,
                )
            )
            sync_session.add(
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config_id,
                    event_id=event.id,
                    event_type_id=None,
                    bucket=bucket,
                    count=5 + index,
                )
            )
            old_events.append(event)
        sync_session.commit()

        cardinality = {
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=2,
                is_low=True,
                sample_values=["button:primary", "button:secondary"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{action}",
            event_group_rules=[
                {
                    "name": "button events",
                    "condition_logic": "all",
                    "conditions": [{"field": "action", "pattern": "^button:"}],
                }
            ],
        )
        sync_session.commit()

        assert result.events_merged == 2
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert {event.source_name for event in events} == {"button events"}
        grouped_event = events[0]
        metric = sync_session.execute(
            select(EventMetric).where(EventMetric.event_id == grouped_event.id)
        ).scalar_one()
        assert metric.count == 11
        assert all(sync_session.get(Event, event.id) is None for event in old_events)

    def test_post_factum_group_rules_merge_existing_events(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        for index, action in enumerate(["button:primary", "button:secondary"]):
            event = Event(
                id=uuid.uuid4(),
                project_id=project.id,
                event_type_id=et.id,
                name=action,
                source_name=action,
                order=index,
                status="implemented",
            )
            sync_session.add(event)
            sync_session.flush()
            sync_session.add(
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fds["action"].id,
                    value=action,
                )
            )
        sync_session.commit()

        merged = merge_existing_events_for_group_rules(
            sync_session,
            project_id=project.id,
            event_type_ids=[et.id],
            event_group_rules=[
                {
                    "name": "button events",
                    "condition_logic": "all",
                    "conditions": [{"field": "action", "pattern": "^button:"}],
                }
            ],
        )
        sync_session.commit()

        assert merged == 2
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert {event.source_name for event in events} == {"button events"}
        grouped_event = events[0]
        action_value = sync_session.execute(
            select(EventFieldValue.value).where(
                EventFieldValue.event_id == grouped_event.id,
                EventFieldValue.field_definition_id == fds["action"].id,
            )
        ).scalar_one()
        assert action_value == "/^button:/"

    def test_post_factum_group_rules_merge_multiline_values(
        self, sync_session: Session, project_and_type
    ):
        # Free-text event values can be multi-line (e.g. a pasted notification body
        # captured as the activity name). An anchored ``^...$`` rule must still match
        # them against the whole value, so ``.`` has to span newlines.
        project, et, fds = project_and_type
        single_line = "page_select_sport_other_activity_running_chosen"
        multi_line = (
            "page_select_sport_other_activity_Gewitter (stark)\n"
            "Kreis Emsland\n\n> 50% - Wahrscheinlich\n_chosen"
        )
        for index, action in enumerate([single_line, multi_line]):
            event = Event(
                id=uuid.uuid4(),
                project_id=project.id,
                event_type_id=et.id,
                name=action,
                source_name=action,
                order=index,
                status="implemented",
            )
            sync_session.add(event)
            sync_session.flush()
            sync_session.add(
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fds["action"].id,
                    value=action,
                )
            )
        sync_session.commit()

        merged = merge_existing_events_for_group_rules(
            sync_session,
            project_id=project.id,
            event_type_ids=[et.id],
            event_group_rules=[
                {
                    "name": "page_select_sport_other_activity_*_chosen",
                    "condition_logic": "all",
                    "conditions": [
                        {
                            "field": "action",
                            "pattern": "^page_select_sport_other_activity_.*_chosen$",
                        }
                    ],
                }
            ],
        )
        sync_session.commit()

        # Both the single-line and the multi-line value collapse into one group.
        assert merged == 2
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert {event.source_name for event in events} == {
            "page_select_sport_other_activity_*_chosen"
        }

    def test_ensure_variable_tolerates_same_name_on_other_branch(
        self, sync_session: Session, project_and_type
    ):
        # Variable uniqueness is per (project_id, branch_id, source_name), so a working
        # plan branch can hold a same-named variable as main. An unscoped lookup spans
        # branches and used to raise "Multiple rows were found"; scoping to the scan's
        # main branch must find exactly the main-branch row (regression test).
        project, _et, _fds = project_and_type
        # The fixture's ORM inserts already auto-created the project's main branch.
        main_branch_id = _resolve_main_branch_id(sync_session, project.id)
        assert main_branch_id is not None
        working_branch = PlanBranch(
            id=uuid.uuid4(),
            project_id=project.id,
            name="feature",
            kind=BranchKind.working.value,
            status=BranchStatus.draft.value,
            description="",
        )
        sync_session.add(working_branch)
        sync_session.flush()
        for branch_id in (main_branch_id, working_branch.id):
            sync_session.add(
                Variable(
                    id=uuid.uuid4(),
                    project_id=project.id,
                    branch_id=branch_id,
                    name="property.spot_id",
                    source_name="property.spot_id",
                    variable_type="string",
                )
            )
        sync_session.commit()

        resolved = _resolve_main_branch_id(sync_session, project.id)
        assert resolved == main_branch_id

        # Scoped lookup finds the existing main-branch variable without raising.
        created = _ensure_variable(
            sync_session, project.id, "property.spot_id", "string", branch_id=resolved
        )
        assert created == 0

        variables = (
            sync_session.execute(select(Variable).where(Variable.source_name == "property.spot_id"))
            .scalars()
            .all()
        )
        assert len(variables) == 2  # nothing new created

    def test_ensure_variable_handles_integrity_race(
        self,
        sync_session: Session,
        project_and_type,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Concurrent inserts should be treated as 'already exists' (no exception)."""
        project, _et, _fds = project_and_type
        main_branch_id = _resolve_main_branch_id(sync_session, project.id)
        assert main_branch_id is not None

        original_flush = sync_session.flush
        state = {"raised": False}

        def _flush_once_fails(*args, **kwargs):
            has_target_pending = any(
                isinstance(obj, Variable) and obj.source_name == "property.concurrent"
                for obj in sync_session.new
            )
            if has_target_pending and not state["raised"]:
                state["raised"] = True
                raise IntegrityError("insert into variables", {}, Exception("duplicate key"))
            return original_flush(*args, **kwargs)

        monkeypatch.setattr(sync_session, "flush", _flush_once_fails)

        created = _ensure_variable(
            sync_session,
            project.id,
            "property.concurrent",
            "string",
            branch_id=main_branch_id,
        )
        assert created == 0

    def test_dedup_skips_existing(self, sync_session: Session, project_and_type):
        project, et, fds = project_and_type
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=2,
                is_low=True,
                sample_values=["/home", "/about"],
            ),
        }
        analysis = _make_analysis(cardinality)
        # First run
        result1 = generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()
        assert result1.events_created == 2

        # Second run — same data — should skip
        result2 = generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()
        assert result2.events_created == 0
        assert result2.events_skipped == 2

    def test_scan_preserves_authored_field_values_and_creates_missing_values(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        existing = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name="/home",
            source_name="/home",
            order=0,
            status="live",
        )
        sync_session.add(existing)
        sync_session.flush()
        sync_session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=existing.id,
                field_definition_id=fds["screen"].id,
                value="${screen}",
                is_authored=True,
            )
        )
        sync_session.commit()

        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=1,
                is_low=True,
                sample_values=["/home"],
            ),
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=1,
                is_low=True,
                sample_values=["view"],
            ),
        }
        analysis = _make_analysis(cardinality)

        first_result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{screen}",
        )
        sync_session.commit()

        assert first_result.events_created == 0
        assert first_result.events_skipped == 1
        first_values = {
            field_value.field_definition_id: field_value
            for field_value in sync_session.execute(
                select(EventFieldValue).where(EventFieldValue.event_id == existing.id)
            ).scalars()
        }
        assert first_values[fds["screen"].id].value == "${screen}"
        assert first_values[fds["screen"].id].is_authored is True
        assert first_values[fds["action"].id].value == "view"
        assert first_values[fds["action"].id].is_authored is False

        second_result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{screen}",
        )
        sync_session.commit()

        assert second_result.events_created == 0
        assert second_result.events_skipped == 1
        second_values = (
            sync_session.execute(
                select(EventFieldValue).where(EventFieldValue.event_id == existing.id)
            )
            .scalars()
            .all()
        )
        assert len(second_values) == 2
        second_values_by_field = {
            field_value.field_definition_id: field_value for field_value in second_values
        }
        assert second_values_by_field[fds["screen"].id].value == "${screen}"
        assert second_values_by_field[fds["screen"].id].is_authored is True
        assert second_values_by_field[fds["action"].id].value == "view"
        assert second_values_by_field[fds["action"].id].is_authored is False

    def test_rename_does_not_recreate_event(self, sync_session: Session, project_and_type):
        """Renaming an event's display ``name`` must not make the next scan duplicate it:
        dedup keys on the stable ``source_name`` identity, not ``name``."""
        project, et, fds = project_and_type
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=2,
                is_low=True,
                sample_values=["/home", "/about"],
            ),
        }
        analysis = _make_analysis(cardinality)
        r1 = generate_events(
            sync_session, project.id, et.id, analysis, fds, event_name_format="{screen}"
        )
        sync_session.commit()
        assert r1.events_created == 2

        # source_name is set to the scan identity on creation
        home = sync_session.execute(select(Event).where(Event.source_name == "/home")).scalar_one()
        assert home.name == "/home"
        # User renames the display name
        home.name = "Home Page (renamed)"
        sync_session.commit()

        # Re-scan same data: must match by source_name, not recreate
        r2 = generate_events(
            sync_session, project.id, et.id, analysis, fds, event_name_format="{screen}"
        )
        sync_session.commit()
        assert r2.events_created == 0
        assert r2.events_skipped == 2

        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert len(events) == 2  # no duplicate
        renamed = sync_session.execute(
            select(Event).where(Event.source_name == "/home")
        ).scalar_one()
        assert renamed.name == "Home Page (renamed)"  # rename preserved across scan

    def test_legacy_event_without_source_name_is_backfilled_not_duplicated(
        self, sync_session: Session, project_and_type
    ):
        """An event predating source_name (NULL) is adopted on the next scan instead of
        being recreated."""
        project, et, fds = project_and_type
        legacy = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name="/home",
            source_name=None,
            description="manually created",
            order=0,
            status="live",
        )
        sync_session.add(legacy)
        sync_session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=legacy.id,
                field_definition_id=fds["screen"].id,
                value="/home",
            )
        )
        sync_session.commit()

        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=1,
                is_low=True,
                sample_values=["/home"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session, project.id, et.id, analysis, fds, event_name_format="{screen}"
        )
        sync_session.commit()

        assert result.events_created == 0
        assert result.events_skipped == 1
        refreshed = sync_session.execute(select(Event).where(Event.id == legacy.id)).scalar_one()
        assert refreshed.source_name == "/home"  # backfilled

    def test_max_events_limit(self, sync_session: Session, project_and_type):
        project, et, fds = project_and_type
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=50,
                is_low=True,
                sample_values=[f"/page/{i}" for i in range(50)],
            ),
            "action": CardinalityResult(
                column=ColumnInfo("action", "String"),
                count=50,
                is_low=True,
                sample_values=[f"act_{i}" for i in range(50)],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            max_events=10,
        )
        sync_session.commit()
        assert result.events_created == 10

    def test_skips_unmatched_columns(self, sync_session: Session, project_and_type):
        project, et, fds = project_and_type
        cardinality = {
            "unknown_col": CardinalityResult(
                column=ColumnInfo("unknown_col", "String"),
                count=5,
                is_low=True,
                sample_values=["a", "b"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(sync_session, project.id, et.id, analysis, fds)
        assert result.events_created == 0
        assert "no matching field definition" in result.details[0].lower()

    def test_does_not_warn_about_a_column_this_event_type_never_fills(
        self, sync_session: Session, project_and_type
    ):
        """A grouped scan sees the whole table's columns on every event type.

        Warning about one that held nothing for these rows is noise, not a plan
        gap — the demo logged ~21 of them per scan (tripl-jfm3.57). ``count``
        excludes NULLs, so 0 means no value in any row of this group.
        """
        project, et, fds = project_and_type
        cardinality = {
            "belongs_to_another_event": CardinalityResult(
                column=ColumnInfo("belongs_to_another_event", "Float64"),
                count=0,
                is_low=True,
                sample_values=[],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(sync_session, project.id, et.id, analysis, fds)

        assert not any("no matching field definition" in d.lower() for d in result.details)
        # The separate "nothing matched at all" notice is a different, accurate
        # message and must survive — this test suppresses per-column noise, not
        # the summary that tells you the scan produced nothing.
        assert result.details == ["No columns matched field definitions"]

    def test_does_not_warn_about_a_reserved_column_that_carries_data(
        self, sync_session: Session, project_and_type
    ):
        """A reserved column has no FieldDefinition BY DESIGN, so saying so is wrong.

        app_version / platform / event-group-rule columns are metric dimensions
        or identity inputs, and ``reserved_catalog_columns`` is exactly what keeps
        them out of the catalog. Reporting their absence as a plan gap left a
        fresh demo's first scan claiming six missing fields when one was missing
        (tripl-jfm3.90). Unlike the count==0 case above, these columns DO carry
        data — the emptiness rule cannot cover them.
        """
        project, et, fds = project_and_type
        cardinality = {
            "app_version": CardinalityResult(
                column=ColumnInfo("app_version", "String"),
                count=12,
                is_low=True,
                sample_values=["7.1.0", "7.2.0"],
            ),
            "event_name": CardinalityResult(
                column=ColumnInfo("event_name", "String"),
                count=9,
                is_low=True,
                sample_values=["Home Screen View"],
            ),
            "screen_name": CardinalityResult(
                column=ColumnInfo("screen_name", "String"),
                count=7,
                is_low=True,
                sample_values=["home"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            reserved_columns={"app_version", "event_name"},
        )

        # 'screen_name' is genuinely undeclared and must still be reported — the
        # message stays useful precisely because the reserved ones stopped firing.
        assert [d for d in result.details if "no matching field definition" in d.lower()] == [
            "Skipped column 'screen_name': no matching field definition"
        ]

    def test_an_undeclared_column_still_reports_without_a_reserved_set(
        self, sync_session: Session, project_and_type
    ):
        """The default (no reserved_columns) must not silence anything."""
        project, et, fds = project_and_type
        cardinality = {
            "app_version": CardinalityResult(
                column=ColumnInfo("app_version", "String"),
                count=12,
                is_low=True,
                sample_values=["7.1.0"],
            ),
        }
        analysis = _make_analysis(cardinality)
        result = generate_events(sync_session, project.id, et.id, analysis, fds)

        assert any("no matching field definition" in d.lower() for d in result.details)

    def test_event_type_column_excluded(self, sync_session: Session, project_and_type):
        project, et, fds = project_and_type
        cardinality = {
            "event_type": CardinalityResult(
                column=ColumnInfo("event_type", "String"),
                count=3,
                is_low=True,
                sample_values=["pv", "se", "pp"],
            ),
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=2,
                is_low=True,
                sample_values=["/home", "/about"],
            ),
        }
        analysis = _make_analysis(cardinality)
        gen_result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_type_column="event_type",
        )
        sync_session.commit()
        # event_type column excluded → only screen → 2 events
        assert gen_result.events_created == 2

    def test_field_values_stored_correctly(self, sync_session: Session, project_and_type):
        project, et, fds = project_and_type
        cardinality = {
            "screen": CardinalityResult(
                column=ColumnInfo("screen", "String"),
                count=1,
                is_low=True,
                sample_values=["/home"],
            ),
        }
        analysis = _make_analysis(cardinality)
        generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()

        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert len(events) == 1

        fvs = (
            sync_session.execute(
                select(EventFieldValue).where(EventFieldValue.event_id == events[0].id)
            )
            .scalars()
            .all()
        )
        assert len(fvs) == 1
        assert fvs[0].value == "/home"
        assert fvs[0].field_definition_id == fds["screen"].id

    def test_json_paths_can_keep_selected_values_as_is(
        self,
        sync_session: Session,
        project_and_type,
    ):
        project, et, fds = project_and_type
        analysis = BreakdownAnalysis(
            results={
                "payload": CardinalityResult(
                    column=ColumnInfo("payload", "JSON"),
                    count=1,
                    is_low=True,
                    json_path_combos=[("extra.key", "locale")],
                ),
            },
            rows=[(("extra.key", "locale"), '"TASK-123"')],
            reg_names=[],
            json_names=["payload"],
            json_value_names=["payload.extra.key"],
        )

        result = generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()

        assert result.events_created == 1

        payload_value = sync_session.execute(
            select(EventFieldValue.value).where(
                EventFieldValue.field_definition_id == fds["payload"].id
            )
        ).scalar_one()
        assert payload_value == '{"extra": {"key": "TASK-123"}, "locale": "${locale}"}'

        variable_names = {
            variable.name
            for variable in sync_session.execute(
                select(Variable).where(Variable.project_id == project.id)
            ).scalars()
        }
        # Scan-created path variables get short display names (identity stays
        # on source_name/bindings).
        assert "locale" in variable_names
        assert "payload.locale" not in variable_names
        assert "extra.key" not in variable_names

    def test_longest_event_name_truncated(
        self,
        sync_session: Session,
        project_and_type,
    ):
        project, et, fds = project_and_type
        longest_name = "a" * 600
        analysis = BreakdownAnalysis(
            results={
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=1,
                    is_low=True,
                    sample_values=[longest_name],
                ),
            },
            rows=[(longest_name,)],
            reg_names=["screen"],
            json_names=[],
            json_value_names=[],
        )

        result = generate_events(
            sync_session,
            project.id,
            et.id,
            analysis,
            fds,
            event_name_format="{screen}",
        )
        sync_session.commit()

        assert result.events_created == 1
        events = (
            sync_session.execute(select(Event).where(Event.project_id == project.id))
            .scalars()
            .all()
        )
        assert len(events) == 1
        assert len(events[0].name) == 500
        assert events[0].name.endswith("...")

    def test_archived_event_not_in_events_by_name(
        self,
        sync_session: Session,
        project_and_type,
    ):
        project, et, fds = project_and_type
        analysis = BreakdownAnalysis(
            results={
                "screen": CardinalityResult(
                    column=ColumnInfo("screen", "String"),
                    count=1,
                    is_low=True,
                    sample_values=["/dashboard"],
                ),
            },
            rows=[("/dashboard",)],
            reg_names=["screen"],
            json_names=[],
            json_value_names=[],
        )

        # Create event and mark archived = True
        event = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name="screen=/dashboard",
            source_name="screen=/dashboard",
            status="archived",
            order=0,
        )
        sync_session.add(event)
        sync_session.commit()

        # Run generate_events
        result = generate_events(sync_session, project.id, et.id, analysis, fds)
        sync_session.commit()

        assert result.events_created == 0
        assert result.events_skipped == 1
        assert "screen=/dashboard" not in result.events_by_name


# --- binding-based adoption + token normalization (tripl-j94c.2) -------------


def _payload_locale_analysis() -> BreakdownAnalysis:
    return BreakdownAnalysis(
        results={
            "payload": CardinalityResult(
                column=ColumnInfo("payload", "JSON"),
                count=1,
                is_low=True,
                json_path_combos=[("locale",)],
            ),
        },
        rows=[(("locale",),)],
        reg_names=[],
        json_names=["payload"],
        json_value_names=[],
    )


def test_manual_variable_with_binding_is_adopted_not_duplicated(
    sync_session: Session, project_and_type
):
    project, et, fds = project_and_type
    manual = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="variant",
        variable_type="string",
        description="documented before implementation",
        bindings=["payload.locale"],
    )
    sync_session.add(manual)
    sync_session.commit()

    result = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()

    assert result.events_created == 1
    assert result.variables_created == 0

    variables = (
        sync_session.execute(select(Variable).where(Variable.project_id == project.id))
        .scalars()
        .all()
    )
    assert [v.name for v in variables] == ["variant"]
    # Adoption backfills the scan identity for future runs.
    assert variables[0].source_name == "payload.locale"

    # The stored template is normalized to the display name...
    payload_value = sync_session.execute(
        select(EventFieldValue.value).where(
            EventFieldValue.field_definition_id == fds["payload"].id
        )
    ).scalar_one()
    assert payload_value == '{"locale": "${variant}"}'

    # ...and the observation attributes to the manual variable.
    contexts = (
        sync_session.execute(select(VariableValue).where(VariableValue.project_id == project.id))
        .scalars()
        .all()
    )
    assert len(contexts) == 1
    assert contexts[0].variable_id == manual.id
    assert contexts[0].source_column == "payload.locale"


def test_scan_twice_with_adopted_binding_is_idempotent(sync_session: Session, project_and_type):
    project, et, fds = project_and_type
    sync_session.add(
        Variable(
            id=uuid.uuid4(),
            project_id=project.id,
            name="variant",
            variable_type="string",
            description="",
            bindings=["payload.locale"],
        )
    )
    sync_session.commit()

    first = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()
    second = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()

    assert first.events_created == 1
    assert second.events_created == 0
    assert second.events_skipped == 1
    assert second.variables_created == 0

    values = (
        sync_session.execute(
            select(EventFieldValue.value).where(
                EventFieldValue.field_definition_id == fds["payload"].id
            )
        )
        .scalars()
        .all()
    )
    assert values == ['{"locale": "${variant}"}']
    contexts = (
        sync_session.execute(select(VariableValue).where(VariableValue.project_id == project.id))
        .scalars()
        .all()
    )
    assert len(contexts) == 1


def test_renamed_scan_variable_keeps_matching_and_normalizes_on_rescan(
    sync_session: Session, project_and_type
):
    project, et, fds = project_and_type

    first = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()
    assert first.variables_created == 1

    scanned = sync_session.execute(
        select(Variable).where(Variable.project_id == project.id)
    ).scalar_one()
    assert scanned.name == "locale"
    assert scanned.source_name == "payload.locale"
    assert scanned.bindings == ["payload.locale"]

    # User renames the scan-created variable; identity lives in
    # source_name/bindings so the next scan must adopt, not duplicate.
    scanned.name = "locale_var"
    sync_session.commit()

    second = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()

    assert second.variables_created == 0
    variables = (
        sync_session.execute(select(Variable).where(Variable.project_id == project.id))
        .scalars()
        .all()
    )
    assert [v.name for v in variables] == ["locale_var"]

    # The rescan rewrote the stored template to the new display name.
    payload_value = sync_session.execute(
        select(EventFieldValue.value).where(
            EventFieldValue.field_definition_id == fds["payload"].id
        )
    ).scalar_one()
    assert payload_value == '{"locale": "${locale_var}"}'


# --- variable value drift detection (tripl-j94c.5) ---------------------------


def _drift_rows(session: Session, project_id):
    from tripl.models.variable_value_drift import VariableValueDrift

    return (
        session.execute(
            select(VariableValueDrift).where(VariableValueDrift.project_id == project_id)
        )
        .scalars()
        .all()
    )


def _make_context_entry(variable, event, fd, values):
    return {
        (variable.id, event.id, fd.id): {
            "variable_id": variable.id,
            "event_id": event.id,
            "field_definition_id": fd.id,
            "source_column": "screen",
            "value_kind": "low",
            "observed_count": len(values),
            "values": list(values),
        }
    }


def _seed_variable_event(sync_session: Session, project, et, fds, allowed_values):
    variable = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="variant",
        variable_type="string",
        description="",
        allowed_values=list(allowed_values),
        bindings=["screen"],
    )
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=et.id,
        name="Onboarding",
        description="",
        order=0,
    )
    sync_session.add_all([variable, event])
    sync_session.commit()
    return variable, event


def test_value_drift_detected_for_undocumented_values(sync_session: Session, project_and_type):
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a", "b"])

    detected = detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "x", "y"]),
    )
    sync_session.commit()

    assert detected == 1
    rows = _drift_rows(sync_session, project.id)
    assert len(rows) == 1
    assert rows[0].observed_values == ["x", "y"]
    assert rows[0].status == "open"


def test_value_drift_respects_event_override(sync_session: Session, project_and_type):
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts
    from tripl.models.variable_event_value_override import VariableEventValueOverride

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a", "b"])
    sync_session.add(
        VariableEventValueOverride(
            id=uuid.uuid4(),
            project_id=project.id,
            branch_id=variable.branch_id,
            variable_id=variable.id,
            event_id=event.id,
            values=["x"],
        )
    )
    sync_session.commit()

    detected = detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "x", "y"]),
    )
    sync_session.commit()

    # Override replaces the global list: "a" is novel now, "x" documented.
    assert detected == 1
    rows = _drift_rows(sync_session, project.id)
    assert rows[0].observed_values == ["a", "y"]


def test_value_drift_skipped_without_documented_contract(sync_session: Session, project_and_type):
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, [])

    detected = detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["whatever"]),
    )
    sync_session.commit()

    assert detected == 0
    assert _drift_rows(sync_session, project.id) == []


def test_value_drift_upsert_refreshes_without_reopening(sync_session: Session, project_and_type):
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a"])

    detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["x"]),
    )
    sync_session.commit()

    row = _drift_rows(sync_session, project.id)[0]
    row.status = "false_positive"
    sync_session.commit()

    detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["x", "z"]),
    )
    sync_session.commit()

    # The upsert bypasses the ORM identity map — expire before re-reading.
    sync_session.expire_all()
    rows = _drift_rows(sync_session, project.id)
    assert len(rows) == 1
    # Refresh updated the sample but did NOT reopen the resolution.
    assert rows[0].observed_values == ["x", "z"]
    assert rows[0].status == "false_positive"


def test_accepted_value_drift_reopens_on_value_outside_resolved_set(
    sync_session: Session, project_and_type
):
    """An accepted row must not silently absorb a value nobody accepted."""
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a"])

    detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "x"]),
    )
    sync_session.commit()

    # Accept exactly what the service does: the novel values join the
    # documented list and the row is resolved.
    row = _drift_rows(sync_session, project.id)[0]
    assert row.observed_values == ["x"]
    row.status = "accepted"
    row.resolved_at = datetime.now(UTC)
    row.resolution_note = "expected experiment arm"
    variable.allowed_values = ["a", "x"]
    sync_session.commit()

    # A later scan sees a value that was never part of the accepted set.
    detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "x", "z"]),
    )
    sync_session.commit()

    sync_session.expire_all()
    rows = _drift_rows(sync_session, project.id)
    assert len(rows) == 1
    assert rows[0].observed_values == ["z"]
    assert rows[0].status == "open"
    assert rows[0].resolved_at is None
    assert rows[0].resolution_note is None


def test_accepted_value_drift_stays_resolved_for_values_inside_resolved_set(
    sync_session: Session, project_and_type
):
    """Re-observing an already-accepted value must not re-nag.

    The pair carries an OVERRIDE, which is what decides novelty, while the
    acceptance was global and so landed in ``allowed_values``. That is the one
    shape where an accepted value legitimately keeps arriving as novel, and the
    row must stay resolved through it.
    """
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts
    from tripl.models.variable_event_value_override import VariableEventValueOverride
    from tripl.models.variable_value_drift import VariableValueDrift

    project, et, fds = project_and_type
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a", "x"])
    sync_session.add(
        VariableEventValueOverride(
            id=uuid.uuid4(),
            project_id=project.id,
            branch_id=variable.branch_id,
            variable_id=variable.id,
            event_id=event.id,
            values=["a"],
        )
    )
    resolved_at = datetime(2026, 1, 1, tzinfo=UTC)
    accepted = VariableValueDrift(
        id=uuid.uuid4(),
        project_id=project.id,
        variable_id=variable.id,
        event_id=event.id,
        observed_values=["x"],
        status="accepted",
        detected_at=resolved_at,
    )
    sync_session.add(accepted)
    sync_session.commit()

    detected = detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "x"]),
    )
    sync_session.commit()

    sync_session.expire_all()
    rows = _drift_rows(sync_session, project.id)
    assert detected == 0
    assert len(rows) == 1
    assert rows[0].status == "accepted"
    # The evidence is the resolved set and stays frozen, retention clock included.
    assert rows[0].observed_values == ["x"]
    assert rows[0].detected_at.replace(tzinfo=UTC) == resolved_at


def test_accepted_value_drift_reopens_on_a_value_it_only_absorbed(
    sync_session: Session, project_and_type
):
    """A value the row swallowed but nobody accepted must not stay suppressed.

    This is the population the bug created. Builds before the freeze refreshed
    ``observed_values`` on accepted rows, so a live row's stored evidence can
    hold values that were never accepted and therefore never documented. Reading
    that column as "the set the user accepted" would let the fix skip exactly the
    rows it exists for. Acceptance documents and absorption does not, so the
    documented lists are what tell the two apart — no migration can, after the
    fact.
    """
    from tripl.core.analyzers._variable_value_drift import detect_variable_value_drifts
    from tripl.models.variable_value_drift import VariableValueDrift

    project, et, fds = project_and_type
    # "a" is documented; "cart" was accepted (and documented with it). "promo_v2"
    # arrived a week later and was silently absorbed into the evidence.
    variable, event = _seed_variable_event(sync_session, project, et, fds, ["a", "cart"])
    accepted = VariableValueDrift(
        id=uuid.uuid4(),
        project_id=project.id,
        variable_id=variable.id,
        event_id=event.id,
        observed_values=["cart", "promo_v2"],
        status="accepted",
        resolution_note='accepted "cart"',
        detected_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    sync_session.add(accepted)
    sync_session.commit()

    detected = detect_variable_value_drifts(
        sync_session,
        project_id=project.id,
        branch_id=variable.branch_id,
        scan_config_id=None,
        contexts=_make_context_entry(variable, event, fds["screen"], ["a", "cart", "promo_v2"]),
    )
    sync_session.commit()

    sync_session.expire_all()
    rows = _drift_rows(sync_session, project.id)
    assert detected == 1
    assert len(rows) == 1
    assert rows[0].status == "open", "an undocumented value must not read as resolved"
    assert rows[0].observed_values == ["promo_v2"]


# --- authored provenance across grouping copies (tripl-j94c.9) ---------------


def test_group_merge_preserves_authorship_unless_rule_overrides(
    sync_session: Session, project_and_type
):
    project, et, fds = project_and_type
    for index, action in enumerate(["click:one", "click:two"]):
        event = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=et.id,
            name=action,
            source_name=action,
            order=index,
            status="implemented",
        )
        sync_session.add(event)
        sync_session.flush()
        # 'screen' is hand-authored and untouched by the rule; 'action' is the
        # matched field whose value the rule replaces with /pattern/.
        sync_session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=fds["screen"].id,
                value="${variant}",
                is_authored=True,
            )
        )
        sync_session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=fds["action"].id,
                value=action,
                is_authored=True,
            )
        )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=[
            {
                "name": "click events",
                "condition_logic": "all",
                "conditions": [{"field": "action", "pattern": "^click:"}],
            }
        ],
    )
    sync_session.commit()
    assert merged == 2

    grouped_event = sync_session.execute(
        select(Event).where(Event.project_id == project.id)
    ).scalar_one()
    values = {
        fv.field_definition_id: fv
        for fv in sync_session.execute(
            select(EventFieldValue).where(EventFieldValue.event_id == grouped_event.id)
        ).scalars()
    }
    # Untouched value keeps its authored provenance...
    assert values[fds["screen"].id].value == "${variant}"
    assert values[fds["screen"].id].is_authored is True
    # ...the rule-overridden value does not (it is no longer the user's text).
    assert values[fds["action"].id].value == "/^click:/"
    assert values[fds["action"].id].is_authored is False


# --- what a group merge carries off the event it deletes (tripl-xfxa) --------
#
# ``_merge_event_into_group`` ends in ``session.delete(source)``. Every one of
# these rows FKs to ``events.id`` with ``ondelete="CASCADE"`` and none of them
# is rebuilt by a later scan, so anything the merge does not explicitly move is
# gone for good. The engine has ``PRAGMA foreign_keys=ON`` (see ``_sqlite``);
# without it the cascade never fires and every assertion below passes vacuously.


_CLICK_GROUP_RULE = [
    {
        "name": "click events",
        "condition_logic": "all",
        "conditions": [{"field": "action", "pattern": "^click:"}],
    }
]


def _add_event(sync_session: Session, project, et, fds, *, name, screen, action, order):
    """Persist one catalog event with its two field values."""
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=et.id,
        name=name,
        source_name=name,
        order=order,
        status="implemented",
    )
    sync_session.add(event)
    sync_session.flush()
    sync_session.add_all(
        [
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=fds["screen"].id,
                value=screen,
            ),
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=fds["action"].id,
                value=action,
            ),
        ]
    )
    sync_session.flush()
    return event


def _add_variable(sync_session: Session, project, *, name, binding):
    variable = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name=name,
        source_name=binding,
        variable_type="string",
        description="",
        bindings=[binding],
    )
    sync_session.add(variable)
    sync_session.flush()
    return variable


def _add_context(sync_session: Session, project, variable, event, fd, *, values, count, kind):
    context = VariableValue(
        id=uuid.uuid4(),
        project_id=project.id,
        variable_id=variable.id,
        event_id=event.id,
        field_definition_id=fd.id,
        source_column=fd.name,
        value_kind=kind,
        observed_count=count,
        values=list(values),
    )
    sync_session.add(context)
    sync_session.flush()
    return context


def _contexts(sync_session: Session, project_id) -> list[VariableValue]:
    return list(
        sync_session.execute(
            select(VariableValue).where(VariableValue.project_id == project_id)
        ).scalars()
    )


def test_group_merge_moves_variable_contexts_onto_the_surviving_event(
    sync_session: Session, project_and_type
):
    # A context is only rewritten when the CURRENT run observes that (event,
    # field) pair again, so one that dies with the merged-away event is never
    # rebuilt: the variable keeps a live reference in the group event's field
    # value and an empty /values list forever. Re-pointing is the whole fix.
    project, et, fds = project_and_type
    variable = _add_variable(sync_session, project, name="variant", binding="screen")
    source = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click:one",
        screen="${variant}",
        action="click:one",
        order=0,
    )
    _add_context(
        sync_session,
        project,
        variable,
        source,
        fds["screen"],
        values=["a", "b"],
        count=7,
        kind="low",
    )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=_CLICK_GROUP_RULE,
    )
    sync_session.commit()

    assert merged == 1
    grouped_event = sync_session.execute(
        select(Event).where(Event.project_id == project.id)
    ).scalar_one()
    assert grouped_event.source_name == "click events"
    contexts = _contexts(sync_session, project.id)
    assert len(contexts) == 1
    # The context followed the volume, with its observations intact.
    assert contexts[0].event_id == grouped_event.id
    assert contexts[0].field_definition_id == fds["screen"].id
    assert contexts[0].values == ["a", "b"]
    assert contexts[0].observed_count == 7


def test_group_merge_folds_colliding_contexts_instead_of_violating_the_unique_constraint(
    sync_session: Session, project_and_type
):
    # uq_variable_value_context is the bare (variable_id, event_id,
    # field_definition_id), so a blanket ``UPDATE ... SET event_id`` would raise
    # on the second row. The fold is the one record_variable_contexts already
    # performs when two rows collapse onto one event: larger observed_count,
    # ``high`` wins the kind, union of the sampled values.
    project, et, fds = project_and_type
    variable = _add_variable(sync_session, project, name="variant", binding="screen")
    # The group event already exists, so it — not a freshly created row — is the
    # merge target, and the two sources collide against it in a fixed order.
    target = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click events",
        screen="${variant}",
        action="/^click:/",
        order=0,
    )
    _add_context(
        sync_session, project, variable, target, fds["screen"], values=["a"], count=3, kind="low"
    )
    source = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click:one",
        screen="${variant}",
        action="click:one",
        order=1,
    )
    _add_context(
        sync_session,
        project,
        variable,
        source,
        fds["screen"],
        values=["b", "c"],
        count=9,
        kind="high",
    )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=_CLICK_GROUP_RULE,
    )
    sync_session.commit()

    assert merged == 1
    assert sync_session.get(Event, source.id) is None
    contexts = _contexts(sync_session, project.id)
    assert len(contexts) == 1
    folded = contexts[0]
    assert folded.event_id == target.id
    assert folded.observed_count == 9
    # ``high`` is the wider claim about the value space, so it wins...
    assert folded.value_kind == "high"
    # ...and neither side's samples are dropped.
    assert set(folded.values) == {"a", "b", "c"}


def test_group_merge_drops_a_context_whose_token_is_gone_from_the_target_value(
    sync_session: Session, project_and_type
):
    # A rule replaces the matched field's value wholesale with /pattern/. A
    # context migrated onto that literal would assert a ${var} reference the
    # group event does not make. Dropping is per-field, not a blanket wipe:
    # the untouched field's context still moves.
    project, et, fds = project_and_type
    variable = _add_variable(sync_session, project, name="variant", binding="screen")
    source = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click:${variant}",
        screen="${variant}",
        action="click:${variant}",
        order=0,
    )
    _add_context(
        sync_session,
        project,
        variable,
        source,
        fds["action"],
        values=["x"],
        count=4,
        kind="low",
    )
    _add_context(
        sync_session,
        project,
        variable,
        source,
        fds["screen"],
        values=["y"],
        count=5,
        kind="low",
    )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=_CLICK_GROUP_RULE,
    )
    sync_session.commit()

    assert merged == 1
    grouped_event = sync_session.execute(
        select(Event).where(Event.project_id == project.id)
    ).scalar_one()
    values = {
        fv.field_definition_id: fv.value
        for fv in sync_session.execute(
            select(EventFieldValue).where(EventFieldValue.event_id == grouped_event.id)
        ).scalars()
    }
    # The rule rewrote 'action' and left 'screen' alone...
    assert values[fds["action"].id] == "/^click:/"
    assert values[fds["screen"].id] == "${variant}"
    # ...so only the 'screen' context survives, on the group event.
    contexts = _contexts(sync_session, project.id)
    assert len(contexts) == 1
    assert contexts[0].field_definition_id == fds["screen"].id
    assert contexts[0].event_id == grouped_event.id


def test_group_merge_moves_variable_event_overrides_and_lets_the_target_win(
    sync_session: Session, project_and_type
):
    # VariableEventValueOverride is written only through the API — the scan
    # pipeline never touches one — so letting it cascade away meant a scan
    # silently deleting a list a human typed. Nothing is folded: two authored
    # lists are two opinions, and merging them would invent a third nobody wrote.
    project, et, fds = project_and_type
    contested = _add_variable(sync_session, project, name="variant", binding="screen")
    uncontested = _add_variable(sync_session, project, name="locale", binding="payload.locale")
    target = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click events",
        screen="${variant}",
        action="/^click:/",
        order=0,
    )
    sync_session.add(
        VariableEventValueOverride(
            id=uuid.uuid4(),
            project_id=project.id,
            variable_id=contested.id,
            event_id=target.id,
            values=["kept-by-target"],
        )
    )
    source = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click:one",
        screen="${variant}",
        action="click:one",
        order=1,
    )
    sync_session.add_all(
        [
            VariableEventValueOverride(
                id=uuid.uuid4(),
                project_id=project.id,
                variable_id=contested.id,
                event_id=source.id,
                values=["dropped-on-collision"],
            ),
            VariableEventValueOverride(
                id=uuid.uuid4(),
                project_id=project.id,
                variable_id=uncontested.id,
                event_id=source.id,
                values=["carried-over"],
            ),
        ]
    )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=_CLICK_GROUP_RULE,
    )
    sync_session.commit()

    assert merged == 1
    overrides = {
        row.variable_id: row
        for row in sync_session.execute(select(VariableEventValueOverride)).scalars()
    }
    assert set(overrides) == {contested.id, uncontested.id}
    assert all(row.event_id == target.id for row in overrides.values())
    # The surviving event's own list stands; the source's uncontested one moves.
    assert overrides[contested.id].values == ["kept-by-target"]
    assert overrides[uncontested.id].values == ["carried-over"]


def test_group_merge_moves_variable_value_drifts_and_lets_the_target_win(
    sync_session: Session, project_and_type
):
    # A drift row carries accepted/snoozed/false_positive — a decision a person
    # made, and an ``accepted`` row is deliberately frozen against rescan.
    # Dropping it re-opens a question that was already answered.
    project, et, fds = project_and_type
    contested = _add_variable(sync_session, project, name="variant", binding="screen")
    uncontested = _add_variable(sync_session, project, name="locale", binding="payload.locale")
    target = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click events",
        screen="${variant}",
        action="/^click:/",
        order=0,
    )
    sync_session.add(
        VariableValueDrift(
            id=uuid.uuid4(),
            project_id=project.id,
            variable_id=contested.id,
            event_id=target.id,
            observed_values=["kept-by-target"],
            status="accepted",
        )
    )
    source = _add_event(
        sync_session,
        project,
        et,
        fds,
        name="click:one",
        screen="${variant}",
        action="click:one",
        order=1,
    )
    sync_session.add_all(
        [
            VariableValueDrift(
                id=uuid.uuid4(),
                project_id=project.id,
                variable_id=contested.id,
                event_id=source.id,
                observed_values=["dropped-on-collision"],
                status="open",
            ),
            VariableValueDrift(
                id=uuid.uuid4(),
                project_id=project.id,
                variable_id=uncontested.id,
                event_id=source.id,
                observed_values=["carried-over"],
                status="false_positive",
            ),
        ]
    )
    sync_session.commit()

    merged = merge_existing_events_for_group_rules(
        sync_session,
        project_id=project.id,
        event_type_ids=[et.id],
        event_group_rules=_CLICK_GROUP_RULE,
    )
    sync_session.commit()

    assert merged == 1
    drifts = {
        row.variable_id: row for row in sync_session.execute(select(VariableValueDrift)).scalars()
    }
    assert set(drifts) == {contested.id, uncontested.id}
    assert all(row.event_id == target.id for row in drifts.values())
    # The surviving event's triage is the more recent judgement...
    assert drifts[contested.id].observed_values == ["kept-by-target"]
    assert drifts[contested.id].status == "accepted"
    # ...and the uncontested decision moves across with its resolution intact.
    assert drifts[uncontested.id].observed_values == ["carried-over"]
    assert drifts[uncontested.id].status == "false_positive"


def test_scan_short_names_extend_on_collision(sync_session: Session, project_and_type):
    from tripl.core.analyzers._event_generator_variables import (
        VariableIndex,
        derive_display_name,
    )

    project, et, fds = project_and_type
    taken = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="locale",
        variable_type="string",
        description="",
        bindings=["settings.locale"],
    )
    sync_session.add(taken)
    sync_session.commit()

    index = VariableIndex([taken])
    # Last segment is claimed -> extend with the parent segment; raw path is
    # the final fallback when everything is taken.
    assert derive_display_name("payload.locale", index) == "payload_locale"
    assert derive_display_name("user.Name-Full.v2", index) == "v2"
    assert derive_display_name("plain_column", index) == "plain_column"


def test_excluded_variable_is_not_recreated_or_attributed(sync_session: Session, project_and_type):
    project, et, fds = project_and_type
    tombstone = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="locale",
        source_name="payload.locale",
        variable_type="string",
        description="",
        bindings=["payload.locale"],
        excluded_from_scans=True,
    )
    sync_session.add(tombstone)
    sync_session.commit()

    result = generate_events(sync_session, project.id, et.id, _payload_locale_analysis(), fds)
    sync_session.commit()

    # The tombstone prevents re-creation...
    assert result.variables_created == 0
    variables = (
        sync_session.execute(select(Variable).where(Variable.project_id == project.id))
        .scalars()
        .all()
    )
    assert [v.name for v in variables] == ["locale"]
    # ...no observed contexts accumulate...
    contexts = (
        sync_session.execute(select(VariableValue).where(VariableValue.project_id == project.id))
        .scalars()
        .all()
    )
    assert contexts == []
    # ...and the scan-written value keeps the raw token (no normalization to
    # an excluded variable's display name).
    payload_value = sync_session.execute(
        select(EventFieldValue.value).where(
            EventFieldValue.field_definition_id == fds["payload"].id
        )
    ).scalar_one()
    assert payload_value == '{"locale": "${payload.locale}"}'

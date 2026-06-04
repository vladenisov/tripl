"""Unit tests for the event generator module."""

import uuid
from datetime import datetime
from itertools import product

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from tripl.models import Base
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.plan_branch import BranchKind, BranchStatus, PlanBranch
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.cardinality import BreakdownAnalysis, CardinalityResult
from tripl.worker.analyzers.event_generator import (
    _ensure_variable,
    _resolve_main_branch_id,
    generate_events,
    merge_existing_events_for_group_rules,
)


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
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    session = factory()
    yield session
    session.close()
    Base.metadata.drop_all(engine)


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
            implemented=True,
            reviewed=True,
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
        action_values = [
            fv for fv in field_values if fv.field_definition_id == fds["action"].id
        ]
        assert len(action_values) == 1

    def test_group_rule_merges_existing_matching_events_and_metrics(
        self, sync_session: Session, project_and_type
    ):
        project, et, fds = project_and_type
        scan_config_id = uuid.uuid4()
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
                implemented=True,
                reviewed=True,
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
                implemented=True,
                reviewed=True,
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
                implemented=True,
                reviewed=True,
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
            sync_session.execute(
                select(Variable).where(Variable.source_name == "property.spot_id")
            )
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
                isinstance(obj, Variable) and obj.name == "property.concurrent"
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
            implemented=True,
            reviewed=True,
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
        assert payload_value == '{"extra": {"key": "TASK-123"}, "locale": "${payload.locale}"}'

        variable_names = {
            variable.name
            for variable in sync_session.execute(
                select(Variable).where(Variable.project_id == project.id)
            ).scalars()
        }
        assert "payload.locale" in variable_names
        assert "payload.extra.key" not in variable_names

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
            archived=True,
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

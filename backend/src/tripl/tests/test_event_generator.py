"""Unit tests for the event generator module."""

import uuid
from itertools import product

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.models import Base
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.cardinality import BreakdownAnalysis, CardinalityResult
from tripl.worker.analyzers.event_generator import generate_events


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

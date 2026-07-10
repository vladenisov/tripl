"""Alert-rule integration for variable value drifts (tripl-j94c.13)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from tripl.alerting_matching import (
    SCOPE_VARIABLE_VALUE_DRIFT,
    DriftAlertCandidate,
    rule_matches_anomaly,
)
from tripl.models import Base
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.variable import Variable
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.worker.tasks.metrics.signals import _get_active_variable_value_drift_candidates


def _build_rule(**overrides: object) -> AlertRule:
    defaults: dict[str, object] = {
        "id": uuid.uuid4(),
        "destination_id": uuid.uuid4(),
        "name": "Value drift rule",
        "enabled": True,
        "include_project_total": True,
        "include_event_types": True,
        "include_events": True,
        "include_schema_drifts": False,
        "include_distribution_drifts": False,
        "include_release_regressions": False,
        "notify_on_spike": True,
        "notify_on_drop": True,
        "min_percent_delta": 0.0,
        "min_absolute_delta": 0,
        "min_expected_count": 0,
        "cooldown_minutes": 60,
        "message_template": None,
        "items_template": None,
        "message_format": "plain",
    }
    defaults.update(overrides)
    rule = AlertRule(**defaults)
    rule.filters = []
    return rule


def _candidate() -> DriftAlertCandidate:
    return DriftAlertCandidate(
        id=uuid.uuid4(),
        scope_type=SCOPE_VARIABLE_VALUE_DRIFT,
        scope_ref=str(uuid.uuid4()),
        event_id=uuid.uuid4(),
        event_type_id=None,
        bucket=datetime(2026, 7, 10, 12, tzinfo=UTC),
        direction="spike",
        actual_count=2,
        expected_count=0,
        drift_field="variant",
        drift_type="value_drift",
        sample_value="x, y",
    )


def test_rule_gate_requires_include_variable_value_drifts():
    candidate = _candidate()
    assert rule_matches_anomaly(_build_rule(), candidate) is False
    enabled = _build_rule(
        include_variable_value_drifts=True,
        min_percent_delta=999,
        min_absolute_delta=999,
        min_expected_count=999,
    )
    assert rule_matches_anomaly(enabled, candidate) is True


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
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_candidates_built_from_active_drifts(sync_session: Session):
    project = Project(id=uuid.uuid4(), name="P", slug="vvd-alerts", description="")
    sync_session.add(project)
    sync_session.flush()
    data_source = DataSource(
        id=uuid.uuid4(),
        name="wh",
        db_type="clickhouse",
        host="localhost",
        port=9000,
        database_name="db",
        username="u",
        password_encrypted="x",
    )
    sync_session.add(data_source)
    sync_session.flush()
    config = ScanConfig(
        id=uuid.uuid4(),
        project_id=project.id,
        data_source_id=data_source.id,
        name="scan",
        base_query="SELECT * FROM events",
    )
    event_type = EventType(
        id=uuid.uuid4(), project_id=project.id, name="pv", display_name="PV", description=""
    )
    sync_session.add_all([config, event_type])
    sync_session.flush()
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=event_type.id,
        name="Onboarding",
        description="",
        order=0,
    )
    variable = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="variant",
        variable_type="string",
        description="",
    )
    sync_session.add_all([event, variable])
    sync_session.flush()

    active = VariableValueDrift(
        project_id=project.id,
        variable_id=variable.id,
        event_id=event.id,
        scan_config_id=config.id,
        observed_values=["x", "y"],
        detected_at=datetime.now(UTC),
    )
    snoozed_future = VariableValueDrift(
        project_id=project.id,
        variable_id=variable.id,
        event_id=event.id,
        scan_config_id=config.id,
        observed_values=["z"],
        status="snoozed",
        snoozed_until=datetime.now(UTC) + timedelta(days=5),
        detected_at=datetime.now(UTC),
    )
    # uq is (variable_id, event_id) — use a second event for the snoozed row.
    event2 = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=event_type.id,
        name="Checkout",
        description="",
        order=1,
    )
    sync_session.add(event2)
    sync_session.flush()
    snoozed_future.event_id = event2.id
    sync_session.add_all([active, snoozed_future])
    sync_session.commit()

    candidates = _get_active_variable_value_drift_candidates(sync_session, config)

    assert len(candidates) == 1
    candidate = next(iter(candidates.values()))
    assert candidate.scope_type == SCOPE_VARIABLE_VALUE_DRIFT
    assert candidate.scope_ref == str(active.id)
    assert candidate.event_id == event.id
    assert candidate.drift_field == "variant"
    assert candidate.drift_type == "value_drift"
    assert candidate.sample_value == "x, y"

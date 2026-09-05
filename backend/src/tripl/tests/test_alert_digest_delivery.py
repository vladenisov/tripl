"""Scheduled alert digests: buffer while held, deliver on the cadence.

A destination with ``delivery_schedule_cron`` set stops delivering after every
metrics collection. Its matched signals accumulate in ``alert_pending_items``
and ``flush_due_alert_digests`` turns them into ordinary deliveries when a cron
boundary passes.

The properties worth pinning are the ones the feature would be worthless
without: an alert is never lost across a flush boundary, never sent twice, and
the message carries the numbers as of the moment it was SENT rather than the
moment the incident opened.

Sync sqlite fixtures mirror ``test_metric_anomaly_scope.py``.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.models import Base
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_pending_item import AlertPendingItem
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.worker.tasks import alert_flush
from tripl.worker.tasks.metrics import dispatch as metrics_dispatch

# Recent, hour-aligned and tz-naive, matching the sync fixtures' bucket columns.
_BUCKET = datetime.now(UTC).replace(minute=0, second=0, microsecond=0, tzinfo=None) - timedelta(
    hours=2
)
# Fires every minute, so any flush with a watermark in the past is due. Used
# wherever the test is about the flush mechanism rather than about cron itself.
_ALWAYS_DUE = "* * * * *"
# Fires once a day at 09:00; with a watermark of "just now" nothing is due.
_DAILY = "0 9 * * *"


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'alert_digest.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
        Base.metadata.drop_all(engine)
    finally:
        engine.dispose()


def _seed(
    session: Session,
    *,
    cron: str | None,
    last_flushed_at: datetime | None = None,
    timezone: str = "UTC",
) -> tuple[ScanConfig, AlertDestination, AlertRule, EventType]:
    """A project with one scan, one destination, one rule and one event type."""
    project = Project(
        id=uuid.uuid4(),
        name="Digest",
        slug=f"digest-{uuid.uuid4().hex[:8]}",
        description="",
        timezone=timezone,
    )
    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"DS {uuid.uuid4().hex[:8]}",
        db_type="clickhouse",
        host="localhost",
        port=8123,
        database_name="default",
        username="default",
        password_encrypted="",
    )
    config = ScanConfig(
        id=uuid.uuid4(),
        data_source_id=data_source.id,
        project_id=project.id,
        name="Scan",
        base_query="SELECT time, event_name FROM events",
        time_column="time",
        cardinality_threshold=100,
        interval="1h",
    )
    settings = ProjectAnomalySettings(
        project_id=project.id,
        anomaly_detection_enabled=True,
        sigma_threshold=3.0,
        min_expected_count=10,
    )
    event_type = EventType(
        id=uuid.uuid4(),
        project_id=project.id,
        name="page",
        display_name="Page",
        description="",
    )
    destination = AlertDestination(
        id=uuid.uuid4(),
        project_id=project.id,
        type="slack",
        name="Main Slack",
        enabled=True,
        webhook_url_encrypted="secret",
        delivery_schedule_cron=cron,
        last_flushed_at=last_flushed_at,
    )
    rule = AlertRule(
        id=uuid.uuid4(),
        destination_id=destination.id,
        name="Everything",
        enabled=True,
        include_project_total=False,
        include_event_types=True,
        include_events=False,
        notify_on_spike=True,
        notify_on_drop=True,
        min_percent_delta=0,
        min_absolute_delta=0,
        min_expected_count=0,
        cooldown_minutes=1440,
    )
    session.add_all([project, data_source, config, settings, event_type, destination, rule])
    session.commit()
    return config, destination, rule, event_type


def _fire_anomaly(
    session: Session,
    config: ScanConfig,
    event_type: EventType,
    *,
    actual: float,
    bucket: datetime | None = None,
) -> None:
    """Replace the scope's live anomaly, the way a recalculation would.

    The stored bucket goes in too: dispatch only treats a scope as a live
    candidate while the scan has metrics for it, so an anomaly with no
    EventMetric behind it is invisible to the alert path.
    """
    at = bucket or _BUCKET
    session.execute(
        MetricAnomaly.__table__.delete().where(MetricAnomaly.scan_config_id == config.id)
    )
    session.add(
        EventMetric(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_id=None,
            event_type_id=event_type.id,
            bucket=at,
            count=int(actual),
        )
    )
    session.add(
        MetricAnomaly(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_type_id=event_type.id,
            event_id=None,
            scope_type="event_type",
            scope_ref=str(event_type.id),
            bucket=at,
            direction="spike",
            actual_count=actual,
            expected_count=10.0,
            stddev=1.0,
            z_score=10.0,
        )
    )
    session.commit()


def _run_flush(
    monkeypatch: pytest.MonkeyPatch,
    factory: sessionmaker[Session],
) -> tuple[dict[str, int], list[str]]:
    enqueued: list[str] = []
    from tripl.worker.tasks import alerts as alerts_module

    monkeypatch.setattr(alert_flush, "_get_sync_session", factory)
    monkeypatch.setattr(
        alerts_module.send_alert_delivery,
        "delay",
        lambda delivery_id: enqueued.append(delivery_id),
    )
    return alert_flush.flush_due_alert_digests.run(), enqueued


# ── buffering ─────────────────────────────────────────────────────────────


def test_a_scheduled_destination_buffers_instead_of_delivering(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, destination, rule, event_type = _seed(session, cron=_DAILY)
        _fire_anomaly(session, config, event_type, actual=200.0)

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        assert delivery_ids == []
        assert session.execute(select(AlertDelivery)).scalars().all() == []
        buffered = session.execute(select(AlertPendingItem)).scalars().all()
        assert len(buffered) == 1
        assert buffered[0].destination_id == destination.id
        assert buffered[0].rule_id == rule.id
        assert buffered[0].actual_count == 200.0
        assert buffered[0].observation_count == 1


def test_an_immediate_destination_still_delivers_on_the_spot(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The upgrade must be invisible to anyone who sets no cadence."""
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(session, cron=None)
        _fire_anomaly(session, config, event_type, actual=200.0)

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        assert len(delivery_ids) == 1
        assert session.execute(select(AlertPendingItem)).scalars().all() == []
        assert len(session.execute(select(AlertDeliveryItem)).scalars().all()) == 1


def test_a_scope_that_keeps_firing_collapses_to_one_row_with_the_latest_numbers(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The whole point of "aggregated up to the moment it is sent".

    Twenty-four collections of one still-broken scope must not become
    twenty-four lines, and the line that ships must carry the LAST reading, not
    the first.
    """
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(session, cron=_DAILY)

        _fire_anomaly(session, config, event_type, actual=200.0, bucket=_BUCKET)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        _fire_anomaly(
            session, config, event_type, actual=999.0, bucket=_BUCKET + timedelta(hours=1)
        )
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        buffered = session.execute(select(AlertPendingItem)).scalars().all()
        assert len(buffered) == 1
        assert buffered[0].actual_count == 999.0
        assert buffered[0].observation_count == 2


def test_a_later_collection_of_an_older_bucket_never_rewinds_the_numbers(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(session, cron=_DAILY)

        _fire_anomaly(
            session, config, event_type, actual=999.0, bucket=_BUCKET + timedelta(hours=1)
        )
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        _fire_anomaly(session, config, event_type, actual=200.0, bucket=_BUCKET)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        buffered = session.execute(select(AlertPendingItem)).scalars().one()
        assert buffered.actual_count == 999.0


# ── flushing ──────────────────────────────────────────────────────────────


def test_the_flusher_mints_a_delivery_and_empties_the_buffer(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, destination, _rule, event_type = _seed(
            session,
            cron=_ALWAYS_DUE,
            last_flushed_at=datetime.now(UTC) - timedelta(hours=2),
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 1
    assert result["deliveries"] == 1
    assert len(enqueued) == 1

    with sync_session_factory() as session:
        delivery = session.execute(select(AlertDelivery)).scalars().one()
        assert delivery.destination_id == destination.id
        assert delivery.status == "pending"
        assert delivery.matched_count == 1
        item = session.execute(select(AlertDeliveryItem)).scalars().one()
        assert item.actual_count == 200.0
        # The buffer is claimed by deletion in the same transaction that minted
        # the delivery, so it is empty and cannot be shipped a second time.
        assert session.execute(select(AlertPendingItem)).scalars().all() == []
        refreshed = session.get(AlertDestination, destination.id)
        assert refreshed is not None and refreshed.last_flushed_at is not None


def test_a_second_flush_inside_the_same_window_sends_nothing(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The compare-and-set on last_flushed_at is the no-double-send guard."""
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(
            session,
            cron=_DAILY,
            last_flushed_at=datetime.now(UTC) - timedelta(days=2),
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    first, first_enqueued = _run_flush(monkeypatch, sync_session_factory)
    second, second_enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert first["flushed"] == 1
    assert second["flushed"] == 0
    assert len(first_enqueued) == 1
    assert second_enqueued == []

    with sync_session_factory() as session:
        assert len(session.execute(select(AlertDelivery)).scalars().all()) == 1


def test_an_alert_that_arrives_after_the_claim_lands_in_the_next_digest_exactly_once(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The boundary race, which is the user's literal requirement.

    A buffered row is claimed by DELETING it in the transaction that mints the
    delivery — no timestamp predicate anywhere. So a row that becomes visible
    after a flush has taken its snapshot is simply still buffered, and ships in
    the NEXT digest. It is never dropped, and never sent twice.
    """
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(
            session,
            cron=_ALWAYS_DUE,
            last_flushed_at=datetime.now(UTC) - timedelta(hours=2),
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    _run_flush(monkeypatch, sync_session_factory)

    # Arrives after the first digest was claimed and sent.
    with sync_session_factory() as session:
        config = session.execute(select(ScanConfig)).scalars().one()
        event_type = session.execute(select(EventType)).scalars().one()
        _fire_anomaly(
            session, config, event_type, actual=555.0, bucket=_BUCKET + timedelta(hours=1)
        )
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    with sync_session_factory() as session:
        destination = session.execute(select(AlertDestination)).scalars().one()
        destination.last_flushed_at = datetime.now(UTC) - timedelta(hours=1)
        session.commit()

    _run_flush(monkeypatch, sync_session_factory)

    with sync_session_factory() as session:
        items = session.execute(select(AlertDeliveryItem).join(AlertDelivery)).scalars().all()
        actuals = sorted(item.actual_count for item in items)
        # Both readings delivered, each exactly once.
        assert actuals == [200.0, 555.0]
        assert len(session.execute(select(AlertDelivery)).scalars().all()) == 2
        assert session.execute(select(AlertPendingItem)).scalars().all() == []


def test_an_empty_window_sends_nothing_but_still_advances_the_watermark(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not cosmetic: a watermark that did not advance would make the next
    alert to arrive flush within the minute, turning a daily destination back
    into a near-immediate one — the exact bug being fixed."""
    before = datetime.now(UTC) - timedelta(days=2)
    with sync_session_factory() as session:
        _seed(session, cron=_DAILY, last_flushed_at=before)

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 0
    assert enqueued == []
    with sync_session_factory() as session:
        assert session.execute(select(AlertDelivery)).scalars().all() == []
        destination = session.execute(select(AlertDestination)).scalars().one()
        assert destination.last_flushed_at is not None
        assert destination.last_flushed_at > before


def test_a_destination_whose_cadence_has_not_come_round_is_left_alone(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(
            session, cron=_DAILY, last_flushed_at=datetime.now(UTC)
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 0
    assert enqueued == []
    with sync_session_factory() as session:
        # Held, not lost.
        assert len(session.execute(select(AlertPendingItem)).scalars().all()) == 1


def test_a_destination_with_no_watermark_adopts_the_clock_without_dumping_a_backlog(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(
            session, cron=_ALWAYS_DUE, last_flushed_at=None
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 0
    assert enqueued == []
    with sync_session_factory() as session:
        destination = session.execute(select(AlertDestination)).scalars().one()
        assert destination.last_flushed_at is not None
        assert len(session.execute(select(AlertPendingItem)).scalars().all()) == 1


def test_muting_a_monitor_during_the_hold_window_keeps_it_out_of_the_digest(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On a daily cadence the hold window is a whole day, so suppression has to
    be re-checked when the digest is built, not only when it was buffered."""
    with sync_session_factory() as session:
        config, _destination, rule, event_type = _seed(
            session,
            cron=_ALWAYS_DUE,
            last_flushed_at=datetime.now(UTC) - timedelta(hours=2),
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()

        session.get(AlertRule, rule.id).muted_until = datetime.now(UTC) + timedelta(hours=6)
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 0
    assert enqueued == []
    with sync_session_factory() as session:
        assert session.execute(select(AlertDelivery)).scalars().all() == []
        # Claimed and dropped, not left to re-deliver the moment the mute lapses.
        assert session.execute(select(AlertPendingItem)).scalars().all() == []


def test_a_disabled_destination_is_never_flushed(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, destination, _rule, event_type = _seed(
            session,
            cron=_ALWAYS_DUE,
            last_flushed_at=datetime.now(UTC) - timedelta(hours=2),
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.get(AlertDestination, destination.id).enabled = False
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["checked"] == 0
    assert enqueued == []


def test_buffer_rows_older_than_the_max_age_are_swept(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backstop for a cadence that will not fire again in any useful time."""
    with sync_session_factory() as session:
        config, _destination, _rule, event_type = _seed(
            session, cron=_DAILY, last_flushed_at=datetime.now(UTC)
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()
        stale = session.execute(select(AlertPendingItem)).scalars().one()
        stale.updated_at = datetime.now(UTC) - alert_flush.PENDING_ITEM_MAX_AGE * 2
        session.commit()

    result, _enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["swept"] == 1
    with sync_session_factory() as session:
        assert session.execute(select(AlertPendingItem)).scalars().all() == []


def test_switching_back_to_immediate_ships_what_was_still_being_held(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Turning the cadence off must not strand a day of alerts.

    The scheduled loop only looks at destinations that HAVE a cadence, so
    without the drain arm these rows would sit until the age sweep quietly
    dropped them — a silent loss of exactly the alerts the operator turned the
    schedule off to start receiving again.
    """
    with sync_session_factory() as session:
        config, destination, _rule, event_type = _seed(
            session, cron=_DAILY, last_flushed_at=datetime.now(UTC)
        )
        _fire_anomaly(session, config, event_type, actual=200.0)
        metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)
        session.commit()
        assert len(session.execute(select(AlertPendingItem)).scalars().all()) == 1

        # Back to immediate.
        session.get(AlertDestination, destination.id).delivery_schedule_cron = None
        session.commit()

    result, enqueued = _run_flush(monkeypatch, sync_session_factory)

    assert result["flushed"] == 1
    assert len(enqueued) == 1
    with sync_session_factory() as session:
        assert len(session.execute(select(AlertDelivery)).scalars().all()) == 1
        assert session.execute(select(AlertPendingItem)).scalars().all() == []
        refreshed = session.execute(select(AlertDestination)).scalars().one()
        assert refreshed.last_flushed_at is None

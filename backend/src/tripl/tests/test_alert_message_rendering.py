"""Rendering-side alert defects: the release-regression trend and message length.

Both are about what the reader is shown, so both are exercised through the
renderer rather than through a send.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
    get_default_items_template,
)
from tripl.alerting_matching import SCOPE_RELEASE_REGRESSION
from tripl.anomaly_context import load_recent_metric_points
from tripl.models import Base
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.worker.tasks.alerts_messages import (
    _TELEGRAM_AI_NOTE_RESERVE,
    TELEGRAM_MESSAGE_MAX_CHARS,
    _build_items_text,
    _default_items_max_chars,
    _is_telegram_markdown_parse_error,
    _is_telegram_message_too_long_error,
    _render_delivery_message,
    _telegram_items_max_chars,
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
        Base.metadata.drop_all(engine)
        engine.dispose()


def _seed_event_with_metrics(session: Session) -> tuple[uuid.UUID, uuid.UUID, datetime]:
    """One event carrying 24 hourly EventMetric buckets. Returns (scan, event, last)."""
    project = Project(id=uuid.uuid4(), name="P", slug="rr-trend", description="")
    session.add(project)
    session.flush()
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
    session.add(data_source)
    session.flush()
    config = ScanConfig(
        id=uuid.uuid4(),
        project_id=project.id,
        data_source_id=data_source.id,
        name="scan",
        base_query="SELECT * FROM events",
        app_version_column="app_version",
    )
    event_type = EventType(
        id=uuid.uuid4(), project_id=project.id, name="pv", display_name="PV", description=""
    )
    session.add_all([config, event_type])
    session.flush()
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=event_type.id,
        name="main:tap:snippet",
        description="",
        order=0,
    )
    session.add(event)
    session.flush()

    last_bucket = datetime(2026, 8, 4, 19, tzinfo=UTC)
    for hours_ago in range(24):
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                event_id=event.id,
                event_type_id=event_type.id,
                bucket=last_bucket - timedelta(hours=hours_ago),
                count=100 + hours_ago,
            )
        )
    session.flush()
    return config.id, event.id, last_bucket


def test_release_regression_scope_gets_no_metric_series(sync_session: Session) -> None:
    """A release-regression scope_ref IS an event id, so the old fall-through
    resolved it and plotted the event's all-versions volume under a
    release-cohort headline (delivery d4d8cf9e). The event scope still plots."""
    scan_config_id, event_id, last_bucket = _seed_event_with_metrics(sync_session)

    assert (
        load_recent_metric_points(
            sync_session,
            scan_config_id=scan_config_id,
            scope_type=SCOPE_RELEASE_REGRESSION,
            scope_ref=str(event_id),
            until=last_bucket,
        )
        == []
    )

    event_points = load_recent_metric_points(
        sync_session,
        scan_config_id=scan_config_id,
        scope_type="event",
        scope_ref=str(event_id),
        until=last_bucket,
    )
    assert len(event_points) == 24


def _item(index: int, *, scope_type: str = "event") -> AlertDeliveryItem:
    return AlertDeliveryItem(
        id=uuid.uuid4(),
        delivery_id=uuid.uuid4(),
        scope_type=scope_type,
        scope_ref=str(uuid.uuid4()),
        scope_name=f"main:tap:snippet:{index}",
        bucket=datetime(2026, 8, 4, 19, tzinfo=UTC),
        direction="drop",
        actual_count=15403,
        expected_count=32048,
        absolute_delta=16645,
        percent_delta=51.9,
        # The optional lines are what make a real item ~350 characters; the
        # production URLs are this long.
        details_path=f"https://tripl.windyapp.co/p/windy-ios/monitoring/event/{uuid.uuid4()}",
        monitoring_path=f"https://tripl.windyapp.co/p/windy-ios/events/detail/{uuid.uuid4()}",
    )


def _render(items: list[AlertDeliveryItem], *, max_chars: int | None) -> str:
    return _build_items_text(
        items,
        message_format=ALERT_MESSAGE_FORMAT_PLAIN,
        items_template=get_default_items_template(ALERT_MESSAGE_FORMAT_PLAIN),
        max_chars=max_chars,
    )


def _shown_indices(text: str, total: int) -> list[int]:
    """Which items survived. An item spans several lines, so count scope names."""
    return [i for i in range(total) if f"main:tap:snippet:{i}:" in text]


def test_items_text_is_uncapped_without_a_budget() -> None:
    """No budget, no truncation — email and webhook renders are unchanged."""
    items = [_item(i) for i in range(14)]
    text = _render(items, max_chars=None)
    assert _shown_indices(text, 14) == list(range(14))
    assert "more of" not in text


def test_items_text_stops_at_the_budget_and_says_how_many_it_dropped() -> None:
    items = [_item(i) for i in range(14)]
    budget = _telegram_items_max_chars(ai_explanation_enabled=True)
    text = _render(items, max_chars=budget)

    assert len(text) <= budget
    shown = _shown_indices(text, 14)
    assert 0 < len(shown) < 14
    # The head is a head: the rendered items are the first ones, in order, so an
    # already severity-ordered delivery loses its smallest rows and nothing else.
    assert shown == list(range(len(shown)))
    assert text.splitlines()[-1] == (
        f"… +{14 - len(shown)} more of 14 not shown (message length limit)"
    )


def test_budget_leaves_room_for_the_header_and_the_ai_note() -> None:
    """The whole Telegram message, not just items_text, has to clear 4096."""
    items = [_item(i) for i in range(14)]
    budget = _telegram_items_max_chars(ai_explanation_enabled=True)
    text = _render(items, max_chars=budget)
    # Header and AI note at the reserves the constants promise.
    header = "[tripl] 14 alerts\nProject delivery via telegram: Test\nRule: TG dev\nScan: S\n\n"
    ai_note = "\n\nAI: " + "x" * 1200
    assert len(header) + len(text) + len(ai_note) <= TELEGRAM_MESSAGE_MAX_CHARS


def test_a_single_oversized_item_is_still_rendered() -> None:
    """An items_text of nothing but a tail reports a count and shows no alert."""
    text = _render([_item(0)], max_chars=10)
    assert "main:tap:snippet:0" in text
    assert "more of" not in text


def test_tail_is_escaped_for_the_target_format() -> None:
    """MarkdownV2 reserves '+', '(' and '.', so an unescaped tail 400s the send
    exactly like the too-long body it exists to prevent."""
    items = [_item(i) for i in range(14)]
    text = _build_items_text(
        items,
        message_format=ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
        items_template=get_default_items_template(ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2),
        max_chars=_telegram_items_max_chars(ai_explanation_enabled=False),
    )
    tail = text.splitlines()[-1]
    assert tail.startswith("… \\+")
    assert "\\(message length limit\\)" in tail


def test_the_cap_follows_the_destination_not_the_message_format() -> None:
    """All 29 deliveries this instance has sent are Telegram rendering `plain`.

    Keying the default off the message format would have capped only the two
    Telegram-exclusive formats and left that live rule — the one that can
    actually hit the 4096 ceiling — uncapped.
    """
    assert _default_items_max_chars(
        AlertDestinationType.telegram, ai_explanation_enabled=True
    ) == _telegram_items_max_chars(ai_explanation_enabled=True)
    # Channels with no comparable per-message ceiling stay uncapped.
    for other in (
        AlertDestinationType.slack,
        AlertDestinationType.email,
        AlertDestinationType.webhook,
        AlertDestinationType.jira,
        AlertDestinationType.linear,
    ):
        assert _default_items_max_chars(other, ai_explanation_enabled=True) is None
    # A rule without an AI note gets the note's reserve back.
    assert _telegram_items_max_chars(ai_explanation_enabled=False) > _telegram_items_max_chars(
        ai_explanation_enabled=True
    )


def test_live_telegram_plain_delivery_is_rendered_under_the_ceiling() -> None:
    """End to end on the shape that actually sends here: Telegram + `plain`.

    The delivery that reaches 4096 has never occurred — all 29 sent deliveries
    are 1-5 items, the longest 2420 characters — so this is the prospective
    failure, driven at 14 items of the measured ~355-character size.
    """
    destination = AlertDestination(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        type=AlertDestinationType.telegram,
        name="Test",
    )
    rule = AlertRule(
        id=uuid.uuid4(),
        destination_id=destination.id,
        name="TG dev",
        message_format=ALERT_MESSAGE_FORMAT_PLAIN,
        ai_explanation_enabled=True,
    )
    delivery = AlertDelivery(
        id=uuid.uuid4(),
        project_id=destination.project_id,
        scan_config_id=uuid.uuid4(),
        destination_id=destination.id,
        rule_id=rule.id,
        channel=AlertDestinationType.telegram,
        matched_count=14,
    )
    delivery.items = [_item(i) for i in range(14)]

    text, message_format = _render_delivery_message(
        delivery,
        destination=destination,
        rule=rule,
        scan_name="Snowplow Events (iOS)",
        project=Project(id=delivery.project_id, name="windy-ios", slug="windy-ios", description=""),
    )

    assert message_format == ALERT_MESSAGE_FORMAT_PLAIN
    # The AI note is appended after this by the dispatcher, so the reserve for it
    # has to still be free once the rendered body is counted.
    assert len(text) + _TELEGRAM_AI_NOTE_RESERVE <= TELEGRAM_MESSAGE_MAX_CHARS
    assert "not shown (message length limit)" in text


def test_too_long_error_is_recognised_and_is_not_a_parse_error() -> None:
    """The message _post_json actually raises for an over-4096 body."""
    too_long = ValueError(
        "HTTP 400 from https://api.telegram.org/bot***/sendMessage: "
        "Bad Request: message is too long"
    )
    assert _is_telegram_message_too_long_error(too_long) is True
    # Re-rendering as plain text does not shorten a too-long message, so this
    # must NOT route into the MarkdownV2 fallback.
    assert _is_telegram_markdown_parse_error(too_long) is False

    parse_error = ValueError(
        "HTTP 400 from https://api.telegram.org/bot***/sendMessage: "
        "Bad Request: can't parse entities: Character '-' is reserved"
    )
    assert _is_telegram_message_too_long_error(parse_error) is False

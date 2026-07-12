import base64
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from tripl.models import Base
from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.event import Event, EventStatus
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.tests.conftest import TestSessionLocal
from tripl.worker.tasks import metrics
from tripl.worker.tasks.alerts import check_deprecated_sunset_events


@pytest.mark.parametrize(
    ("message_format", "expected_mrkdwn"),
    [
        ("plain", False),
        ("slack_mrkdwn", True),
    ],
)
def test_send_slack_message_sets_mrkdwn_per_format(
    monkeypatch: pytest.MonkeyPatch, message_format: str, expected_mrkdwn: bool
) -> None:
    """The Slack payload must honor message_format via the ``mrkdwn`` flag:
    plain disables Slack markup, slack_mrkdwn enables it."""
    from tripl.worker.tasks import alerts

    captured: dict[str, object] = {}

    def capture_post_json(url: str, body: dict[str, object]) -> None:
        captured["url"] = url
        captured["body"] = body

    monkeypatch.setattr(alerts, "_post_json", capture_post_json)
    alerts._send_slack_message(
        "https://hooks.slack.com/services/T/B/sim",
        "hello",
        message_format=message_format,
    )
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["text"] == "hello"
    assert body["mrkdwn"] is expected_mrkdwn


@pytest.mark.asyncio
async def test_schema_drift_accept_action_updates_plan(client: AsyncClient) -> None:
    await client.post(
        "/api/v1/projects",
        json={"name": "Drift Workflow", "slug": "drift-workflow", "description": ""},
    )
    event_type_resp = await client.post(
        "/api/v1/projects/drift-workflow/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    event_type_id = event_type_resp.json()["id"]
    async with TestSessionLocal() as session:
        drift = SchemaDrift(
            event_type_id=uuid.UUID(event_type_id),
            scan_config_id=None,
            field_name="payload",
            drift_type="new_field",
            observed_type="JSON",
            declared_type=None,
            sample_value='{"x":1}',
        )
        session.add(drift)
        await session.commit()
        drift_id = drift.id

    resp = await client.post(
        f"/api/v1/projects/drift-workflow/event-types/drifts/{drift_id}/actions",
        json={"action": "accept", "note": "Looks expected"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"
    async with TestSessionLocal() as session:
        field = await session.scalar(
            select(FieldDefinition).where(
                FieldDefinition.event_type_id == uuid.UUID(event_type_id),
                FieldDefinition.name == "payload",
            )
        )
        assert field is not None
        assert field.field_type == "json"


@pytest.mark.asyncio
async def test_alert_inbox_false_positive_updates_state_and_thresholds(
    client: AsyncClient,
) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Inbox Workflow", "slug": "inbox-workflow", "description": ""},
    )
    project_id = uuid.UUID(project_resp.json()["id"])
    group_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        event_type = EventType(
            project_id=project_id,
            name="track",
            display_name="Track",
            description="",
        )
        data_source = DataSource(
            name="Warehouse",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        session.add_all([event_type, data_source])
        await session.flush()
        config = ScanConfig(
            project_id=project_id,
            data_source_id=data_source.id,
            event_type_id=event_type.id,
            name="Events",
            base_query="SELECT * FROM events",
            time_column="time",
            interval="1h",
            sigma_threshold=3.0,
            min_expected_count=10,
        )
        destination = AlertDestination(
            project_id=project_id,
            type="slack",
            name="Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        session.add_all([config, destination])
        await session.flush()
        rule = AlertRule(
            destination_id=destination.id,
            name="Rule",
            enabled=True,
            include_project_total=True,
            include_event_types=True,
            include_events=True,
            notify_on_spike=True,
            notify_on_drop=True,
            min_percent_delta=0,
            min_absolute_delta=0,
            min_expected_count=0,
            cooldown_minutes=60,
        )
        settings = ProjectAnomalySettings(
            project_id=project_id,
            anomaly_detection_enabled=True,
            sigma_threshold=3.0,
            min_expected_count=10,
        )
        session.add_all([rule, settings])
        await session.flush()
        delivery = AlertDelivery(
            project_id=project_id,
            scan_config_id=config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            status="sent",
            channel="slack",
            matched_count=2,
        )
        session.add(delivery)
        await session.flush()
        for name in ("purchase", "refund"):
            session.add(
                AlertDeliveryItem(
                    delivery_id=delivery.id,
                    scope_type="event_type",
                    scope_ref=str(event_type.id),
                    scope_name=name,
                    event_type_id=event_type.id,
                    event_id=None,
                    bucket=datetime(2026, 1, 1, tzinfo=UTC),
                    direction="spike",
                    actual_count=20,
                    expected_count=10,
                    absolute_delta=10,
                    percent_delta=100.0,
                    correlation_group_id=group_id,
                )
            )
        await session.commit()
        config_id = config.id

    list_resp = await client.get("/api/v1/projects/inbox-workflow/alert-inbox")
    assert list_resp.status_code == 200
    assert list_resp.json()["total"] == 1

    action_resp = await client.post(
        f"/api/v1/projects/inbox-workflow/alert-inbox/{group_id}/actions",
        json={"action": "false_positive", "note": "Noisy deploy window"},
    )

    assert action_resp.status_code == 200
    assert action_resp.json()["status"] == "false_positive"
    async with TestSessionLocal() as session:
        state = await session.scalar(
            select(AlertCorrelationState).where(
                AlertCorrelationState.correlation_group_id == group_id
            )
        )
        assert state is not None
        assert state.false_positive_count == 1
        config = await session.get(ScanConfig, config_id)
        assert config is not None
        assert config.sigma_threshold == 3.5
        assert config.min_expected_count == 15


@pytest.mark.asyncio
async def test_alerting_destination_rule_crud_and_secret_masking(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Alerting Project", "slug": "alerting-project", "description": ""},
    )
    assert project_resp.status_code == 201

    event_type_resp = await client.post(
        "/api/v1/projects/alerting-project/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    assert event_type_resp.status_code == 201
    event_type_id = event_type_resp.json()["id"]

    field_resp = await client.post(
        f"/api/v1/projects/alerting-project/event-types/{event_type_id}/fields",
        json={
            "name": "name",
            "display_name": "Name",
            "field_type": "string",
            "is_required": True,
        },
    )
    assert field_resp.status_code == 201
    field_id = field_resp.json()["id"]

    event_resp = await client.post(
        "/api/v1/projects/alerting-project/events",
        json={
            "event_type_id": event_type_id,
            "name": "purchase:success",
            "field_values": [{"field_definition_id": field_id, "value": "purchase:success"}],
        },
    )
    assert event_resp.status_code == 201
    event_id = event_resp.json()["id"]

    destination_resp = await client.post(
        "/api/v1/projects/alerting-project/alert-destinations",
        json={
            "type": "slack",
            "name": "Main Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    assert destination_resp.status_code == 201
    destination = destination_resp.json()
    assert destination["type"] == "slack"
    assert destination["webhook_set"] is True
    assert "webhook_url" not in destination
    destination_id = destination["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/alerting-project/alert-destinations/{destination_id}/rules",
        json={
            "name": "Main Rule",
            "enabled": True,
            "include_project_total": True,
            "include_event_types": True,
            "include_events": True,
            "notify_on_spike": True,
            "notify_on_drop": False,
            "min_percent_delta": 15,
            "min_absolute_delta": 5,
            "min_expected_count": 10,
            "cooldown_minutes": 60,
            "message_format": "slack_mrkdwn",
            "message_template": "*Matched:* ${matched_count}\n${items_text}",
            "items_template": "*${scope_name}* ${actual_count}/${expected_count}",
            "filters": [
                {"field": "event_type", "operator": "not_in", "values": [event_type_id]},
                {"field": "event", "operator": "not_in", "values": [event_id]},
            ],
        },
    )
    assert rule_resp.status_code == 201
    rule = rule_resp.json()
    assert rule["notify_on_drop"] is False
    assert rule["message_format"] == "slack_mrkdwn"
    assert rule["message_template"] == "*Matched:* ${matched_count}\n${items_text}"
    assert rule["items_template"] == "*${scope_name}* ${actual_count}/${expected_count}"
    assert rule["filters"] == [
        {
            "field": "event_type",
            "operator": "not_in",
            "values": [event_type_id],
            "id": rule["filters"][0]["id"],
        },
        {
            "field": "event",
            "operator": "not_in",
            "values": [event_id],
            "id": rule["filters"][1]["id"],
        },
    ]

    list_resp = await client.get("/api/v1/projects/alerting-project/alert-destinations")
    assert list_resp.status_code == 200
    listed = list_resp.json()
    assert len(listed) == 1
    assert listed[0]["rules"][0]["id"] == rule["id"]

    update_resp = await client.patch(
        f"/api/v1/projects/alerting-project/alert-destinations/{destination_id}",
        json={"enabled": False},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["enabled"] is False


@pytest.mark.asyncio
async def test_alerting_destination_validates_credentials(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Alert Validation", "slug": "alert-validation", "description": ""},
    )
    assert project_resp.status_code == 201

    telegram_resp = await client.post(
        "/api/v1/projects/alert-validation/alert-destinations",
        json={
            "type": "telegram",
            "name": "Ops Bot",
            "enabled": True,
            "bot_token": "123456:abc def",
            "chat_id": "-100123",
        },
    )
    assert telegram_resp.status_code == 422
    assert "bot_token" in telegram_resp.text

    slack_resp = await client.post(
        "/api/v1/projects/alert-validation/alert-destinations",
        json={
            "type": "slack",
            "name": "Main Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    assert slack_resp.status_code == 201
    destination_id = slack_resp.json()["id"]

    update_resp = await client.patch(
        f"/api/v1/projects/alert-validation/alert-destinations/{destination_id}",
        json={"webhook_url": "https://hooks.slack.com/services/T000 /B000/XXX"},
    )
    assert update_resp.status_code == 422
    assert "webhook_url" in update_resp.text


@pytest.mark.asyncio
async def test_alerting_webhook_destination_crud_and_validation(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Webhook Alerts", "slug": "webhook-alerts", "description": ""},
    )
    assert project_resp.status_code == 201

    # Non-https target rejected.
    bad_url_resp = await client.post(
        "/api/v1/projects/webhook-alerts/alert-destinations",
        json={"type": "webhook", "name": "Bad", "target_url": "http://example.com/hook"},
    )
    assert bad_url_resp.status_code == 422
    assert "target_url" in bad_url_resp.text

    # A secret header requires both name and value.
    pair_resp = await client.post(
        "/api/v1/projects/webhook-alerts/alert-destinations",
        json={
            "type": "webhook",
            "name": "Pair",
            "target_url": "https://example.com/hook",
            "webhook_header_name": "Authorization",
        },
    )
    assert pair_resp.status_code == 422

    create_resp = await client.post(
        "/api/v1/projects/webhook-alerts/alert-destinations",
        json={
            "type": "webhook",
            "name": "Ops Webhook",
            "target_url": "https://example.com/hook",
            "webhook_header_name": "Authorization",
            "webhook_header_value": "Bearer secret",
        },
    )
    assert create_resp.status_code == 201
    destination = create_resp.json()
    assert destination["type"] == "webhook"
    assert destination["target_url_set"] is True
    assert destination["webhook_header_name"] == "Authorization"
    # Secrets are never echoed back.
    assert "target_url" not in destination
    assert "webhook_header_value" not in destination
    destination_id = destination["id"]

    bad_update = await client.patch(
        f"/api/v1/projects/webhook-alerts/alert-destinations/{destination_id}",
        json={"target_url": "ftp://example.com/hook"},
    )
    assert bad_update.status_code == 422
    assert "target_url" in bad_update.text

    good_update = await client.patch(
        f"/api/v1/projects/webhook-alerts/alert-destinations/{destination_id}",
        json={"target_url": "https://example.com/hook2", "name": "Renamed"},
    )
    assert good_update.status_code == 200
    assert good_update.json()["name"] == "Renamed"
    assert good_update.json()["target_url_set"] is True


@pytest.mark.asyncio
async def test_alert_delivery_list_and_detail(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Alert Audit", "slug": "alert-audit", "description": ""},
    )
    assert project_resp.status_code == 201
    project_id = project_resp.json()["id"]

    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Audit DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=uuid.UUID(project_id),
            name="Audit Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=uuid.UUID(project_id),
            type="slack",
            name="Audit Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Audit Rule",
            enabled=True,
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=uuid.UUID(project_id),
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="slack",
            status="sent",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
            sent_at=datetime(2026, 4, 11, 10, tzinfo=UTC),
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            event_id=None,
            event_type_id=None,
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path="http://localhost:5173/p/alert-audit/monitoring/event/event-1",
            monitoring_path="http://localhost:5173/p/alert-audit/monitoring/event/event-1",
        )
        session.add_all([data_source, scan_config, destination, rule, delivery, item])
        await session.commit()
        delivery_id = str(delivery.id)
        destination_id = str(destination.id)

    list_resp = await client.get(
        f"/api/v1/projects/alert-audit/alert-deliveries?channel=slack&destination_id={destination_id}"
    )
    assert list_resp.status_code == 200
    body = list_resp.json()
    assert body["total"] == 1
    assert body["items"][0]["destination_name"] == "Audit Slack"
    assert body["items"][0]["rule_name"] == "Audit Rule"

    detail_resp = await client.get(f"/api/v1/projects/alert-audit/alert-deliveries/{delivery_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["items"][0]["direction"] == "drop"
    assert detail["items"][0]["monitoring_path"].endswith("/monitoring/event/event-1")


def test_send_alert_delivery_fails_with_invalid_stored_telegram_token(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="telegram",
            name="Ops Bot",
            enabled=True,
            bot_token_encrypted="123456:abc def",
            chat_id="-100123",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="telegram",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="event-1",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "failed"
    assert "Telegram destination configuration is invalid" in result["error"]

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_renders_telegram_html_template(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_template_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_payload: dict[str, object] = {}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="telegram",
            name="Ops Bot",
            enabled=True,
            bot_token_encrypted="123456:ABC_def",
            chat_id="-100123",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_template=("<b>Items</b>\n${items_text}"),
            items_template=(
                "<b>${scope_name}</b> ${actual_count}/${expected_count}"
                "${details_line}${monitoring_line}"
            ),
            message_format="telegram_html",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="telegram",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase & success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path="https://app.example.com/details/1",
            monitoring_path="https://app.example.com/monitoring/1",
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def capture_post_json(url: str, body: dict[str, object]) -> None:
        sent_payload["url"] = url
        sent_payload["body"] = body

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "sent"
    assert sent_payload["url"] == "https://api.telegram.org/bot123456:ABC_def/sendMessage"
    assert sent_payload["body"] == {
        "chat_id": "-100123",
        "text": (
            "<b>Items</b>\n"
            "<b>purchase &amp; success</b> 10/20\n"
            "  details: https://app.example.com/details/1\n"
            "  monitoring: https://app.example.com/monitoring/1"
        ),
        "disable_web_page_preview": True,
        "parse_mode": "HTML",
    }

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value
        assert persisted.error_message is None
        assert persisted.payload_snapshot is not None
        assert persisted.payload_snapshot["message_format"] == "telegram_html"
        assert persisted.payload_snapshot["rendered_message"] == (
            "<b>Items</b>\n"
            "<b>purchase &amp; success</b> 10/20\n"
            "  details: https://app.example.com/details/1\n"
            "  monitoring: https://app.example.com/monitoring/1"
        )

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_uses_default_template_for_selected_format(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_default_template_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_payload: dict[str, object] = {}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="telegram",
            name="Ops Bot",
            enabled=True,
            bot_token_encrypted="123456:ABC_def",
            chat_id="-100123",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_template=None,
            message_format="telegram_html",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="telegram",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase & success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path="https://app.example.com/details/1",
            monitoring_path="https://app.example.com/monitoring/1",
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def capture_post_json(url: str, body: dict[str, object]) -> None:
        sent_payload["url"] = url
        sent_payload["body"] = body

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "sent"
    assert sent_payload["body"] == {
        "chat_id": "-100123",
        "text": (
            "<b>[tripl] 1 alerts</b>\n"
            "Project delivery via telegram: Ops Bot\n"
            "Rule: <b>Main Rule</b>\n"
            "Scan: <code>Runtime Scan</code>\n\n"
            "- Event purchase &amp; success: down, actual=10, expected=20, delta=10 (50.0%)\n"
            "  details: https://app.example.com/details/1\n"
            "  monitoring: https://app.example.com/monitoring/1"
        ),
        "disable_web_page_preview": True,
        "parse_mode": "HTML",
    }

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.payload_snapshot is not None
        assert persisted.payload_snapshot["message_format"] == "telegram_html"
        assert persisted.payload_snapshot["rendered_message"] == (
            "<b>[tripl] 1 alerts</b>\n"
            "Project delivery via telegram: Ops Bot\n"
            "Rule: <b>Main Rule</b>\n"
            "Scan: <code>Runtime Scan</code>\n\n"
            "- Event purchase &amp; success: down, actual=10, expected=20, delta=10 (50.0%)\n"
            "  details: https://app.example.com/details/1\n"
            "  monitoring: https://app.example.com/monitoring/1"
        )

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_persists_rendered_message_on_send_failure(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_send_failure_snapshot.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="telegram",
            name="Ops Bot",
            enabled=True,
            bot_token_encrypted="123456:ABC_def",
            chat_id="-100123",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_template="[tripl] ${matched_count} alerts\n${items_text}",
            message_format="telegram_markdownv2",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="telegram",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def fail_post_json(url: str, body: dict[str, object]) -> None:
        raise ValueError("HTTP 400 from https://api.telegram.org/bot***/sendMessage: Bad Request")

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        fail_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "failed"
    assert "Bad Request" in result["error"]

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.failed.value
        assert persisted.payload_snapshot is not None
        assert persisted.payload_snapshot["message_format"] == "telegram_markdownv2"
        assert isinstance(persisted.payload_snapshot.get("rendered_message"), str)
        assert persisted.payload_snapshot["rendered_message"]

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_falls_back_from_telegram_markdownv2_to_plain(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_markdown_fallback.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_payloads: list[dict[str, object]] = []

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="telegram",
            name="Ops Bot",
            enabled=True,
            bot_token_encrypted="123456:ABC_def",
            chat_id="-100123",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_template="[tripl] ${matched_count} alerts\n${items_text}",
            message_format="telegram_markdownv2",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="telegram",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def flaky_post_json(url: str, body: dict[str, object]) -> None:
        sent_payloads.append(body)
        if len(sent_payloads) == 1:
            raise ValueError(
                "HTTP 400 from https://api.telegram.org/bot***/sendMessage: "
                "Bad Request: can't parse entities: Character '-' is reserved "
                "and must be escaped with the preceding '\\'"
            )

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        flaky_post_json,
    )

    # The sparkline/top-movers DB build must run ONCE even though we render the
    # message twice (MarkdownV2 then the plain fallback) — the fallback reuses
    # the cached context instead of re-querying.
    from tripl.worker.tasks import alerts_messages as alerts_messages_module

    real_build_context = alerts_messages_module.build_alert_item_context
    build_context_calls = 0

    def counting_build_context(*args: object, **kwargs: object) -> tuple[str, str]:
        nonlocal build_context_calls
        build_context_calls += 1
        return real_build_context(*args, **kwargs)

    monkeypatch.setattr(alerts_messages_module, "build_alert_item_context", counting_build_context)

    result = metrics.send_alert_delivery.run(delivery_id)

    assert build_context_calls == 1
    assert result["status"] == "sent"
    assert len(sent_payloads) == 2
    assert sent_payloads[0]["parse_mode"] == "MarkdownV2"
    assert "parse_mode" not in sent_payloads[1]
    assert sent_payloads[1]["text"] == (
        "[tripl] 1 alerts\n- Event purchase:success: down, actual=10, expected=20, delta=10 (50.0%)"
    )

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value
        assert persisted.payload_snapshot is not None
        assert persisted.payload_snapshot["requested_message_format"] == "telegram_markdownv2"
        assert persisted.payload_snapshot["message_format"] == "plain"
        assert persisted.payload_snapshot["fallback_reason"] == "telegram_markdown_parse_error"

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_posts_generic_webhook(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_webhook_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent: dict[str, object] = {}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(),
            name="Alert Runtime",
            slug="alert-runtime",
            description="",
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        # Secrets are stored encrypted; in dev/test the crypto layer is a
        # passthrough, so plaintext here round-trips through _decrypt_secret.
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="webhook",
            name="Ops Webhook",
            enabled=True,
            target_url_encrypted="https://example.com/hook",
            webhook_header_name="X-Webhook-Token",
            webhook_header_value_encrypted="secret-abc",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="webhook",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def capture_post_json(url: str, body: dict[str, object], headers: dict[str, str] | None = None):
        sent["url"] = url
        sent["body"] = body
        sent["headers"] = headers

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "sent"
    assert sent["url"] == "https://example.com/hook"
    assert sent["headers"] == {"X-Webhook-Token": "secret-abc"}
    body = sent["body"]
    assert isinstance(body, dict)
    assert body["matched_count"] == 1
    assert body["rule"]["name"] == "Main Rule"
    assert body["scan"]["name"] == "Runtime Scan"
    assert body["project"]["slug"] == "alert-runtime"
    assert len(body["items"]) == 1
    assert body["items"][0]["scope_name"] == "purchase:success"
    assert body["items"][0]["direction"] == "drop"
    assert isinstance(body["message"], str)
    assert "purchase:success" in body["message"]

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value
        assert persisted.error_message is None

    Base.metadata.drop_all(engine)
    engine.dispose()


def _build_rule(**overrides: object) -> AlertRule:
    defaults: dict[str, object] = {
        "id": uuid.uuid4(),
        "destination_id": uuid.uuid4(),
        "name": "Test rule",
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


def _build_anomaly(
    bucket: datetime,
    *,
    scope_type: str = "event",
    scope_ref: str | None = None,
    direction: str = "spike",
    actual_count: int = 100,
    expected_count: float = 10.0,
) -> object:
    from tripl.models.metric_anomaly import MetricAnomaly

    return MetricAnomaly(
        id=uuid.uuid4(),
        scan_config_id=uuid.uuid4(),
        scope_type=scope_type,
        scope_ref=scope_ref or str(uuid.uuid4()),
        event_id=None,
        event_type_id=None,
        bucket=bucket,
        actual_count=actual_count,
        expected_count=expected_count,
        stddev=1.0,
        z_score=5.0,
        direction=direction,
    )


def test_simulate_rule_firings_applies_cooldown_per_scope() -> None:
    from tripl.alerting_matching import simulate_rule_firings

    rule = _build_rule(cooldown_minutes=60)
    scope_a = str(uuid.uuid4())
    scope_b = str(uuid.uuid4())
    base = datetime(2026, 5, 1, 12, tzinfo=UTC)

    anomalies = [
        # Scope A: 3 anomalies at 0, 30min, 90min → cooldown=60min admits 1st and 3rd.
        _build_anomaly(base, scope_ref=scope_a),
        _build_anomaly(base.replace(hour=12, minute=30), scope_ref=scope_a),
        _build_anomaly(base.replace(hour=14), scope_ref=scope_a),
        # Scope B: independent cooldown — 1 anomaly admitted.
        _build_anomaly(base.replace(hour=12, minute=15), scope_ref=scope_b),
    ]

    fired = simulate_rule_firings(rule, anomalies)
    fired_keys = [(a.scope_ref, a.bucket) for a in fired]
    assert fired_keys == [
        (scope_a, base),
        (scope_b, base.replace(hour=12, minute=15)),
        (scope_a, base.replace(hour=14)),
    ]


def test_simulate_rule_firings_skips_scope_disabled_by_rule() -> None:
    from tripl.alerting_matching import simulate_rule_firings

    rule = _build_rule(include_events=False, cooldown_minutes=0)
    base = datetime(2026, 5, 1, 12, tzinfo=UTC)

    anomalies = [
        _build_anomaly(base, scope_type="event"),
        _build_anomaly(base, scope_type="event_type"),
    ]
    fired = simulate_rule_firings(rule, anomalies)
    assert [a.scope_type for a in fired] == ["event_type"]


def test_schema_drift_rule_matching_uses_scope_gate_not_metric_thresholds() -> None:
    from tripl.alerting_matching import SchemaDriftAlertCandidate, rule_matches_anomaly

    candidate = SchemaDriftAlertCandidate(
        id=uuid.uuid4(),
        scope_type="schema",
        scope_ref=str(uuid.uuid4()),
        event_id=None,
        event_type_id=uuid.uuid4(),
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="spike",
        actual_count=1,
        expected_count=0,
        drift_field="payload.extra",
        drift_type="new_field",
        sample_value="TASK-123",
    )

    disabled_rule = _build_rule(include_schema_drifts=False)
    assert rule_matches_anomaly(disabled_rule, candidate) is False

    enabled_rule = _build_rule(
        include_schema_drifts=True,
        min_percent_delta=999,
        min_absolute_delta=999,
        min_expected_count=999,
    )
    assert rule_matches_anomaly(enabled_rule, candidate) is True


def test_distribution_drift_rule_matching_uses_scope_gate_not_metric_thresholds() -> None:
    from tripl.alerting_matching import (
        SCOPE_DISTRIBUTION_DRIFT,
        DistributionDriftAlertCandidate,
        rule_matches_anomaly,
    )

    candidate = DistributionDriftAlertCandidate(
        id=uuid.uuid4(),
        scope_type=SCOPE_DISTRIBUTION_DRIFT,
        scope_ref="distribution-scope",
        event_id=None,
        event_type_id=uuid.uuid4(),
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="spike",
        actual_count=1000,
        expected_count=1000,
        drift_field="platform",
        drift_type="distribution_shift",
        sample_value="psi=0.400; ios 50.0%->90.0%",
    )

    disabled_rule = _build_rule(include_distribution_drifts=False)
    assert rule_matches_anomaly(disabled_rule, candidate) is False

    enabled_rule = _build_rule(
        include_distribution_drifts=True,
        min_percent_delta=999,
        min_absolute_delta=999,
        min_expected_count=999,
    )
    assert rule_matches_anomaly(enabled_rule, candidate) is True


def test_release_regression_rule_matching_uses_scope_gate_not_metric_thresholds() -> None:
    from tripl.alerting_matching import (
        SCOPE_RELEASE_REGRESSION,
        DriftAlertCandidate,
        rule_matches_anomaly,
    )

    candidate = DriftAlertCandidate(
        id=uuid.uuid4(),
        scope_type=SCOPE_RELEASE_REGRESSION,
        scope_ref=str(uuid.uuid4()),
        event_id=uuid.uuid4(),
        event_type_id=None,
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="drop",
        actual_count=0,
        expected_count=200.0,
        drift_field="2.1.0",
        drift_type="missing",
        sample_value="2.0.0",
    )

    # Gated by the dedicated include_release_regressions opt-in (not the generic
    # event toggles), and the analyzer's own gates mean numeric thresholds are
    # skipped.
    assert rule_matches_anomaly(_build_rule(include_release_regressions=False), candidate) is False
    # Generic event rules must NOT pick up regressions on their own.
    assert (
        rule_matches_anomaly(
            _build_rule(include_events=True, include_release_regressions=False), candidate
        )
        is False
    )

    enabled_rule = _build_rule(
        include_release_regressions=True,
        notify_on_drop=True,
        min_percent_delta=999,
        min_absolute_delta=999,
        min_expected_count=999,
    )
    assert rule_matches_anomaly(enabled_rule, candidate) is True

    # Direction gate still applies: a regression is a drop.
    no_drop_rule = _build_rule(include_release_regressions=True, notify_on_drop=False)
    assert rule_matches_anomaly(no_drop_rule, candidate) is False


def test_release_regression_item_renders_readable_release_line() -> None:
    from tripl.alert_templates import get_default_items_template, render_alert_template
    from tripl.models.alert_delivery_item import AlertDeliveryItem
    from tripl.worker.tasks.alerts_messages import _build_item_template_context

    item = AlertDeliveryItem(
        id=uuid.uuid4(),
        delivery_id=uuid.uuid4(),
        scope_type="release_regression",
        scope_ref=str(uuid.uuid4()),
        scope_name="Login",
        event_id=uuid.uuid4(),
        event_type_id=None,
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="drop",
        actual_count=0,
        expected_count=200,
        absolute_delta=200,
        percent_delta=100.0,
        drift_type="missing",
        drift_field="2.1.0",
        sample_value="2.0.0",
    )
    context = _build_item_template_context(item, message_format="plain")
    rendered = render_alert_template(get_default_items_template("plain"), context)
    assert "Release regression Login" in rendered
    assert "release: disappeared in 2.1.0 (was 2.0.0)" in rendered
    assert "actual=0" in rendered
    assert "expected=200" in rendered


def test_format_metric_alert_value_percent_rules() -> None:
    from tripl.alert_templates import format_metric_alert_value

    # Percent metrics store fractions: scale ×100, integral drops the decimal.
    assert format_metric_alert_value(0.08, "%") == "8%"
    assert format_metric_alert_value(0.083, "%") == "8.3%"
    assert format_metric_alert_value(1.0, "%") == "100%"
    assert format_metric_alert_value(0.0, "%") == "0%"
    # Binary float noise must not force a decimal: 0.08 - 0.04 != exact 0.04.
    assert format_metric_alert_value(0.08 - 0.04, "%") == "4%"
    # Any other unit passes through unchanged for the shared stringifier.
    assert format_metric_alert_value(0.08, None) == 0.08
    assert format_metric_alert_value(0.08, "ms") == 0.08
    assert format_metric_alert_value(12.0, "users") == 12.0


def _metric_scope_delivery_item(
    *,
    scope_ref: str | None = None,
    actual: float,
    expected: float,
    delta: float,
) -> AlertDeliveryItem:
    return AlertDeliveryItem(
        id=uuid.uuid4(),
        delivery_id=uuid.uuid4(),
        scope_type="metric",
        scope_ref=scope_ref or str(uuid.uuid4()),
        scope_name="Signup CR",
        event_id=None,
        event_type_id=None,
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="spike",
        actual_count=actual,
        expected_count=expected,
        absolute_delta=delta,
        percent_delta=100.0,
    )


def test_metric_scope_percent_item_renders_scaled_values() -> None:
    from tripl.alert_templates import get_default_items_template, render_alert_template
    from tripl.worker.tasks.alerts_messages import _build_item_template_context

    item = _metric_scope_delivery_item(actual=0.08, expected=0.04, delta=0.04)
    context = _build_item_template_context(item, message_format="plain", metric_unit="%")
    rendered = render_alert_template(get_default_items_template("plain"), context)
    assert "actual=8%" in rendered
    assert "expected=4%" in rendered
    assert "delta=4% (100.0%)" in rendered

    fractional = _metric_scope_delivery_item(actual=0.083, expected=0.04, delta=0.043)
    context = _build_item_template_context(fractional, message_format="plain", metric_unit="%")
    rendered = render_alert_template(get_default_items_template("plain"), context)
    assert "actual=8.3%" in rendered
    assert "delta=4.3% (100.0%)" in rendered


def test_metric_scope_non_percent_and_event_items_render_unchanged() -> None:
    """Regression: only unit='%' opts in — other units and scopes stay raw."""
    from tripl.alert_templates import get_default_items_template, render_alert_template
    from tripl.worker.tasks.alerts_messages import _build_item_template_context

    template = get_default_items_template("plain")
    item = _metric_scope_delivery_item(actual=12.0, expected=4.0, delta=8.0)
    for unit in (None, "users", "ms"):
        rendered = render_alert_template(
            template,
            _build_item_template_context(item, message_format="plain", metric_unit=unit),
        )
        assert "actual=12" in rendered
        assert "expected=4," in rendered
        assert "delta=8 (100.0%)" in rendered

    event_item = AlertDeliveryItem(
        id=uuid.uuid4(),
        delivery_id=uuid.uuid4(),
        scope_type="event",
        scope_ref=str(uuid.uuid4()),
        scope_name="Login",
        event_id=uuid.uuid4(),
        event_type_id=None,
        bucket=datetime(2026, 5, 1, 12, tzinfo=UTC),
        direction="spike",
        actual_count=200,
        expected_count=20.5,
        absolute_delta=179.5,
        percent_delta=875.6,
    )
    rendered = render_alert_template(
        template,
        _build_item_template_context(event_item, message_format="plain"),
    )
    assert "actual=200" in rendered
    assert "expected=20.5" in rendered
    assert "delta=179.5 (875.6%)" in rendered


def test_simulator_renders_same_percent_values_as_worker() -> None:
    """Shared-predicates parity: preview and live send must show identical
    numbers for the same percent metric."""
    from tripl.alert_templates import get_default_items_template, render_alert_template
    from tripl.schemas.alerting import SimulatedRuleFiring
    from tripl.services.alerting_rendering import render_firing_item
    from tripl.worker.tasks.alerts_messages import _build_item_template_context

    metric_id = str(uuid.uuid4())
    bucket = datetime(2026, 5, 1, 12, tzinfo=UTC)
    template = get_default_items_template("plain")

    firing = SimulatedRuleFiring(
        anomaly_id=uuid.uuid4(),
        scope_type="metric",
        scope_ref=metric_id,
        scope_name="Signup CR",
        event_type_id=None,
        event_id=None,
        bucket=bucket,
        direction="spike",
        actual_count=0.083,
        expected_count=0.04,
        absolute_delta=0.043,
        percent_delta=100.0,
    )
    simulated = render_firing_item(
        firing,
        message_format="plain",
        items_template=template,
        metric_unit="%",
    )

    item = _metric_scope_delivery_item(
        scope_ref=metric_id, actual=0.083, expected=0.04, delta=0.043
    )
    item.bucket = bucket
    live = render_alert_template(
        template,
        _build_item_template_context(item, message_format="plain", metric_unit="%"),
    ).rstrip()

    assert "actual=8.3%" in simulated
    assert "expected=4%" in simulated
    assert "delta=4.3%" in simulated
    assert simulated == live


@pytest.mark.asyncio
async def test_alert_rule_simulate_endpoint(client: AsyncClient) -> None:
    from datetime import timedelta

    from tripl.models.metric_anomaly import MetricAnomaly

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Sim", "slug": "alert-sim"},
    )
    assert project_resp.status_code == 201
    project_id = uuid.UUID(project_resp.json()["id"])

    destination_resp = await client.post(
        "/api/v1/projects/alert-sim/alert-destinations",
        json={
            "type": "slack",
            "name": "Sim Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T1/B1/sim",
        },
    )
    assert destination_resp.status_code == 201
    destination_id = destination_resp.json()["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/alert-sim/alert-destinations/{destination_id}/rules",
        json={
            "name": "Sim Rule",
            "enabled": True,
            "include_project_total": True,
            "include_event_types": True,
            "include_events": True,
            "notify_on_spike": True,
            "notify_on_drop": True,
            "min_percent_delta": 0,
            "min_absolute_delta": 0,
            "min_expected_count": 0,
            "cooldown_minutes": 60,
            "filters": [],
        },
    )
    assert rule_resp.status_code == 201
    rule_id = rule_resp.json()["id"]

    now = datetime.now(UTC)
    scope_ref = str(uuid.uuid4())
    async with TestSessionLocal() as session, session.begin():
        data_source = DataSource(
            id=uuid.uuid4(),
            name="ds",
            db_type="clickhouse",
            host="h",
            port=8123,
            database_name="d",
            username="u",
            password_encrypted="",
        )
        session.add(data_source)
        await session.flush()
        scan = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project_id,
            name="sc",
            base_query="SELECT 1",
            cardinality_threshold=100,
            interval="1h",
        )
        session.add(scan)
        await session.flush()
        # 4 anomalies, 0/15/30/60 min apart. Cooldown=60min admits #0 and #3.
        for offset_min in (0, 15, 30, 60):
            session.add(
                MetricAnomaly(
                    id=uuid.uuid4(),
                    scan_config_id=scan.id,
                    scope_type="event",
                    scope_ref=scope_ref,
                    event_id=None,
                    event_type_id=None,
                    bucket=now - timedelta(days=1) + timedelta(minutes=offset_min),
                    actual_count=200,
                    expected_count=20.0,
                    stddev=1.0,
                    z_score=10.0,
                    direction="spike",
                )
            )

    resp = await client.post(
        f"/api/v1/projects/alert-sim/alert-destinations/"
        f"{destination_id}/rules/{rule_id}/simulate?days=7"
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["anomalies_considered"] == 4
    assert payload["matched_before_cooldown"] == 4
    assert len(payload["firings"]) == 2
    assert payload["noisy"] is False
    assert payload["rule_id"] == rule_id
    # Preview attached: rendered_message exists and per-firing rendered_item too.
    assert payload["cooldown_minutes_used"] == 60
    assert payload["cooldown_minutes_saved"] == 60
    assert isinstance(payload["rendered_message"], str)
    assert payload["rendered_message"]
    assert all(
        isinstance(f["rendered_item"], str) and f["rendered_item"] for f in payload["firings"]
    )

    # Cooldown override = 0 disables grouping, so every anomaly fires.
    resp_zero = await client.post(
        f"/api/v1/projects/alert-sim/alert-destinations/"
        f"{destination_id}/rules/{rule_id}/simulate"
        f"?days=7&cooldown_minutes_override=0"
    )
    assert resp_zero.status_code == 200
    payload_zero = resp_zero.json()
    assert payload_zero["cooldown_minutes_used"] == 0
    assert payload_zero["cooldown_minutes_saved"] == 60
    assert len(payload_zero["firings"]) == 4

    # Cooldown override well above the spacing collapses everything to one firing.
    resp_long = await client.post(
        f"/api/v1/projects/alert-sim/alert-destinations/"
        f"{destination_id}/rules/{rule_id}/simulate"
        f"?days=7&cooldown_minutes_override=600"
    )
    assert resp_long.status_code == 200
    payload_long = resp_long.json()
    assert payload_long["cooldown_minutes_used"] == 600
    assert len(payload_long["firings"]) == 1


@pytest.mark.asyncio
async def test_alert_rule_simulate_renders_percent_metric_values(client: AsyncClient) -> None:
    """Simulate resolves the metric's unit ('%') with one batched query and
    previews the same ×100 values the live worker would send."""
    from tripl.models.metric_anomaly import MetricAnomaly
    from tripl.models.metric_definition import MetricDefinition

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Sim Pct", "slug": "alert-sim-pct"},
    )
    assert project_resp.status_code == 201
    project_id = uuid.UUID(project_resp.json()["id"])

    destination_resp = await client.post(
        "/api/v1/projects/alert-sim-pct/alert-destinations",
        json={
            "type": "slack",
            "name": "Sim Pct Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T1/B1/simpct",
        },
    )
    assert destination_resp.status_code == 201
    destination_id = destination_resp.json()["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/alert-sim-pct/alert-destinations/{destination_id}/rules",
        json={
            "name": "Percent Metric Rule",
            "enabled": True,
            "include_project_total": False,
            "include_event_types": False,
            "include_events": False,
            "include_metrics": True,
            "notify_on_spike": True,
            "notify_on_drop": True,
            "min_percent_delta": 0,
            "min_absolute_delta": 0,
            "min_expected_count": 0,
            "cooldown_minutes": 60,
            "filters": [],
        },
    )
    assert rule_resp.status_code == 201
    rule_id = rule_resp.json()["id"]

    now = datetime.now(UTC)
    async with TestSessionLocal() as session, session.begin():
        data_source = DataSource(
            id=uuid.uuid4(),
            name="ds-pct",
            db_type="clickhouse",
            host="h",
            port=8123,
            database_name="d",
            username="u",
            password_encrypted="",
        )
        session.add(data_source)
        await session.flush()
        scan = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project_id,
            name="sc-pct",
            base_query="SELECT 1",
            cardinality_threshold=100,
            interval="1h",
        )
        metric = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project_id,
            name="conversion_rate",
            display_name="Conversion Rate",
            kind="sql",
            config={},
            data_source_id=data_source.id,
            interval="1h",
            status="active",
            unit="%",
        )
        session.add_all([scan, metric])
        await session.flush()
        # NOTE: live metric-scope anomalies are project-global (NULL
        # scan_config_id); the simulator window query joins scan_configs, so
        # anchor on the scan to surface this anomaly in the window.
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan.id,
                scope_type="metric",
                scope_ref=str(metric.id),
                event_id=None,
                event_type_id=None,
                bucket=now - timedelta(days=1),
                actual_count=0.08,
                expected_count=0.04,
                stddev=0.01,
                z_score=4.0,
                direction="spike",
            )
        )

    resp = await client.post(
        f"/api/v1/projects/alert-sim-pct/alert-destinations/"
        f"{destination_id}/rules/{rule_id}/simulate?days=7"
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert len(payload["firings"]) == 1
    rendered_item = payload["firings"][0]["rendered_item"]
    assert "actual=8%" in rendered_item
    assert "expected=4%" in rendered_item
    assert "delta=4% (100.0%)" in rendered_item


@pytest.mark.asyncio
async def test_alert_rule_simulate_includes_project_global_metric_anomaly(
    client: AsyncClient,
) -> None:
    """Regression (tripl-nxk2.18): catalog metric anomalies are project-global,
    stored with scope_type='metric' and a NULL scan_config_id. The simulator's
    old scan_config inner join silently dropped them, so metric-including rules
    never fired. The simulator must now load them (scoped via MetricDefinition)
    and resolve their scope_name to the metric's display name — while non-metric
    (event) loading stays byte-identical.
    """
    from tripl.models.metric_anomaly import MetricAnomaly
    from tripl.models.metric_definition import MetricDefinition

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Sim Global", "slug": "alert-sim-global"},
    )
    assert project_resp.status_code == 201
    project_id = uuid.UUID(project_resp.json()["id"])

    destination_resp = await client.post(
        "/api/v1/projects/alert-sim-global/alert-destinations",
        json={
            "type": "slack",
            "name": "Sim Global Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T1/B1/simglobal",
        },
    )
    assert destination_resp.status_code == 201
    destination_id = destination_resp.json()["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/alert-sim-global/alert-destinations/{destination_id}/rules",
        json={
            "name": "Metric + Event Rule",
            "enabled": True,
            "include_project_total": True,
            "include_event_types": True,
            "include_events": True,
            "include_metrics": True,
            "notify_on_spike": True,
            "notify_on_drop": True,
            "min_percent_delta": 0,
            "min_absolute_delta": 0,
            "min_expected_count": 0,
            "cooldown_minutes": 60,
            "filters": [],
        },
    )
    assert rule_resp.status_code == 201
    rule_id = rule_resp.json()["id"]

    now = datetime.now(UTC)
    metric_id = uuid.uuid4()
    event_scope_ref = str(uuid.uuid4())
    async with TestSessionLocal() as session, session.begin():
        data_source = DataSource(
            id=uuid.uuid4(),
            name="ds-global",
            db_type="clickhouse",
            host="h",
            port=8123,
            database_name="d",
            username="u",
            password_encrypted="",
        )
        session.add(data_source)
        await session.flush()
        scan = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project_id,
            name="sc-global",
            base_query="SELECT 1",
            cardinality_threshold=100,
            interval="1h",
        )
        metric = MetricDefinition(
            id=metric_id,
            project_id=project_id,
            name="signups",
            display_name="Signups",
            kind="sql",
            config={},
            data_source_id=data_source.id,
            interval="1h",
            status="active",
            unit=None,
        )
        session.add_all([scan, metric])
        await session.flush()
        # Project-global catalog metric anomaly: NULL scan_config_id. The old
        # simulator inner-joined scan_configs and silently dropped these rows.
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=None,
                scope_type="metric",
                scope_ref=str(metric_id),
                event_id=None,
                event_type_id=None,
                bucket=now - timedelta(days=1),
                actual_count=200.0,
                expected_count=20.0,
                stddev=1.0,
                z_score=10.0,
                direction="spike",
            )
        )
        # Non-metric (event) anomaly stays anchored to a scan config and must
        # still load exactly as before (unchanged behavior).
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan.id,
                scope_type="event",
                scope_ref=event_scope_ref,
                event_id=None,
                event_type_id=None,
                bucket=now - timedelta(days=1, minutes=5),
                actual_count=150.0,
                expected_count=15.0,
                stddev=1.0,
                z_score=9.0,
                direction="spike",
            )
        )

    resp = await client.post(
        f"/api/v1/projects/alert-sim-global/alert-destinations/"
        f"{destination_id}/rules/{rule_id}/simulate?days=7"
    )
    assert resp.status_code == 200
    payload = resp.json()

    # Both the project-global metric anomaly and the event anomaly are loaded.
    assert payload["anomalies_considered"] == 2
    assert payload["matched_before_cooldown"] == 2

    firings_by_scope = {f["scope_type"]: f for f in payload["firings"]}
    # Regression: the event anomaly still fires (non-metric loading unchanged),
    # and the previously-dropped project-global metric anomaly now fires too.
    assert set(firings_by_scope) == {"metric", "event"}

    # Core defect fix: the metric anomaly's scope_name resolves to the metric's
    # display name, not the raw UUID scope_ref.
    metric_firing = firings_by_scope["metric"]
    assert metric_firing["scope_ref"] == str(metric_id)
    assert metric_firing["scope_name"] == "Signups"
    assert metric_firing["scope_name"] != metric_firing["scope_ref"]


def test_simulate_rule_firings_respects_cooldown_override() -> None:
    from tripl.alerting_matching import simulate_rule_firings

    rule = _build_rule(cooldown_minutes=60)
    scope = str(uuid.uuid4())
    base = datetime(2026, 5, 1, 12, tzinfo=UTC)
    anomalies = [
        _build_anomaly(base, scope_ref=scope),
        _build_anomaly(base.replace(hour=12, minute=15), scope_ref=scope),
        _build_anomaly(base.replace(hour=12, minute=30), scope_ref=scope),
    ]

    # Without override: saved cooldown=60 → only the first fires.
    assert len(simulate_rule_firings(rule, anomalies)) == 1

    # Override to 0: every anomaly fires.
    assert len(simulate_rule_firings(rule, anomalies, cooldown_minutes_override=0)) == 3

    # Override to 10: 15-min and 30-min anomalies each clear the gate.
    assert len(simulate_rule_firings(rule, anomalies, cooldown_minutes_override=10)) == 3

    # Override to 20: only first and third clear (second is 15 min after first).
    fired_20 = simulate_rule_firings(rule, anomalies, cooldown_minutes_override=20)
    assert [a.bucket for a in fired_20] == [anomalies[0].bucket, anomalies[2].bucket]


def test_build_sparkline_handles_empty_flat_and_varied_inputs() -> None:
    from tripl.anomaly_context import build_sparkline

    assert build_sparkline([]) == ""

    # All-identical → mid block, length preserved.
    flat = build_sparkline([5, 5, 5, 5])
    assert len(flat) == 4
    assert flat == flat[0] * 4

    # Ascending series → strictly non-decreasing block heights.
    ascending = build_sparkline([1, 2, 3, 4, 5, 6, 7, 8])
    blocks = "▁▂▃▄▅▆▇█"
    assert ascending[0] == blocks[0]
    assert ascending[-1] == blocks[-1]
    levels = [blocks.index(ch) for ch in ascending]
    assert levels == sorted(levels)

    # Width cap: trim to last N when input longer.
    long_series = list(range(40))
    capped = build_sparkline(long_series, width=10)
    assert len(capped) == 10


def test_format_top_movers_renders_signed_percent_and_truncates_value() -> None:
    from types import SimpleNamespace

    from tripl.anomaly_context import format_top_movers

    movers = [
        SimpleNamespace(
            breakdown_column="country",
            breakdown_value="RU",
            actual_count=42,
            expected_count=10.0,
        ),
        SimpleNamespace(
            breakdown_column="device",
            breakdown_value="extremely-long-device-identifier-string",
            actual_count=2,
            expected_count=10.0,
        ),
        # Zero baseline → "+inf%" label so we never divide by zero.
        SimpleNamespace(
            breakdown_column="referrer",
            breakdown_value="new_one",
            actual_count=5,
            expected_count=0.0,
        ),
    ]
    rendered = format_top_movers(movers)  # type: ignore[arg-type]
    # Country: (42-10)/10*100 = +320%
    assert "country=RU +320%" in rendered
    # Device value truncated with ellipsis at MAX_MOVER_VALUE_LEN-1 chars.
    assert "device=extremely-long-device-i…" in rendered
    # Zero baseline labeled +inf%.
    assert "referrer=new_one +inf%" in rendered
    # Separator: middle dot with spaces.
    assert rendered.count(" · ") == 2


@pytest.mark.asyncio
async def test_send_alert_delivery_attaches_top_movers_and_sparkline(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """End-to-end: a real EventMetric + MetricBreakdownAnomaly history
    surface as ``trend:`` / ``movers:`` lines in the rendered Slack message.
    """
    from datetime import timedelta

    from tripl.models.event_metric import EventMetric
    from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
    from tripl.worker.tasks import metrics

    engine = create_engine(f"sqlite:///{tmp_path / 'explain.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)

    bucket = datetime(2026, 4, 11, 12, tzinfo=UTC)

    with sync_session_factory() as session:
        project = Project(id=uuid.uuid4(), name="Explain", slug="explain", description="")
        ds = DataSource(
            id=uuid.uuid4(),
            name="ds",
            db_type="clickhouse",
            host="h",
            port=8123,
            database_name="d",
            username="u",
            password_encrypted="",
        )
        scan = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=ds.id,
            project_id=project.id,
            name="sc",
            base_query="SELECT 1",
            time_column="t",
            cardinality_threshold=100,
            interval="1h",
        )
        event_id = uuid.uuid4()
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="slack",
            name="dst",
            enabled=True,
            webhook_url_encrypted="https://hooks.slack.com/services/T/B/sim",
            chat_id=None,
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="slack",
            status="pending",
            matched_count=1,
            payload_snapshot={},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref=str(event_id),
            scope_name="purchase",
            event_id=event_id,
            event_type_id=None,
            bucket=bucket,
            direction="drop",
            actual_count=10,
            expected_count=100,
            absolute_delta=90,
            percent_delta=90.0,
            details_path=None,
            monitoring_path=None,
        )
        # 6 historical buckets with rising counts → non-flat sparkline.
        for i, count in enumerate([10, 12, 15, 50, 80, 10]):
            session.add(
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan.id,
                    event_id=event_id,
                    event_type_id=None,
                    bucket=bucket - timedelta(hours=5 - i),
                    count=count,
                )
            )
        # One outsized breakdown anomaly at the same bucket → top mover.
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=scan.id,
                scope_type="event",
                scope_ref=str(event_id),
                event_id=event_id,
                event_type_id=None,
                bucket=bucket,
                breakdown_column="country",
                breakdown_value="RU",
                is_other=False,
                actual_count=1,
                expected_count=50.0,
                stddev=1.0,
                z_score=-12.0,
                direction="drop",
            )
        )
        session.add_all([project, ds, scan, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    sent_bodies: list[dict[str, object]] = []

    def capture_post_json(url: str, body: dict[str, object]) -> None:
        sent_bodies.append(body)

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)
    assert result["status"] == "sent"
    assert len(sent_bodies) == 1

    text = sent_bodies[0]["text"]
    assert isinstance(text, str)
    assert "movers: country=RU" in text
    assert "trend: " in text  # Sparkline rendered after `trend: ` label.

    Base.metadata.drop_all(engine)
    engine.dispose()


# --- Email channel ----------------------------------------------------------


@pytest.mark.asyncio
async def test_alerting_email_destination_crud_and_validation(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Email Alerts", "slug": "email-alerts", "description": ""},
    )
    assert project_resp.status_code == 201

    # Empty / malformed recipient list rejected.
    empty_resp = await client.post(
        "/api/v1/projects/email-alerts/alert-destinations",
        json={"type": "email", "name": "Bad", "email_recipients": "   ,  "},
    )
    assert empty_resp.status_code == 422

    bad_addr_resp = await client.post(
        "/api/v1/projects/email-alerts/alert-destinations",
        json={"type": "email", "name": "Bad", "email_recipients": "not-an-email"},
    )
    assert bad_addr_resp.status_code == 422

    # Newline in subject template is header injection → reject.
    bad_subject_resp = await client.post(
        "/api/v1/projects/email-alerts/alert-destinations",
        json={
            "type": "email",
            "name": "Bad Subject",
            "email_recipients": "alice@example.com",
            "email_subject_template": "spike\nBcc: attacker@example.com",
        },
    )
    assert bad_subject_resp.status_code == 422

    create_resp = await client.post(
        "/api/v1/projects/email-alerts/alert-destinations",
        json={
            "type": "email",
            "name": "Ops Email",
            "email_recipients": "alice@example.com, bob@example.com , alice@example.com",
            "email_from_address": "alerts@tripl-app.io",
            "email_subject_template": "[{project_name}] {rule_name}",
        },
    )
    assert create_resp.status_code == 201
    destination = create_resp.json()
    assert destination["type"] == "email"
    # Dedup + normalized whitespace in the recipient CSV.
    assert destination["email_recipients"] == "alice@example.com, bob@example.com"
    assert destination["email_from_address"] == "alerts@tripl-app.io"
    assert destination["email_subject_template"] == "[{project_name}] {rule_name}"
    destination_id = destination["id"]

    # Update validation: bad address in the new list is rejected; good update sticks.
    bad_update = await client.patch(
        f"/api/v1/projects/email-alerts/alert-destinations/{destination_id}",
        json={"email_recipients": "not-an-email"},
    )
    assert bad_update.status_code == 422

    good_update = await client.patch(
        f"/api/v1/projects/email-alerts/alert-destinations/{destination_id}",
        json={"email_recipients": "carol@example.com", "name": "Renamed Email"},
    )
    assert good_update.status_code == 200
    body = good_update.json()
    assert body["name"] == "Renamed Email"
    assert body["email_recipients"] == "carol@example.com"


def test_send_alert_delivery_sends_email(monkeypatch, tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_email_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_messages: list[dict[str, object]] = []

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(), name="Alert Runtime", slug="alert-runtime", description=""
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="email",
            name="Ops Email",
            enabled=True,
            email_recipients="alice@example.com, bob@example.com",
            email_from_address=None,
            email_subject_template=None,
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="email",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    # Fake SMTP client — captures the EmailMessage that send_message would ship.
    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: int = 10) -> None:
            sent_messages.append({"connect_host": host, "connect_port": port})

        def __enter__(self) -> FakeSMTP:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def starttls(self) -> None:
            sent_messages.append({"event": "starttls"})

        def login(self, username: str, password: str) -> None:
            sent_messages.append({"event": "login", "username": username})

        def send_message(self, msg) -> None:  # type: ignore[no-untyped-def]
            sent_messages.append(
                {
                    "event": "send",
                    "From": msg["From"],
                    "To": msg["To"],
                    "Subject": msg["Subject"],
                    "body": msg.get_content(),
                }
            )

    from tripl.config import settings as live_settings

    alerts_globals = metrics.send_alert_delivery.run.__globals__
    fake_smtplib = type("FakeSmtplibModule", (), {"SMTP": FakeSMTP})
    monkeypatch.setitem(alerts_globals, "_get_sync_session", sync_session_factory)
    monkeypatch.setitem(alerts_globals, "smtplib", fake_smtplib)
    monkeypatch.setattr(live_settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(live_settings, "smtp_port", 587)
    monkeypatch.setattr(live_settings, "smtp_username", "tripl-bot")
    monkeypatch.setattr(live_settings, "smtp_password", "hunter2")
    monkeypatch.setattr(live_settings, "smtp_use_tls", True)
    monkeypatch.setattr(live_settings, "smtp_from_address", "alerts@tripl-app.io")

    result = metrics.send_alert_delivery.run(delivery_id)
    assert result["status"] == "sent"

    # Connect → TLS → login → send.
    events = [m.get("event") for m in sent_messages if "event" in m]
    assert events == ["starttls", "login", "send"]
    send_event = next(m for m in sent_messages if m.get("event") == "send")
    assert send_event["From"] == "alerts@tripl-app.io"
    assert send_event["To"] == "alice@example.com, bob@example.com"
    # Default subject: "[<project>] <rule> — N alert(s)"
    assert send_event["Subject"] == "[Alert Runtime] Main Rule — 1 alert(s)"
    body = send_event["body"]
    assert isinstance(body, str)
    assert "purchase:success" in body

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_email_fails_without_smtp(monkeypatch, tmp_path) -> None:
    """Destination exists but SMTP is unconfigured → delivery is marked failed
    with an actionable error message (rather than crashing the worker)."""
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_email_no_smtp.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)

    with sync_session_factory() as session:
        project = Project(id=uuid.uuid4(), name="P", slug="p", description="")
        data_source = DataSource(
            id=uuid.uuid4(),
            name="DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="d",
            username="u",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="S",
            base_query="SELECT 1",
            time_column="ts",
            cardinality_threshold=10,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="email",
            name="Email",
            enabled=True,
            email_recipients="x@example.com",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="R",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="email",
            status="pending",
            matched_count=0,
            payload_snapshot=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery])
        session.commit()
        delivery_id = str(delivery.id)

    from tripl.config import settings as live_settings

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setattr(live_settings, "smtp_host", "")

    result = metrics.send_alert_delivery.run(delivery_id)
    assert result["status"] == "failed"
    assert "SMTP" in result["error"]

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.failed.value
        assert persisted.error_message is not None
        assert "SMTP" in persisted.error_message

    Base.metadata.drop_all(engine)
    engine.dispose()


# --- Jira channel -----------------------------------------------------------


@pytest.mark.asyncio
async def test_alerting_jira_destination_crud_and_validation(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Jira Alerts", "slug": "jira-alerts", "description": ""},
    )
    assert project_resp.status_code == 201

    # Non-https base_url rejected.
    bad_url_resp = await client.post(
        "/api/v1/projects/jira-alerts/alert-destinations",
        json={
            "type": "jira",
            "name": "Bad",
            "jira_base_url": "http://example.atlassian.net",
            "jira_auth_email": "alice@example.com",
            "jira_api_token": "secret",
            "jira_project_key": "ENG",
        },
    )
    assert bad_url_resp.status_code == 422

    # Lowercase / invalid project key rejected.
    bad_key_resp = await client.post(
        "/api/v1/projects/jira-alerts/alert-destinations",
        json={
            "type": "jira",
            "name": "Bad",
            "jira_base_url": "https://example.atlassian.net",
            "jira_auth_email": "alice@example.com",
            "jira_api_token": "secret",
            "jira_project_key": "engineering team",
        },
    )
    assert bad_key_resp.status_code == 422

    create_resp = await client.post(
        "/api/v1/projects/jira-alerts/alert-destinations",
        json={
            "type": "jira",
            "name": "Ops Jira",
            "jira_base_url": "https://example.atlassian.net/",
            "jira_auth_email": "alice@example.com",
            "jira_api_token": "secret-token",
            "jira_project_key": "eng",
            "jira_issue_type": "Bug",
        },
    )
    assert create_resp.status_code == 201
    destination = create_resp.json()
    assert destination["type"] == "jira"
    # base_url has trailing slash stripped, project key uppercased.
    assert destination["jira_base_url"] == "https://example.atlassian.net"
    assert destination["jira_project_key"] == "ENG"
    assert destination["jira_issue_type"] == "Bug"
    assert destination["jira_api_token_set"] is True
    # Secrets are never echoed back.
    assert "jira_api_token" not in destination
    destination_id = destination["id"]

    update_resp = await client.patch(
        f"/api/v1/projects/jira-alerts/alert-destinations/{destination_id}",
        json={"jira_issue_type": "Task", "name": "Renamed Jira"},
    )
    assert update_resp.status_code == 200
    body = update_resp.json()
    assert body["name"] == "Renamed Jira"
    assert body["jira_issue_type"] == "Task"


def test_send_alert_delivery_creates_jira_issue(monkeypatch, tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_jira_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent: dict[str, object] = {}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(), name="Alert Runtime", slug="alert-runtime", description=""
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="jira",
            name="Ops Jira",
            enabled=True,
            jira_base_url="https://example.atlassian.net",
            jira_auth_email="alice@example.com",
            jira_api_token_encrypted="api-token-1",
            jira_project_key="ENG",
            jira_issue_type="Task",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="jira",
            status="pending",
            matched_count=2,
            payload_snapshot={"preview": "two alerts"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def capture_post_json(url: str, body: dict[str, object], headers: dict[str, str] | None = None):
        sent["url"] = url
        sent["body"] = body
        sent["headers"] = headers

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)
    assert result["status"] == "sent"

    assert sent["url"] == "https://example.atlassian.net/rest/api/3/issue"
    headers = sent["headers"]
    assert isinstance(headers, dict)
    # Basic auth header is base64("email:token").
    assert headers["Authorization"].startswith("Basic ")
    expected_creds = base64.b64encode(b"alice@example.com:api-token-1").decode()
    assert headers["Authorization"] == f"Basic {expected_creds}"
    body = sent["body"]
    assert isinstance(body, dict)
    fields = body["fields"]
    assert isinstance(fields, dict)
    assert fields["project"] == {"key": "ENG"}
    assert fields["issuetype"] == {"name": "Task"}
    assert "Main Rule" in fields["summary"]
    description = fields["description"]
    assert isinstance(description, dict)
    assert description["type"] == "doc"
    # Body has paragraphs; render text contains the scope name.
    rendered = json.dumps(description)
    assert "purchase:success" in rendered

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value

    Base.metadata.drop_all(engine)
    engine.dispose()


# --- Linear channel ---------------------------------------------------------


@pytest.mark.asyncio
async def test_alerting_linear_destination_crud_and_validation(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Linear Alerts", "slug": "linear-alerts", "description": ""},
    )
    assert project_resp.status_code == 201

    # Team id with whitespace rejected.
    bad_team_resp = await client.post(
        "/api/v1/projects/linear-alerts/alert-destinations",
        json={
            "type": "linear",
            "name": "Bad",
            "linear_api_key": "lin_api_xyz",
            "linear_team_id": "team with space",
        },
    )
    assert bad_team_resp.status_code == 422

    create_resp = await client.post(
        "/api/v1/projects/linear-alerts/alert-destinations",
        json={
            "type": "linear",
            "name": "Ops Linear",
            "linear_api_key": "lin_api_xyz",
            "linear_team_id": "team-eng-1",
            "linear_state_id": "state-backlog",
            "linear_label_ids": "label-1, label-2, label-1, ",
        },
    )
    assert create_resp.status_code == 201
    destination = create_resp.json()
    assert destination["type"] == "linear"
    assert destination["linear_team_id"] == "team-eng-1"
    assert destination["linear_state_id"] == "state-backlog"
    # Dedup + normalize: "label-1,label-2".
    assert destination["linear_label_ids"] == "label-1,label-2"
    assert destination["linear_api_key_set"] is True
    assert "linear_api_key" not in destination
    destination_id = destination["id"]

    update_resp = await client.patch(
        f"/api/v1/projects/linear-alerts/alert-destinations/{destination_id}",
        json={"linear_label_ids": None, "name": "Renamed Linear"},
    )
    assert update_resp.status_code == 200
    body = update_resp.json()
    assert body["name"] == "Renamed Linear"
    assert body["linear_label_ids"] is None


def test_send_alert_delivery_creates_linear_issue(monkeypatch, tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_linear_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent: dict[str, object] = {}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(), name="Alert Runtime", slug="alert-runtime", description=""
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="linear",
            name="Ops Linear",
            enabled=True,
            linear_api_key_encrypted="lin_api_xyz",
            linear_team_id="team-eng-1",
            linear_state_id="state-backlog",
            linear_label_ids="label-1,label-2",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="linear",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def capture_post_json(url: str, body: dict[str, object], headers: dict[str, str] | None = None):
        sent["url"] = url
        sent["body"] = body
        sent["headers"] = headers

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        capture_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)
    assert result["status"] == "sent"

    assert sent["url"] == "https://api.linear.app/graphql"
    headers = sent["headers"]
    assert isinstance(headers, dict)
    assert headers["Authorization"] == "lin_api_xyz"
    body = sent["body"]
    assert isinstance(body, dict)
    assert "mutation IssueCreate" in body["query"]
    variables = body["variables"]
    assert isinstance(variables, dict)
    input_payload = variables["input"]
    assert isinstance(input_payload, dict)
    assert input_payload["teamId"] == "team-eng-1"
    assert input_payload["stateId"] == "state-backlog"
    assert input_payload["labelIds"] == ["label-1", "label-2"]
    assert "Main Rule" in input_payload["title"]
    assert "purchase:success" in input_payload["description"]

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value

    Base.metadata.drop_all(engine)
    engine.dispose()


def _seed_alert_delivery(
    session,
    *,
    status: str,
    created_at: datetime,
    dispatch_attempts: int = 0,
) -> uuid.UUID:
    """Create the minimal Project/ScanConfig/Destination/Rule graph plus one
    AlertDelivery, returning the delivery id. Used by the reaper tests."""
    suffix = uuid.uuid4().hex[:8]
    project = Project(
        id=uuid.uuid4(), name=f"Reaper Project {suffix}", slug=f"reaper-{suffix}", description=""
    )
    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"Reaper DS {suffix}",
        db_type="clickhouse",
        host="localhost",
        port=8123,
        database_name="default",
        username="default",
        password_encrypted="",
    )
    scan_config = ScanConfig(
        id=uuid.uuid4(),
        data_source_id=data_source.id,
        project_id=project.id,
        name="Reaper Scan",
        base_query="SELECT * FROM events",
        time_column="created_at",
        cardinality_threshold=100,
        interval="1h",
    )
    destination = AlertDestination(
        id=uuid.uuid4(),
        project_id=project.id,
        type="webhook",
        name="Reaper Hook",
        enabled=True,
        target_url_encrypted="https://example.com/hook",
    )
    rule = AlertRule(
        id=uuid.uuid4(),
        destination_id=destination.id,
        name="Reaper Rule",
        enabled=True,
    )
    delivery = AlertDelivery(
        id=uuid.uuid4(),
        project_id=project.id,
        scan_config_id=scan_config.id,
        destination_id=destination.id,
        rule_id=rule.id,
        channel="webhook",
        status=status,
        matched_count=1,
        dispatch_attempts=dispatch_attempts,
        created_at=created_at,
    )
    session.add_all([project, data_source, scan_config, destination, rule, delivery])
    session.commit()
    return delivery.id


def test_requeue_stranded_alert_deliveries_redispatches_and_bounds_attempts(
    tmp_path,
    monkeypatch,
) -> None:
    from tripl.worker.tasks import maintenance

    engine = create_engine(f"sqlite:///{tmp_path / 'reaper.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)

    now = datetime.now(UTC)
    stale = timedelta(minutes=maintenance.STRANDED_DELIVERY_MINUTES + 5)
    with sync_session_factory() as session:
        # Stranded: pending, old, attempts left → should be re-enqueued.
        stranded_id = _seed_alert_delivery(
            session, status="pending", created_at=now - stale, dispatch_attempts=1
        )
        # Fresh pending (within horizon) → likely still in flight, skip.
        _seed_alert_delivery(session, status="pending", created_at=now)
        # Already sent → ignore.
        _seed_alert_delivery(session, status="sent", created_at=now - stale)
        # Exhausted: pending, old, attempts maxed → mark failed, do not requeue.
        exhausted_id = _seed_alert_delivery(
            session,
            status="pending",
            created_at=now - stale,
            dispatch_attempts=maintenance.MAX_DISPATCH_ATTEMPTS,
        )

    monkeypatch.setattr(maintenance, "_get_sync_session", sync_session_factory)

    enqueued: list[str] = []
    from tripl.worker.tasks import alerts as alerts_module

    monkeypatch.setattr(
        alerts_module.send_alert_delivery,
        "delay",
        lambda delivery_id: enqueued.append(delivery_id),
    )

    result = maintenance.requeue_stranded_alert_deliveries.run()

    assert result["requeued"] == 1
    assert result["exhausted"] == 1
    assert enqueued == [str(stranded_id)]

    with sync_session_factory() as session:
        stranded = session.get(AlertDelivery, stranded_id)
        assert stranded is not None
        assert stranded.status == AlertDeliveryStatus.pending.value
        assert stranded.dispatch_attempts == 2

        exhausted = session.get(AlertDelivery, exhausted_id)
        assert exhausted is not None
        assert exhausted.status == AlertDeliveryStatus.failed.value
        assert exhausted.error_message is not None
        assert "exhausted" in exhausted.error_message

    Base.metadata.drop_all(engine)
    engine.dispose()


# --- SSRF guard on destination URLs (tripl-3h1) ------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/latest/meta-data/",  # cloud metadata
        "https://127.0.0.1/hook",  # loopback
        "https://10.0.0.5/hook",  # RFC1918
        "https://192.168.1.10/hook",  # RFC1918
        "https://172.16.0.1/hook",  # RFC1918
        "https://[::1]/hook",  # IPv6 loopback
    ],
)
def test_validate_webhook_target_url_rejects_internal_literal_ips(url: str) -> None:
    from tripl.alerting_validation import validate_webhook_target_url

    with pytest.raises(ValueError, match="private or internal"):
        validate_webhook_target_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/rest/api/3",
        "https://127.0.0.1",
        "https://10.0.0.5",
        "https://[::1]",
    ],
)
def test_validate_jira_base_url_rejects_internal_literal_ips(url: str) -> None:
    from tripl.alerting_validation import validate_jira_base_url

    with pytest.raises(ValueError, match="private or internal"):
        validate_jira_base_url(url)


def test_validate_webhook_target_url_rejects_hostname_resolving_to_private(monkeypatch) -> None:
    import tripl.alerting_validation as av

    def fake_getaddrinfo(host, *args, **kwargs):
        # Simulate an attacker-controlled DNS name pointing at the metadata IP.
        return [(2, 1, 6, "", ("169.254.169.254", 0))]

    monkeypatch.setattr(av.socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(ValueError, match="private or internal"):
        av.validate_webhook_target_url("https://evil.example.com/hook")


def test_validate_webhook_target_url_fails_closed_on_dns_error(monkeypatch) -> None:
    import socket as socket_module

    import tripl.alerting_validation as av

    def fake_getaddrinfo(host, *args, **kwargs):
        raise socket_module.gaierror("name does not resolve")

    monkeypatch.setattr(av.socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(ValueError, match="could not be resolved"):
        av.validate_webhook_target_url("https://nope.invalid/hook")


def test_validate_webhook_target_url_allows_public_host(monkeypatch) -> None:
    import tripl.alerting_validation as av

    def fake_getaddrinfo(host, *args, **kwargs):
        return [(2, 1, 6, "", ("93.184.216.34", 0))]  # example.com (public)

    monkeypatch.setattr(av.socket, "getaddrinfo", fake_getaddrinfo)
    assert (
        av.validate_webhook_target_url("https://hooks.example.com/abc")
        == "https://hooks.example.com/abc"
    )


# --- idempotent re-delivery under acks_late (tripl-908) ----------------------


def test_send_alert_delivery_is_idempotent_on_resend(monkeypatch, tmp_path) -> None:
    """With task_acks_late a sent-then-crashed task gets re-queued. The second
    run must be a no-op: no second outbound call, status stays sent."""
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_idempotent_send.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    call_count = {"n": 0}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(), name="Alert Runtime", slug="alert-runtime", description=""
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="jira",
            name="Ops Jira",
            enabled=True,
            jira_base_url="https://example.atlassian.net",
            jira_auth_email="alice@example.com",
            jira_api_token_encrypted="api-token-1",
            jira_project_key="ENG",
            jira_issue_type="Task",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="jira",
            status="pending",
            matched_count=1,
            payload_snapshot={"preview": "one alert"},
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def counting_post_json(
        url: str, body: dict[str, object], headers: dict[str, str] | None = None
    ):
        call_count["n"] += 1
        return {"id": "10001", "key": "ENG-1"}

    # No-op the SSRF send-time re-check so the test doesn't hit real DNS.
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_reject_private_target",
        lambda url, *, field: None,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        counting_post_json,
    )

    first = metrics.send_alert_delivery.run(delivery_id)
    assert first["status"] == "sent"
    assert call_count["n"] == 1

    # Re-run (simulating an acks_late re-queue) — must be a no-op.
    second = metrics.send_alert_delivery.run(delivery_id)
    assert second["status"] == "already_sent"
    assert call_count["n"] == 1  # no second outbound HTTP call

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value
        assert persisted.payload_snapshot["external_issue_key"] == "ENG-1"
        assert persisted.payload_snapshot["external_issue_id"] == "10001"

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_send_alert_delivery_skips_ticket_creation_when_external_id_present(
    monkeypatch, tmp_path
) -> None:
    """Crash window: a prior attempt created the Jira ticket and committed its
    external id into payload_snapshot, but was killed before status=sent. On
    re-run the delivery is still `pending`, so the status guard does not fire —
    the external-id guard must, skipping creation to avoid a duplicate ticket."""
    engine = create_engine(f"sqlite:///{tmp_path / 'alerting_ticket_guard.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    call_count = {"n": 0}

    with sync_session_factory() as session:
        project = Project(
            id=uuid.uuid4(), name="Alert Runtime", slug="alert-runtime", description=""
        )
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Runtime DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project.id,
            name="Runtime Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project.id,
            type="jira",
            name="Ops Jira",
            enabled=True,
            jira_base_url="https://example.atlassian.net",
            jira_auth_email="alice@example.com",
            jira_api_token_encrypted="api-token-1",
            jira_project_key="ENG",
            jira_issue_type="Task",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            message_format="plain",
        )
        # Still pending, but external id already recorded from the prior attempt.
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project.id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="jira",
            status="pending",
            matched_count=1,
            payload_snapshot={
                "preview": "one alert",
                "external_issue_id": "10001",
                "external_issue_key": "ENG-1",
            },
        )
        item = AlertDeliveryItem(
            id=uuid.uuid4(),
            delivery_id=delivery.id,
            scope_type="event",
            scope_ref="event-1",
            scope_name="purchase:success",
            bucket=datetime(2026, 4, 11, 9, tzinfo=UTC),
            direction="drop",
            actual_count=10,
            expected_count=20,
            absolute_delta=10,
            percent_delta=50,
            details_path=None,
            monitoring_path=None,
        )
        session.add_all([project, data_source, scan_config, destination, rule, delivery, item])
        session.commit()
        delivery_id = str(delivery.id)

    def counting_post_json(
        url: str, body: dict[str, object], headers: dict[str, str] | None = None
    ):
        call_count["n"] += 1
        return {"id": "20002", "key": "ENG-2"}

    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_reject_private_target",
        lambda url, *, field: None,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        metrics.send_alert_delivery.run.__globals__,
        "_post_json",
        counting_post_json,
    )

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "sent"
    assert call_count["n"] == 0  # no ticket creation — guard skipped it

    with sync_session_factory() as session:
        persisted = session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.sent.value
        # Original id preserved, not overwritten by a new creation.
        assert persisted.payload_snapshot["external_issue_key"] == "ENG-1"

    Base.metadata.drop_all(engine)
    engine.dispose()


# --- Deprecated sunset alert ------------------------------------------------


def _make_sunset_project(
    session,  # type: ignore[no-untyped-def]
) -> tuple:
    """Return (project, destination) seeded in *session*."""
    project = Project(id=uuid.uuid4(), name="Sunset Project", slug="sunset-proj", description="")
    data_source = DataSource(
        id=uuid.uuid4(),
        name="DS",
        db_type="clickhouse",
        host="localhost",
        port=8123,
        database_name="default",
        username="default",
        password_encrypted="",
    )
    destination = AlertDestination(
        id=uuid.uuid4(),
        project_id=project.id,
        type="slack",
        name="Ops Slack",
        enabled=True,
        webhook_url_encrypted="fake-secret",
    )
    session.add_all([project, data_source, destination])
    session.commit()
    return project, destination


def test_check_deprecated_sunset_events_fires_when_event_alive_past_sunset(
    monkeypatch, tmp_path
) -> None:
    """A deprecated event with sunset_at in the past and last_seen_at > sunset_at
    triggers a Slack message."""
    engine = create_engine(f"sqlite:///{tmp_path / 'sunset_alert_fires.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_messages: list[str] = []

    with sync_session_factory() as session:
        project, _destination = _make_sunset_project(session)
        sunset = datetime(2026, 1, 1, tzinfo=UTC)
        last_seen = datetime(2026, 3, 1, tzinfo=UTC)
        event = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=uuid.uuid4(),  # FK not enforced in SQLite
            name="app:old_purchase",
            description="",
            status=EventStatus.deprecated,
            sunset_at=sunset,
            last_seen_at=last_seen,
        )
        session.add(event)
        session.commit()

    def fake_send_digest(
        *,
        destination,  # type: ignore[no-untyped-def]
        message: str,
        project,  # type: ignore[no-untyped-def]
        email_config,  # type: ignore[no-untyped-def]
    ) -> None:
        sent_messages.append(message)

    monkeypatch.setitem(
        check_deprecated_sunset_events.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        check_deprecated_sunset_events.run.__globals__,
        "_send_digest_to_destination",
        fake_send_digest,
    )

    result = check_deprecated_sunset_events.run()

    assert result["sent"] == 1
    assert len(sent_messages) == 1
    assert "app:old_purchase" in sent_messages[0]
    assert "deprecated" in sent_messages[0].lower() or "sunset" in sent_messages[0].lower()

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_check_deprecated_sunset_events_silent_when_no_recent_data(monkeypatch, tmp_path) -> None:
    """A deprecated event whose last_seen_at is before sunset_at does NOT fire."""
    engine = create_engine(f"sqlite:///{tmp_path / 'sunset_alert_silent.db'}")
    Base.metadata.create_all(engine)
    sync_session_factory = sessionmaker(engine, expire_on_commit=False)
    sent_messages: list[str] = []

    with sync_session_factory() as session:
        project, _destination = _make_sunset_project(session)
        sunset = datetime(2026, 3, 1, tzinfo=UTC)
        # last_seen before sunset — not overdue
        last_seen = datetime(2026, 2, 1, tzinfo=UTC)
        event = Event(
            id=uuid.uuid4(),
            project_id=project.id,
            event_type_id=uuid.uuid4(),
            name="app:retired_event",
            description="",
            status=EventStatus.deprecated,
            sunset_at=sunset,
            last_seen_at=last_seen,
        )
        session.add(event)
        session.commit()

    def fake_send_digest(
        *,
        destination,  # type: ignore[no-untyped-def]
        message: str,
        project,  # type: ignore[no-untyped-def]
        email_config,  # type: ignore[no-untyped-def]
    ) -> None:
        sent_messages.append(message)

    monkeypatch.setitem(
        check_deprecated_sunset_events.run.__globals__,
        "_get_sync_session",
        sync_session_factory,
    )
    monkeypatch.setitem(
        check_deprecated_sunset_events.run.__globals__,
        "_send_digest_to_destination",
        fake_send_digest,
    )

    result = check_deprecated_sunset_events.run()

    assert result["sent"] == 0
    assert sent_messages == []

    Base.metadata.drop_all(engine)
    engine.dispose()


async def _seed_destination_rule_delivery(
    project_id: uuid.UUID,
    *,
    status: str,
    error_message: str | None = None,
    dispatch_attempts: int = 0,
) -> tuple[str, str, str]:
    """Insert a data source, scan, destination, rule and one delivery.

    Returns ``(delivery_id, destination_id, rule_id)`` as strings.
    """
    async with TestSessionLocal() as session:
        data_source = DataSource(
            id=uuid.uuid4(),
            name="Retry DS",
            db_type="clickhouse",
            host="localhost",
            port=8123,
            database_name="default",
            username="default",
            password_encrypted="",
        )
        scan_config = ScanConfig(
            id=uuid.uuid4(),
            data_source_id=data_source.id,
            project_id=project_id,
            name="Retry Scan",
            base_query="SELECT * FROM events",
            time_column="created_at",
            cardinality_threshold=100,
            interval="1h",
        )
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=project_id,
            type="slack",
            name="Retry Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Retry Rule",
            enabled=True,
        )
        delivery = AlertDelivery(
            id=uuid.uuid4(),
            project_id=project_id,
            scan_config_id=scan_config.id,
            destination_id=destination.id,
            rule_id=rule.id,
            channel="slack",
            status=status,
            matched_count=1,
            error_message=error_message,
            dispatch_attempts=dispatch_attempts,
        )
        session.add_all([data_source, scan_config, destination, rule, delivery])
        await session.commit()
        return str(delivery.id), str(destination.id), str(rule.id)


@pytest.mark.asyncio
async def test_retry_failed_delivery_resets_and_re_enqueues(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tripl.worker.tasks.alerts import send_alert_delivery

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Retry", "slug": "alert-retry", "description": ""},
    )
    assert project_resp.status_code == 201
    project_id = uuid.UUID(project_resp.json()["id"])

    delivery_id, _destination_id, _rule_id = await _seed_destination_rule_delivery(
        project_id,
        status="failed",
        error_message="boom",
        dispatch_attempts=3,
    )

    enqueued: list[str] = []
    monkeypatch.setattr(send_alert_delivery, "delay", lambda did: enqueued.append(did))

    resp = await client.post(f"/api/v1/projects/alert-retry/alert-deliveries/{delivery_id}/retry")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["error_message"] is None
    assert enqueued == [delivery_id]

    async with TestSessionLocal() as session:
        persisted = await session.get(AlertDelivery, uuid.UUID(delivery_id))
        assert persisted is not None
        assert persisted.status == AlertDeliveryStatus.pending.value
        assert persisted.error_message is None
        assert persisted.sent_at is None
        # Manual retry hands the reaper a clean attempt budget.
        assert persisted.dispatch_attempts == 0


@pytest.mark.asyncio
async def test_retry_non_failed_delivery_conflicts(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tripl.worker.tasks.alerts import send_alert_delivery

    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Retry Sent", "slug": "alert-retry-sent", "description": ""},
    )
    assert project_resp.status_code == 201
    project_id = uuid.UUID(project_resp.json()["id"])

    delivery_id, _destination_id, _rule_id = await _seed_destination_rule_delivery(
        project_id,
        status="sent",
    )

    enqueued: list[str] = []
    monkeypatch.setattr(send_alert_delivery, "delay", lambda did: enqueued.append(did))

    resp = await client.post(
        f"/api/v1/projects/alert-retry-sent/alert-deliveries/{delivery_id}/retry"
    )
    assert resp.status_code == 409
    # A sent delivery must never be re-dispatched.
    assert enqueued == []


@pytest.mark.asyncio
async def test_retry_unknown_delivery_returns_404(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Retry 404", "slug": "alert-retry-404", "description": ""},
    )
    assert project_resp.status_code == 201

    resp = await client.post(
        f"/api/v1/projects/alert-retry-404/alert-deliveries/{uuid.uuid4()}/retry"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_monitor_detail_mute_and_unmute(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Monitor Detail", "slug": "monitor-detail", "description": ""},
    )
    assert project_resp.status_code == 201

    destination_resp = await client.post(
        "/api/v1/projects/monitor-detail/alert-destinations",
        json={
            "type": "slack",
            "name": "Mon Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T1/B1/mon",
        },
    )
    assert destination_resp.status_code == 201
    destination_id = destination_resp.json()["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/monitor-detail/alert-destinations/{destination_id}/rules",
        json={"name": "Mon Rule", "enabled": True, "filters": []},
    )
    assert rule_resp.status_code == 201
    rule_id = rule_resp.json()["id"]

    detail_resp = await client.get(f"/api/v1/projects/monitor-detail/monitors/{rule_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["rule_id"] == rule_id
    assert detail["status"] == "healthy"
    assert detail["muted"] is False
    assert detail["muted_until"] is None
    assert detail["rule_enabled"] is True
    assert detail["destination_enabled"] is True
    assert detail["total_deliveries"] == 0
    assert detail["last_delivery_at"] is None

    # A mute in the past is rejected.
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    bad_mute = await client.post(
        f"/api/v1/projects/monitor-detail/monitors/{rule_id}/mute",
        json={"muted_until": past},
    )
    assert bad_mute.status_code == 422

    muted_until = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    mute_resp = await client.post(
        f"/api/v1/projects/monitor-detail/monitors/{rule_id}/mute",
        json={"muted_until": muted_until},
    )
    assert mute_resp.status_code == 200
    assert mute_resp.json()["muted"] is True
    assert mute_resp.json()["muted_until"] is not None

    # The summary list reflects the mute too.
    summary_resp = await client.get("/api/v1/projects/monitor-detail/monitors-summary")
    assert summary_resp.status_code == 200
    summary_monitor = next(
        monitor for monitor in summary_resp.json()["monitors"] if monitor["rule_id"] == rule_id
    )
    assert summary_monitor["muted"] is True

    unmute_resp = await client.post(f"/api/v1/projects/monitor-detail/monitors/{rule_id}/unmute")
    assert unmute_resp.status_code == 200
    assert unmute_resp.json()["muted"] is False
    assert unmute_resp.json()["muted_until"] is None

    missing_resp = await client.get(f"/api/v1/projects/monitor-detail/monitors/{uuid.uuid4()}")
    assert missing_resp.status_code == 404

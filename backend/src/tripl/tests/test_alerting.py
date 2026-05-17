import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tripl.models import Base
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.tests.conftest import TestSessionLocal
from tripl.worker.tasks import metrics


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
            details_path="http://localhost:5173/p/alert-audit/events/detail/event-1",
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

    detail_resp = await client.get(
        f"/api/v1/projects/alert-audit/alert-deliveries/{delivery_id}"
    )
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
            message_template=(
                "<b>Items</b>\n"
                "${items_text}"
            ),
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

    result = metrics.send_alert_delivery.run(delivery_id)

    assert result["status"] == "sent"
    assert len(sent_payloads) == 2
    assert sent_payloads[0]["parse_mode"] == "MarkdownV2"
    assert "parse_mode" not in sent_payloads[1]
    assert sent_payloads[1]["text"] == (
        "[tripl] 1 alerts\n"
        "- Event purchase:success: down, actual=10, expected=20, delta=10 (50.0%)"
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
        isinstance(f["rendered_item"], str) and f["rendered_item"]
        for f in payload["firings"]
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
    assert (
        len(simulate_rule_firings(rule, anomalies, cooldown_minutes_override=0))
        == 3
    )

    # Override to 10: 15-min and 30-min anomalies each clear the gate.
    assert (
        len(simulate_rule_firings(rule, anomalies, cooldown_minutes_override=10))
        == 3
    )

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

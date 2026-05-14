import uuid
from datetime import UTC, datetime

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

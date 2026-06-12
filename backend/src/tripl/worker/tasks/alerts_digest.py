from __future__ import annotations

import logging
import smtplib
from datetime import UTC, datetime

from sqlalchemy import select

from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.project import Project
from tripl.services import app_settings_service
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session
from tripl.worker.tasks.alerts_channels import (
    _post_json as _channel_post_json,
)
from tripl.worker.tasks.alerts_channels import (
    _send_digest_to_destination as _channel_send_digest_to_destination,
)
from tripl.worker.tasks.alerts_channels import (
    _send_email_message as _channel_send_email_message,
)
from tripl.worker.tasks.alerts_channels import (
    _send_slack_message as _channel_send_slack_message,
)
from tripl.worker.tasks.alerts_messages import (
    _build_plan_digest_message,
    _build_sunset_alert_message,
)

logger = logging.getLogger(__name__)


def _post_json(
    url: str,
    body: dict[str, object],
    headers: dict[str, str] | None = None,
) -> dict[str, object] | None:
    return _channel_post_json(url, body, headers)


def _send_slack_message(webhook_url: str, text: str, *, message_format: str) -> None:
    _channel_send_slack_message(_post_json, webhook_url, text, message_format=message_format)


def _send_email_message(
    *,
    smtp_host: str,
    smtp_port: int,
    smtp_username: str,
    smtp_password: str,
    smtp_use_tls: bool,
    from_address: str,
    recipients: list[str],
    subject: str,
    body: str,
) -> None:
    _channel_send_email_message(
        smtp_cls=smtplib.SMTP,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_username=smtp_username,
        smtp_password=smtp_password,
        smtp_use_tls=smtp_use_tls,
        from_address=from_address,
        recipients=recipients,
        subject=subject,
        body=body,
    )


def _send_digest_to_destination(
    *,
    destination: AlertDestination,
    message: str,
    project: Project,
    email_config: app_settings_service.EmailConfig,
) -> None:
    _channel_send_digest_to_destination(
        destination=destination,
        message=message,
        project=project,
        email_config=email_config,
        send_slack_message=_send_slack_message,
        send_email_message=_send_email_message,
    )


@celery_app.task(name="tripl.worker.tasks.alerts.send_weekly_plan_digest")  # type: ignore[untyped-decorator]
def send_weekly_plan_digest() -> dict[str, int]:
    session = _get_sync_session()
    sent = 0
    failed = 0
    try:
        email_config = app_settings_service.get_email_config_sync(session)
        rows = session.execute(
            select(Project, AlertDestination)
            .join(AlertDestination, AlertDestination.project_id == Project.id)
            .where(
                AlertDestination.enabled.is_(True),
                AlertDestination.type.in_(
                    [AlertDestinationType.slack.value, AlertDestinationType.email.value]
                ),
            )
            .order_by(Project.name, AlertDestination.name)
        ).all()
        now = datetime.now(UTC)
        for project, destination in rows:
            message = _build_plan_digest_message(session, project=project, now=now)
            try:
                _send_digest_to_destination(
                    destination=destination,
                    message=message,
                    project=project,
                    email_config=email_config,
                )
                sent += 1
            except Exception:  # noqa: BLE001
                failed += 1
                logger.warning(
                    "Failed to send weekly digest to destination %s",
                    destination.id,
                    exc_info=True,
                )
        return {"destinations_checked": len(rows), "sent": sent, "failed": failed}
    finally:
        session.close()


@celery_app.task(name="tripl.worker.tasks.alerts.check_deprecated_sunset_events")  # type: ignore[untyped-decorator]
def check_deprecated_sunset_events() -> dict[str, int]:
    """Alert on deprecated events that keep receiving data past their sunset_at."""
    session = _get_sync_session()
    checked = 0
    sent = 0
    failed = 0
    try:
        email_config = app_settings_service.get_email_config_sync(session)
        rows = session.execute(
            select(Project, AlertDestination)
            .join(AlertDestination, AlertDestination.project_id == Project.id)
            .where(
                AlertDestination.enabled.is_(True),
                AlertDestination.type.in_(
                    [AlertDestinationType.slack.value, AlertDestinationType.email.value]
                ),
            )
            .order_by(Project.name, AlertDestination.name)
        ).all()
        now = datetime.now(UTC)
        for project, destination in rows:
            checked += 1
            message = _build_sunset_alert_message(session, project=project, now=now)
            if message is None:
                continue
            try:
                _send_digest_to_destination(
                    destination=destination,
                    message=message,
                    project=project,
                    email_config=email_config,
                )
                sent += 1
            except Exception:  # noqa: BLE001
                failed += 1
                logger.warning(
                    "Failed to send sunset alert to destination %s",
                    destination.id,
                    exc_info=True,
                )
        return {"destinations_checked": checked, "sent": sent, "failed": failed}
    finally:
        session.close()

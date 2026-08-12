"""Test send — prove a destination actually reaches its channel.

"bot token set" and "chat -100..." say a value is STORED, not that anything
arrives: a revoked token, a webhook whose channel was archived and a healthy
destination all render identically in the form (tripl-oxkt.17). This module
sends one fixed, clearly-marked message through the destination's real channel
so the two can be told apart.

No ``AlertDelivery`` row is written for a test. That is a deliberate choice
rather than a shortcut: ``AlertDelivery.rule_id`` and ``.scan_config_id`` are
both NOT NULL, so a test row could only exist by borrowing a real rule and a
real scan and claiming they fired — which is precisely the lie the Delivery log
must not tell, and it would also stamp ``AlertRuleState.last_notified_at`` and
silence the next genuine alert through that rule's cooldown. The operator action
is recorded where operator actions belong, in the audit log, by the route.

The actual sending goes through ``worker.tasks.alerts``' channel wrappers — the
same functions ``send_alert_delivery`` calls — so a destination that passes here
passes for the same reasons a real delivery would, and there is only one place
where a channel's request shape is defined.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.alert_templates import ALERT_MESSAGE_FORMAT_PLAIN
from tripl.alerting_validation import (
    validate_email_address,
    validate_email_recipients,
    validate_jira_api_token,
    validate_jira_auth_email,
    validate_jira_base_url,
    validate_jira_issue_type,
    validate_jira_project_key,
    validate_linear_api_key,
    validate_linear_team_id,
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
    validate_webhook_target_url,
)
from tripl.crypto import decrypt_value
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.schemas.alerting import AlertDestinationTestResponse
from tripl.services._alerting_destinations import get_destination
from tripl.services.project_lookup import get_project_by_slug as _get_project

logger = logging.getLogger(__name__)

TEST_MESSAGE_SUBJECT = "Tripl test message"


def _test_message(*, project_name: str, destination_name: str) -> str:
    """The one message a test send emits. Fixed, and unmistakably a test.

    Whoever reads the channel did not ask for this, so the text has to say on its
    own line that nothing is wrong — an operator paging on a message that merely
    LOOKS like an alert is a worse outcome than never testing.
    """
    return (
        f"{TEST_MESSAGE_SUBJECT}\n"
        f"Project: {project_name}\n"
        f"Destination: {destination_name}\n"
        "Someone pressed Test in Tripl to check that this channel is reachable. "
        "No alert fired and nothing is wrong."
    )


@dataclass(frozen=True)
class DestinationTestOutcome:
    """The test result plus the destination's name, from the one load that ran.

    The route has to name the destination in the audit entry, and used to get
    that name by calling the service's ``get_destination`` first — which is
    ``get_destination_response``, so naming a destination cost the four
    delete-impact aggregates of ``load_destination_health`` and a second load of
    the row this function already holds. Nine queries to send one message, on a
    path that then blocks on a 10s network call.

    A wrapper rather than a field on ``AlertDestinationTestResponse``: the name
    is something the caller already knows and no client asked for it, so it stays
    out of the public contract.
    """

    response: AlertDestinationTestResponse
    destination_name: str


@dataclass(frozen=True)
class _TestTarget:
    """Everything the send needs, decrypted, with no ORM object attached.

    The send runs in a worker thread (``asyncio.to_thread``) because every
    channel client is blocking — urllib and smtplib. Handing a thread a
    SQLAlchemy instance bound to the request's AsyncSession would be a lazy-load
    from the wrong thread, so the snapshot is taken on the event loop first.
    """

    destination_id: uuid.UUID
    destination_type: str
    destination_name: str
    message: str
    webhook_url: str | None
    bot_token: str | None
    chat_id: str | None
    target_url: str | None
    webhook_header_name: str | None
    webhook_header_value: str | None
    email_recipients: str | None
    email_from_address: str | None
    jira_base_url: str | None
    jira_auth_email: str | None
    jira_api_token: str | None
    jira_project_key: str | None
    jira_issue_type: str | None
    linear_api_key: str | None
    linear_team_id: str | None
    linear_state_id: str | None
    linear_label_ids: str | None


def _decrypt(encrypted: str | None) -> str | None:
    if not encrypted:
        return None
    return decrypt_value(encrypted)


def _build_target(destination: AlertDestination, *, project_name: str) -> _TestTarget:
    return _TestTarget(
        destination_id=destination.id,
        destination_type=destination.type,
        destination_name=destination.name,
        message=_test_message(
            project_name=project_name,
            destination_name=destination.name,
        ),
        webhook_url=_decrypt(destination.webhook_url_encrypted),
        bot_token=_decrypt(destination.bot_token_encrypted),
        chat_id=destination.chat_id,
        target_url=_decrypt(destination.target_url_encrypted),
        webhook_header_name=destination.webhook_header_name,
        webhook_header_value=_decrypt(destination.webhook_header_value_encrypted),
        email_recipients=destination.email_recipients,
        email_from_address=destination.email_from_address,
        jira_base_url=destination.jira_base_url,
        jira_auth_email=destination.jira_auth_email,
        jira_api_token=_decrypt(destination.jira_api_token_encrypted),
        jira_project_key=destination.jira_project_key,
        jira_issue_type=destination.jira_issue_type,
        linear_api_key=_decrypt(destination.linear_api_key_encrypted),
        linear_team_id=destination.linear_team_id,
        linear_state_id=destination.linear_state_id,
        linear_label_ids=destination.linear_label_ids,
    )


def _send_slack(target: _TestTarget) -> None:
    from tripl.worker.tasks import alerts

    webhook_url = validate_slack_webhook_url(target.webhook_url or "")
    alerts._send_slack_message(
        webhook_url,
        target.message,
        message_format=ALERT_MESSAGE_FORMAT_PLAIN,
    )


def _send_telegram(target: _TestTarget) -> None:
    from tripl.worker.tasks import alerts

    bot_token = validate_telegram_bot_token(target.bot_token or "")
    chat_id = validate_telegram_chat_id(target.chat_id)
    alerts._send_telegram_message(
        bot_token,
        chat_id,
        target.message,
        message_format=ALERT_MESSAGE_FORMAT_PLAIN,
    )


def _send_webhook(target: _TestTarget) -> None:
    from tripl.worker.tasks import alerts
    from tripl.worker.tasks.alerts_channels import _reject_private_target

    url = validate_webhook_target_url(target.target_url or "")
    # Same DNS-rebinding re-check the real send does immediately before the
    # request; a test send is an equally good way to reach 169.254.169.254.
    _reject_private_target(url, field="Webhook target_url")
    alerts._send_webhook_message(
        url,
        {
            # A receiver that switches on `event` must be able to drop this
            # without parsing prose, so the test is typed, not just worded.
            "event": "tripl.destination_test",
            "destination": target.destination_name,
            "message": target.message,
        },
        header_name=target.webhook_header_name,
        header_value=target.webhook_header_value,
    )


def _send_email(target: _TestTarget) -> None:
    from tripl.services import app_settings_service
    from tripl.worker.tasks import alerts
    from tripl.worker.tasks.alerts_channels import _parse_email_recipients

    # No session argument: this runs off the event loop, so it opens its own
    # short-lived sync session exactly as the worker does.
    email_config = app_settings_service.get_email_config_sync()
    if not email_config.smtp_host:
        raise ValueError(
            "Email destination is configured but SMTP is not — set SMTP_HOST "
            "(and SMTP_USERNAME/SMTP_PASSWORD if your relay requires auth)."
        )
    recipients = _parse_email_recipients(validate_email_recipients(target.email_recipients))
    from_address = target.email_from_address or email_config.smtp_from_address
    if not from_address:
        raise ValueError("Email destination has no From: address and SMTP_FROM_ADDRESS is unset.")
    alerts._send_email_message(
        smtp_host=email_config.smtp_host,
        smtp_port=email_config.smtp_port,
        smtp_username=email_config.smtp_username,
        smtp_password=email_config.smtp_password,
        smtp_use_tls=email_config.smtp_use_tls,
        from_address=validate_email_address(from_address),
        recipients=recipients,
        subject=TEST_MESSAGE_SUBJECT,
        body=target.message,
    )


def _send_jira(target: _TestTarget) -> None:
    from tripl.worker.tasks import alerts
    from tripl.worker.tasks.alerts_channels import _reject_private_target

    base_url = validate_jira_base_url(target.jira_base_url)
    _reject_private_target(base_url, field="Jira base_url")
    alerts._send_jira_issue(
        base_url=base_url,
        auth_email=validate_jira_auth_email(target.jira_auth_email),
        api_token=validate_jira_api_token(target.jira_api_token or ""),
        project_key=validate_jira_project_key(target.jira_project_key),
        issue_type=validate_jira_issue_type(target.jira_issue_type or "Task"),
        summary=TEST_MESSAGE_SUBJECT,
        body_text=target.message,
    )


def _send_linear(target: _TestTarget) -> None:
    from tripl.worker.tasks import alerts

    alerts._send_linear_issue(
        api_key=validate_linear_api_key(target.linear_api_key or ""),
        team_id=validate_linear_team_id(target.linear_team_id),
        title=TEST_MESSAGE_SUBJECT,
        body_text=target.message,
        state_id=target.linear_state_id,
        label_ids=(
            [label for label in target.linear_label_ids.split(",") if label]
            if target.linear_label_ids
            else None
        ),
    )


_SENDERS: dict[AlertDestinationType, Callable[[_TestTarget], None]] = {
    AlertDestinationType.slack: _send_slack,
    AlertDestinationType.telegram: _send_telegram,
    AlertDestinationType.webhook: _send_webhook,
    AlertDestinationType.email: _send_email,
    AlertDestinationType.jira: _send_jira,
    AlertDestinationType.linear: _send_linear,
}


def _send_test_message(target: _TestTarget) -> None:
    sender = _SENDERS.get(AlertDestinationType(target.destination_type))
    if sender is None:
        raise ValueError(f"Unsupported destination type {target.destination_type}")
    sender(target)


async def send_destination_test(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
) -> DestinationTestOutcome:
    """Send one test message and report whether the channel took it."""
    project = await _get_project(session, slug)
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    destination_name = destination.name
    now = datetime.now(UTC)

    # A demo_sink has no outside to reach: it renders and records locally, which
    # is exactly what a real delivery through it does. Reporting ok here is the
    # truthful answer — "this destination works as configured" — and it keeps the
    # button from looking broken on the one destination a demo project may own
    # (tripl-2su6.6).
    if destination.type == AlertDestinationType.demo_sink:
        return DestinationTestOutcome(
            response=AlertDestinationTestResponse(ok=True, error=None, sent_at=now),
            destination_name=destination_name,
        )

    # The other half of the demo zero-egress rule (tripl-2su6.12). A demo ships a
    # permanently disabled Slack example purely to SHOW what a real channel looks
    # like; a test send is still a send, so it is refused here just as
    # send_alert_delivery refuses it. Not a 422: the operator asked a question
    # about the destination and this IS the answer.
    if project.is_demo:
        return DestinationTestOutcome(
            response=AlertDestinationTestResponse(
                ok=False,
                error=(
                    "Demo projects cannot send external alerts. This destination is a "
                    "disabled example — create a real project to test a live channel."
                ),
                # Nothing was sent, so there is no instant to report — but the
                # key is still present, because the response type says it is.
                sent_at=None,
            ),
            destination_name=destination_name,
        )

    # A DISABLED destination is still tested. Disabled means "route no alerts
    # here", and the commonest reason to press Test is to check credentials
    # before switching a destination back on — refusing would make the button
    # useless exactly when it is most wanted. The send is an explicit,
    # editor-only, one-message action, not routing.
    target = _build_target(destination, project_name=project.name)
    try:
        # Every channel client blocks (urllib, smtplib), so it must not run on the
        # request's event loop.
        await asyncio.to_thread(_send_test_message, target)
    except Exception as exc:  # noqa: BLE001
        # Deliberately broad, and deliberately not a 5xx. What comes back from a
        # channel is a ValueError from our own validators, a urllib/socket error,
        # an smtplib error or whatever a third-party client raises — enumerating
        # that set would mean a NEW channel's failure becomes a 500 the day it is
        # added, and a 500 tells the operator "Tripl is broken" when the correct
        # reading is "your token is". The message is already secret-safe:
        # _safe_url_for_error strips everything but scheme+host (tripl-jfm3.94).
        logger.warning(
            "Destination test send failed for %s (%s)",
            destination_id,
            destination.type,
            exc_info=True,
        )
        return DestinationTestOutcome(
            response=AlertDestinationTestResponse(ok=False, error=str(exc), sent_at=None),
            destination_name=destination_name,
        )

    return DestinationTestOutcome(
        response=AlertDestinationTestResponse(ok=True, error=None, sent_at=datetime.now(UTC)),
        destination_name=destination_name,
    )

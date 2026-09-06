"""One outbound message per destination, for a scheduled digest (tripl-o0u7).

``flush_due_alert_digests`` mints one ``AlertDelivery`` per (rule, scan config)
— that is what keeps per-rule templates, the Inbox, delivery history, Retry and
``_stamp_rule_state`` working exactly as they do on the immediate path. But
dispatching them one by one means a destination with N rules gets N separate
messages at 09:00, which is the burst the digest exists to remove.

So the combining happens at the TRANSPORT layer and nowhere else: every
delivery is still prepared individually, through the same guards and the same
renderer ``send_alert_delivery`` uses, and only the outbound call is shared.
Nothing about the row model, the templates or the schema changes.

**Only Slack and email combine.** Each of them is exactly one outbound call per
delivery today, so bundling is a straight concatenation with no new failure
mode. Deliberately excluded:

* **Telegram** — it already splits ONE delivery across several messages against
  a 4096-character ceiling and carries a per-delivery resume set plus a
  MarkdownV2→plain fallback. Bundling would make one rule's bad template
  silently downgrade every other rule in the digest, and a partially-accepted
  group has no per-rule resume story. It keeps today's path.
* **Jira / Linear** — one ticket per delivery is the documented contract, the
  create is not idempotent, and its dedup guard is a per-delivery external id.
* **Webhook** — the body is a documented singular-``rule`` consumer contract.
* **demo_sink** — local, non-sendable; there is no call to share.

Anything not combined is simply dispatched the way it always was, so this task
is never the only path to a channel.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session

logger = logging.getLogger(__name__)

# The channels whose whole delivery is one outbound call today, and which can
# therefore be concatenated without inventing a partial-failure story. See the
# module docstring for why every other channel is excluded.
COMBINABLE_CHANNELS = frozenset(
    {AlertDestinationType.slack.value, AlertDestinationType.email.value}
)

# Sections are joined by a blank line. No digest-level envelope is added: every
# default message template already opens with its own "[tripl] N alerts" banner
# (alert_templates.py), and a rule may carry a custom one, so a wrapper would
# either duplicate that or require dropping the operator's template.
_SECTION_SEPARATOR = "\n\n"


def _combinable(destination_type: str) -> bool:
    return destination_type in COMBINABLE_CHANNELS


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.alert_digest_send.send_alert_digest",
    bind=True,
)
def send_alert_digest(self: object, delivery_ids: list[str]) -> dict[str, object]:
    """Send one message per (destination, message format) for a flushed digest."""
    # Deferred, like maintenance.py's: celery_app imports this module from its
    # own bottom-of-file task registration, which can be reached from a
    # partially-initialized ``tripl.worker.tasks.alerts``, and a module-level
    # ``from ...alerts import x`` at that moment raises.
    from tripl.worker.tasks.alerts import (
        _assert_egress_allowed,
        _resolve_email_context,
        _resolve_slack_webhook,
        _send_email_message,
        _send_slack_message,
        _stamp_rule_state,
    )
    from tripl.worker.tasks.alerts_messages import (
        _append_ai_explanation,
        _build_ai_explanation,
        _build_email_subject,
        _render_delivery_message,
    )

    session = _get_sync_session()
    sent_count = 0
    failed_count = 0
    messages = 0
    try:
        deliveries = list(
            session.execute(
                select(AlertDelivery)
                .options(selectinload(AlertDelivery.items))
                .where(AlertDelivery.id.in_([uuid.UUID(value) for value in delivery_ids]))
                .order_by(AlertDelivery.created_at, AlertDelivery.id)
            )
            .scalars()
            .all()
        )
        # Same acks-late idempotency as the single-delivery task: a worker
        # SIGKILLed after a successful send but before its commit gets this task
        # re-queued, and the members that did commit must not be re-sent.
        pending = [
            delivery for delivery in deliveries if delivery.status != AlertDeliveryStatus.sent.value
        ]
        if not pending:
            return {"status": "already_sent", "messages": 0, "sent": 0, "failed": 0}

        # Rendering is shared across the whole batch: both caches key on item id
        # / metric ref rather than on a delivery, so the warehouse and DB reads
        # behind sparklines and units happen once for the digest instead of once
        # per rule.
        item_context_cache: dict[uuid.UUID, tuple[str, str]] = {}
        metric_units_cache: dict[str, str | None] = {}

        # (destination_id, message_format) — NOT destination alone. The format
        # comes from the RULE, so two rules on one Slack destination can disagree
        # (`plain` vs `slack_mrkdwn`), and one call carries exactly one format.
        groups: dict[tuple[uuid.UUID, str], list[tuple[AlertDelivery, str]]] = defaultdict(list)
        prepare_failures: list[tuple[AlertDelivery, Exception]] = []

        for delivery in pending:
            try:
                destination = session.get(AlertDestination, delivery.destination_id)
                rule = session.get(AlertRule, delivery.rule_id)
                scan_config = session.get(ScanConfig, delivery.scan_config_id)
                project = session.get(Project, delivery.project_id)
                if destination is None or rule is None or scan_config is None:
                    raise ValueError(f"AlertDelivery {delivery.id} is missing related objects")
                _assert_egress_allowed(destination, project)

                text, message_format = _render_delivery_message(
                    delivery,
                    destination=destination,
                    rule=rule,
                    scan_name=scan_config.name,
                    project=project,
                    session=session,
                    item_context_cache=item_context_cache,
                    metric_units_cache=metric_units_cache,
                )
                ai_explanation: str | None = None
                if rule.ai_explanation_enabled and not (project is not None and project.is_demo):
                    ai_explanation = _build_ai_explanation(
                        delivery,
                        scan_name=scan_config.name,
                        project_name=project.name if project else "",
                        item_context_cache=item_context_cache,
                        session=session,
                    )
                if ai_explanation:
                    text = _append_ai_explanation(text, ai_explanation, message_format)

                snapshot = (
                    dict(delivery.payload_snapshot)
                    if isinstance(delivery.payload_snapshot, dict)
                    else {}
                )
                snapshot["message_format"] = message_format
                snapshot["rendered_message"] = text
                if ai_explanation:
                    snapshot["ai_explanation"] = ai_explanation
                delivery.payload_snapshot = snapshot
                groups[(delivery.destination_id, message_format)].append((delivery, text))
            except Exception as exc:  # noqa: BLE001 — recorded per row below
                # NOT finalized here. `_finalize_failed`-style handling starts
                # with a rollback, which would discard the uncommitted snapshot
                # writes of every delivery already prepared in this loop and
                # ship them with an empty body. Collected and drained after the
                # sends instead.
                logger.exception("Failed to prepare digest member %s", delivery.id)
                prepare_failures.append((delivery, exc))

        for (destination_id, message_format), members in groups.items():
            destination = session.get(AlertDestination, destination_id)
            if destination is None:  # pragma: no cover - FK guarantees it
                continue
            body = _SECTION_SEPARATOR.join(text for _delivery, text in members)
            try:
                if destination.type == AlertDestinationType.slack:
                    _send_slack_message(
                        _resolve_slack_webhook(destination),
                        body,
                        message_format=message_format,
                    )
                elif destination.type == AlertDestinationType.email:
                    email_config, recipients, from_address = _resolve_email_context(
                        session, destination
                    )
                    first_rule = session.get(AlertRule, members[0][0].rule_id)
                    rule_names = {
                        session.get(AlertRule, delivery.rule_id).name  # type: ignore[union-attr]
                        for delivery, _text in members
                    }
                    # Never silently pick one rule's name for a subject that
                    # covers several. One rule keeps today's exact subject.
                    override = None if len(rule_names) == 1 else f"{len(rule_names)} monitors"
                    _send_email_message(
                        smtp_host=email_config.smtp_host,
                        smtp_port=email_config.smtp_port,
                        smtp_username=email_config.smtp_username,
                        smtp_password=email_config.smtp_password,
                        smtp_use_tls=email_config.smtp_use_tls,
                        from_address=from_address,
                        recipients=recipients,
                        subject=_build_email_subject(
                            template=destination.email_subject_template,
                            rule=first_rule,  # type: ignore[arg-type]
                            project=session.get(Project, members[0][0].project_id),
                            matched_count=sum(
                                delivery.matched_count for delivery, _text in members
                            ),
                            destination=destination,
                            message_format=message_format,
                            rule_name_override=override,
                        ),
                        body=body,
                    )
                else:  # pragma: no cover - routing keeps other channels out
                    raise ValueError(
                        f"Destination type {destination.type} is not combinable; "
                        "it must be dispatched per delivery"
                    )
            except Exception as exc:  # noqa: BLE001 — recorded per row below
                logger.exception(
                    "Failed to send digest to destination %s (%s)", destination_id, message_format
                )
                session.rollback()
                for delivery, _text in members:
                    fresh = session.get(AlertDelivery, delivery.id)
                    if fresh is None:
                        continue
                    fresh.status = AlertDeliveryStatus.failed.value
                    fresh.error_message = str(exc)
                    failed_count += 1
                session.commit()
                continue

            # One transaction for the whole group. Committing member-by-member
            # would let a crash mid-loop leave the rest `pending` after the
            # message had already gone out — and the stranded-delivery reaper
            # would then send those rules a second time.
            sent_at = datetime.now(UTC)
            for delivery, _text in members:
                delivery.status = AlertDeliveryStatus.sent.value
                delivery.sent_at = sent_at
                delivery.error_message = None
                _stamp_rule_state(session, delivery)
                sent_count += 1
            session.commit()
            messages += 1

        # Drained only now, after every successful group has committed, so a
        # rollback here cannot touch a delivery that was actually sent.
        for failed_delivery, failure in prepare_failures:
            session.rollback()
            fresh = session.get(AlertDelivery, failed_delivery.id)
            if fresh is None:
                continue
            fresh.status = AlertDeliveryStatus.failed.value
            fresh.error_message = str(failure)
            session.commit()
            failed_count += 1

        return {
            "status": "sent",
            "messages": messages,
            "sent": sent_count,
            "failed": failed_count,
        }
    finally:
        session.close()

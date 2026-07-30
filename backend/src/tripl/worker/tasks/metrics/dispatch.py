from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import AlertMatchCandidate, rule_matches_anomaly
from tripl.core.analyzers.anomaly_detector import SCOPE_METRIC
from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.domain_enums import AnomalyDirection
from tripl.models.scan_config import ScanConfig
from tripl.worker.tasks.metrics.alert_payload import (
    _build_alert_scope_names,
    _build_delivery_snapshot,
    _load_enabled_alert_destinations,
)
from tripl.worker.tasks.metrics.signals import (
    _get_active_distribution_drift_candidates,
    _get_active_metric_anomaly_candidates,
    _get_active_release_regression_candidates,
    _get_active_schema_drift_candidates,
    _get_active_variable_value_drift_candidates,
    _get_latest_active_anomalies,
)
from tripl.worker.tasks.metrics.urls import (
    _build_event_details_url,
    _build_monitoring_url,
    _get_project_slug,
)

# Pure rule/anomaly matchers live in tripl.alerting_matching so the in-UI
# simulator and the live pipeline use a single source of truth. Kept as an
# alias here because this module references it via the private name.
_rule_matches_anomaly = rule_matches_anomaly
_CORRELATION_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "tripl-alert-correlation")


def _as_utc(value: datetime | None) -> datetime | None:
    """Postgres hands back tz-aware values for timestamptz; SQLite does not.

    Comparing a naive stored value against ``datetime.now(UTC)`` raises, so the
    mute-expiry checks below normalise first rather than assume the driver.
    """
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def _correlation_group_id(
    *,
    scan_config_id: uuid.UUID,
    rule_id: uuid.UUID,
    direction: str,
) -> uuid.UUID:
    """The stable handle for one ongoing incident: a rule firing one direction.

    The bucket used to be part of this key, which made every hour of the same
    incident a brand-new group. Nothing the user did in the inbox could survive
    the next collection: acknowledging, resolving or muting a group silenced
    exactly the bucket already delivered, and an hour later an unseen group
    alerted again (tripl-jfm3.91).

    Dropping the bucket makes the group live as long as the incident does.
    ``_reopen_closed_incidents`` resets it once every scope of the rule has
    closed, so a genuinely new incident is never silenced by an old decision.
    """
    return uuid.uuid5(
        _CORRELATION_NAMESPACE,
        f"{scan_config_id}:{rule_id}:{direction}",
    )


# Statuses that stop re-delivery. ``acknowledged`` means "seen, being worked on"
# — it belongs here: an operator who acked an incident and kept getting paged
# for it every hour reported the inbox as decorative, which it was, since ack
# was the one action with no effect on delivery at all (tripl-jfm3.91).
_SUPPRESSING_INBOX_STATUSES = ("acknowledged", "resolved", "false_positive", "muted")


def _suppressed_correlation_group_ids(
    session: Session,
    *,
    project_id: uuid.UUID,
) -> set[uuid.UUID]:
    now = datetime.now(UTC)
    rows = session.execute(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.status.in_(_SUPPRESSING_INBOX_STATUSES),
        )
    ).scalars()
    suppressed: set[uuid.UUID] = set()
    for state in rows:
        muted_until = _as_utc(state.muted_until)
        if state.status == "muted" and muted_until is not None and muted_until <= now:
            state.status = "open"
            state.muted_until = None
            continue
        suppressed.add(state.correlation_group_id)
    return suppressed


def _reopen_closed_incidents(
    session: Session,
    *,
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> None:
    """Clear an incident-scoped inbox decision once the incident is over.

    Without this, suppression would be permanent: acknowledging a drop would
    silence that rule's drops forever. Called only when the rule has no active
    scope left, so the next firing is a new incident and alerts normally.

    A TIMED mute is deliberately excluded. "Acknowledged" means "I am on this
    incident" and dies with it; "muted until T" means "do not tell me before T"
    regardless of what the signal does in between. Resetting it here killed a
    seven-day mute on the first quiet collection and paged the user again hours
    later (tripl-jfm3.98). A lapsed mute is already reopened by
    ``_suppressed_correlation_group_ids``, so mutes have their own lifecycle.
    """
    group_ids = [
        _correlation_group_id(
            scan_config_id=scan_config_id,
            rule_id=rule_id,
            direction=direction.value,
        )
        for direction in AnomalyDirection
    ]
    now = datetime.now(UTC)
    for state in session.execute(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.correlation_group_id.in_(group_ids),
            AlertCorrelationState.status != "open",
        )
    ).scalars():
        muted_until = _as_utc(state.muted_until)
        if state.status == "muted" and muted_until is not None and muted_until > now:
            continue
        state.status = "open"
        state.muted_until = None


def _touch_correlation_state(
    session: Session,
    *,
    project_id: uuid.UUID,
    correlation_group_id: uuid.UUID,
    seen_at: datetime,
) -> None:
    state = session.execute(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.correlation_group_id == correlation_group_id,
        )
    ).scalar_one_or_none()
    if state is None:
        session.add(
            AlertCorrelationState(
                project_id=project_id,
                correlation_group_id=correlation_group_id,
                status="open",
                last_seen_at=seen_at,
            )
        )
        return
    state.last_seen_at = max(state.last_seen_at or seen_at, seen_at)


def _project_metric_state_config_id(session: Session, config: ScanConfig) -> uuid.UUID:
    """Canonical scan_config_id for project-global (``metric``-scope) AlertRuleState.

    ``metric``-scope anomalies are project-global (NULL ``scan_config_id`` on the
    anomaly row), but ``AlertRuleState.scan_config_id`` is a NOT-NULL FK to
    scan_configs, so it cannot be NULL or a synthetic id. ``_prepare_alert_
    deliveries`` runs once per scan config, and every run for the project sees the
    same metric anomaly. Keying the rule state on ``config.id`` would give each
    config its own cooldown clock and re-send the same metric anomaly N times.

    We instead anchor every metric-scope rule state on a deterministic
    project-canonical config id (the lowest config id in the project), so all
    config runs converge on ONE shared state row and ONE cooldown clock. It stays
    a real FK target; if that config is deleted its states cascade away and the
    next-lowest id becomes canonical.
    """
    config_ids = list(
        session.execute(
            select(ScanConfig.id).where(ScanConfig.project_id == config.project_id)
        ).scalars()
    )
    return min(config_ids) if config_ids else config.id


def _prepare_alert_deliveries(
    session: Session,
    config: ScanConfig,
    *,
    scan_job_id: uuid.UUID | None,
) -> list[uuid.UUID]:
    active_candidates: dict[tuple[str, str], AlertMatchCandidate] = {}
    active_candidates.update(_get_latest_active_anomalies(session, config))
    active_candidates.update(_get_active_metric_anomaly_candidates(session, config))
    active_candidates.update(_get_active_schema_drift_candidates(session, config))
    active_candidates.update(_get_active_distribution_drift_candidates(session, config))
    active_candidates.update(_get_active_release_regression_candidates(session, config))
    active_candidates.update(_get_active_variable_value_drift_candidates(session, config))
    destinations = _load_enabled_alert_destinations(session, config.project_id)
    if not destinations:
        return []

    now = datetime.now(UTC)
    project_slug = _get_project_slug(session, config.project_id)
    # ``metric`` scopes are project-global; anchor their rule state on a single
    # canonical config so cooldown is shared across every config's dispatch run.
    metric_state_config_id = _project_metric_state_config_id(session, config)
    scope_names = _build_alert_scope_names(session, list(active_candidates.values()))
    delivery_ids: list[uuid.UUID] = []
    suppressed_group_ids = _suppressed_correlation_group_ids(
        session,
        project_id=config.project_id,
    )

    for destination in destinations:
        enabled_rules = [rule for rule in destination.rules if rule.enabled]
        if not enabled_rules:
            continue

        for rule in enabled_rules:
            # Non-metric scopes are config-partitioned (state keyed by config.id);
            # metric scopes are project-global, keyed by the canonical config so
            # the cooldown clock is shared across every config run.
            existing_states = {
                (state.scope_type, state.scope_ref): state
                for state in session.execute(
                    select(AlertRuleState).where(
                        AlertRuleState.rule_id == rule.id,
                        AlertRuleState.scan_config_id == config.id,
                        AlertRuleState.scope_type != SCOPE_METRIC,
                    )
                ).scalars()
            }
            for state in session.execute(
                select(AlertRuleState).where(
                    AlertRuleState.rule_id == rule.id,
                    AlertRuleState.scan_config_id == metric_state_config_id,
                    AlertRuleState.scope_type == SCOPE_METRIC,
                )
            ).scalars():
                existing_states[(state.scope_type, state.scope_ref)] = state

            matched_anomalies = [
                candidate
                for candidate in active_candidates.values()
                if _rule_matches_anomaly(rule, candidate)
            ]
            matched_keys = {
                (anomaly.scope_type, anomaly.scope_ref) for anomaly in matched_anomalies
            }

            for key, existing_state in existing_states.items():
                if existing_state.is_active and key not in matched_keys:
                    existing_state.is_active = False
                    existing_state.closed_at = now
            # The incident is over once no scope of this rule is firing. Clear
            # any inbox decision now so the NEXT incident is not silenced by a
            # stale acknowledge — suppression would otherwise be permanent.
            if existing_states and not any(state.is_active for state in existing_states.values()):
                _reopen_closed_incidents(
                    session,
                    project_id=config.project_id,
                    scan_config_id=config.id,
                    rule_id=rule.id,
                )

            anomalies_to_send: list[AlertMatchCandidate] = []
            for anomaly in matched_anomalies:
                key = (anomaly.scope_type, anomaly.scope_ref)
                current_state = existing_states.get(key)
                should_send = False
                if current_state is None:
                    state_config_id = (
                        metric_state_config_id if anomaly.scope_type == SCOPE_METRIC else config.id
                    )
                    current_state = AlertRuleState(
                        rule_id=rule.id,
                        scan_config_id=state_config_id,
                        scope_type=anomaly.scope_type,
                        scope_ref=anomaly.scope_ref,
                        is_active=True,
                        opened_at=now,
                        closed_at=None,
                        last_anomaly_bucket=anomaly.bucket,
                    )
                    session.add(current_state)
                    existing_states[key] = current_state
                    should_send = True
                else:
                    if not current_state.is_active:
                        current_state.is_active = True
                        current_state.opened_at = now
                        current_state.closed_at = None
                        should_send = True
                    elif (
                        current_state.last_notified_at is None
                        or (
                            current_state.last_anomaly_bucket is None
                            or anomaly.bucket > current_state.last_anomaly_bucket
                        )
                        and now - current_state.last_notified_at
                        >= timedelta(minutes=rule.cooldown_minutes)
                    ):
                        should_send = True
                    current_state.last_anomaly_bucket = max(
                        anomaly.bucket,
                        current_state.last_anomaly_bucket or anomaly.bucket,
                    )
                if should_send:
                    anomalies_to_send.append(anomaly)

            if not anomalies_to_send:
                continue

            # A muted monitor delivers nothing. The rule states above are still
            # updated first, deliberately: open/close tracking has to stay
            # accurate through the mute so the monitor is not stuck "firing" on
            # a stale scope once the mute lapses.
            #
            # AlertRule.muted_until had no reader in the worker at all — the
            # model comment called worker-side suppression "a separate
            # follow-up" — so the Monitors UI shipped a Mute button that wrote a
            # column and changed nothing (tripl-jfm3.99).
            rule_muted_until = _as_utc(rule.muted_until)
            if rule_muted_until is not None and rule_muted_until > now:
                continue

            # EVERY item gets a correlation_group_id, not just co-fired ones.
            # The id doubles as the inbox handle, and the inbox only lists items
            # that have one — so while it was reserved for 2+ peers, a solitary
            # alert never reached the inbox and no action could reach it either.
            # That is the common case, and it was unactionable (tripl-jfm3.91).
            # Co-firing is now derived from the peer count when rendering, not
            # from whether the id exists.
            correlation_by_anomaly: dict[int, uuid.UUID] = {}
            for anomaly in anomalies_to_send:
                correlation_by_anomaly[id(anomaly)] = _correlation_group_id(
                    scan_config_id=config.id,
                    rule_id=rule.id,
                    direction=anomaly.direction,
                )

            if suppressed_group_ids:
                anomalies_to_send = [
                    anomaly
                    for anomaly in anomalies_to_send
                    if correlation_by_anomaly.get(id(anomaly)) not in suppressed_group_ids
                ]
            if not anomalies_to_send:
                continue

            payload_snapshot = _build_delivery_snapshot(
                config,
                project_slug=project_slug,
                rule=rule,
                destination=destination,
                anomalies=anomalies_to_send,
                scope_names=scope_names,
            )
            delivery = AlertDelivery(
                project_id=config.project_id,
                scan_config_id=config.id,
                scan_job_id=scan_job_id,
                destination_id=destination.id,
                rule_id=rule.id,
                status=AlertDeliveryStatus.pending.value,
                channel=destination.type,
                matched_count=len(anomalies_to_send),
                payload_snapshot=payload_snapshot,
            )
            session.add(delivery)
            session.flush()

            for anomaly in anomalies_to_send:
                absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
                percent_delta = (
                    absolute_delta / anomaly.expected_count * 100
                    if anomaly.expected_count > 0
                    else 0.0
                )
                session.add(
                    AlertDeliveryItem(
                        delivery_id=delivery.id,
                        scope_type=anomaly.scope_type,
                        scope_ref=anomaly.scope_ref,
                        scope_name=scope_names[(anomaly.scope_type, anomaly.scope_ref)],
                        event_type_id=anomaly.event_type_id,
                        event_id=anomaly.event_id,
                        bucket=anomaly.bucket,
                        direction=anomaly.direction,
                        actual_count=anomaly.actual_count,
                        expected_count=anomaly.expected_count,
                        absolute_delta=absolute_delta,
                        percent_delta=percent_delta,
                        details_path=_build_event_details_url(
                            project_slug,
                            anomaly.event_id,
                        ),
                        monitoring_path=_build_monitoring_url(
                            project_slug,
                            scope_type=anomaly.scope_type,
                            scope_ref=anomaly.scope_ref,
                        ),
                        drift_field=getattr(anomaly, "drift_field", None),
                        drift_type=getattr(anomaly, "drift_type", None),
                        sample_value=getattr(anomaly, "sample_value", None),
                        correlation_group_id=correlation_by_anomaly.get(id(anomaly)),
                    )
                )
                item_group_id = correlation_by_anomaly.get(id(anomaly))
                if item_group_id is not None:
                    _touch_correlation_state(
                        session,
                        project_id=config.project_id,
                        correlation_group_id=item_group_id,
                        seen_at=anomaly.bucket,
                    )
            delivery_ids.append(delivery.id)

    return delivery_ids

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import AlertMatchCandidate, rule_matches_anomaly
from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.scan_config import ScanConfig
from tripl.worker.tasks.metrics.alert_payload import (
    _build_alert_scope_names,
    _build_delivery_snapshot,
    _load_enabled_alert_destinations,
)
from tripl.worker.tasks.metrics.signals import (
    _get_active_distribution_drift_candidates,
    _get_active_release_regression_candidates,
    _get_active_schema_drift_candidates,
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


def _correlation_group_id(
    *,
    scan_config_id: uuid.UUID,
    rule_id: uuid.UUID,
    bucket: datetime,
    direction: str,
) -> uuid.UUID:
    return uuid.uuid5(
        _CORRELATION_NAMESPACE,
        f"{scan_config_id}:{rule_id}:{bucket.isoformat()}:{direction}",
    )


def _suppressed_correlation_group_ids(
    session: Session,
    *,
    project_id: uuid.UUID,
) -> set[uuid.UUID]:
    now = datetime.now(UTC)
    rows = session.execute(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.status.in_(("resolved", "false_positive", "muted")),
        )
    ).scalars()
    suppressed: set[uuid.UUID] = set()
    for state in rows:
        if state.status == "muted" and state.muted_until is not None and state.muted_until <= now:
            state.status = "open"
            state.muted_until = None
            continue
        suppressed.add(state.correlation_group_id)
    return suppressed


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


def _prepare_alert_deliveries(
    session: Session,
    config: ScanConfig,
    *,
    scan_job_id: uuid.UUID | None,
) -> list[uuid.UUID]:
    active_candidates: dict[tuple[str, str], AlertMatchCandidate] = {}
    active_candidates.update(_get_latest_active_anomalies(session, config))
    active_candidates.update(_get_active_schema_drift_candidates(session, config))
    active_candidates.update(_get_active_distribution_drift_candidates(session, config))
    active_candidates.update(_get_active_release_regression_candidates(session, config))
    destinations = _load_enabled_alert_destinations(session, config.project_id)
    if not destinations:
        return []

    now = datetime.now(UTC)
    project_slug = _get_project_slug(session, config.project_id)
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
            existing_states = {
                (state.scope_type, state.scope_ref): state
                for state in session.execute(
                    select(AlertRuleState).where(
                        AlertRuleState.rule_id == rule.id,
                        AlertRuleState.scan_config_id == config.id,
                    )
                ).scalars()
            }

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

            anomalies_to_send: list[AlertMatchCandidate] = []
            for anomaly in matched_anomalies:
                key = (anomaly.scope_type, anomaly.scope_ref)
                current_state = existing_states.get(key)
                should_send = False
                if current_state is None:
                    current_state = AlertRuleState(
                        rule_id=rule.id,
                        scan_config_id=config.id,
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

            # Correlate anomalies that co-fired in the same bucket+direction
            # within this delivery. Anything with at least one peer gets a
            # shared correlation_group_id so the UI can chip + group rows.
            correlation_groups: dict[tuple[datetime, str], list[AlertMatchCandidate]] = {}
            for anomaly in anomalies_to_send:
                correlation_groups.setdefault((anomaly.bucket, anomaly.direction), []).append(
                    anomaly
                )
            correlation_by_anomaly: dict[int, uuid.UUID] = {}
            for (bucket, direction), peers in correlation_groups.items():
                if len(peers) < 2:
                    continue
                group_id = _correlation_group_id(
                    scan_config_id=config.id,
                    rule_id=rule.id,
                    bucket=bucket,
                    direction=direction,
                )
                for peer in peers:
                    correlation_by_anomaly[id(peer)] = group_id

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
                        expected_count=round(anomaly.expected_count),
                        absolute_delta=round(absolute_delta),
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

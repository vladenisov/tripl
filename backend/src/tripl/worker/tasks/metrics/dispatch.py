from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl.alerting_matching import AlertMatchCandidate, rule_matches_anomaly
from tripl.core.analyzers.anomaly_detector import SCOPE_METRIC
from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_pending_item import AlertPendingItem
from tripl.models.alert_rule import AlertRule
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
    _build_item_paths,
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


def _cooldown_elapsed(
    last_notified_at: datetime | None,
    *,
    now: datetime,
    cooldown_minutes: int,
) -> bool:
    """Whether ``cooldown_minutes`` have passed since this scope was last notified.

    Keyed on the last SUCCESSFUL notification (``alerts.py`` stamps
    ``last_notified_at`` only on a sent delivery), not on the open/close flag, so
    a scope that closes and reopens on the next collection is still inside its
    cooldown while one that reopens days later is not.

    A NULL means the operator has never been told about this scope — a cooldown
    cannot have elapsed on a message that was never sent, so it reads as elapsed
    and the first delivery goes out.
    """
    last = _as_utc(last_notified_at)
    if last is None:
        return True
    return now - last >= timedelta(minutes=cooldown_minutes)


def _correlation_group_id(
    *,
    scan_config_id: uuid.UUID,
    rule_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    direction: str,
) -> uuid.UUID:
    """The stable handle for one ongoing incident: one rule, one scope, one direction.

    The BUCKET is deliberately absent. While it was part of the key, every hour
    of the same incident was a brand-new group and nothing the user did in the
    inbox survived the next collection: acknowledging, resolving or muting
    silenced exactly the bucket already delivered, and an hour later an unseen
    group alerted again (tripl-jfm3.91). Leaving it out makes the group live as
    long as the incident does, and it must stay out.

    The SCOPE is present because ``_SUPPRESSING_INBOX_STATUSES`` gates the whole
    group. Keyed on scan_config:rule:direction alone, one inbox action silenced
    every other scope the rule watched, and the sole release path
    (``_reopen_closed_incidents``) waited for every scope of the rule to close —
    which the suppressed scope, still firing and now unseen, prevented. On
    production one 2026-07-30 operator note ("these screens are switched off")
    on group bd6c96f5 covered 7 unrelated iOS scopes of a single "drop" rule.

    ``_reopen_closed_incidents`` now resets a scope's groups as soon as THAT
    scope's alert state is closed, so a genuinely new incident is never silenced
    by an old decision.
    """
    return uuid.uuid5(
        _CORRELATION_NAMESPACE,
        f"{scan_config_id}:{rule_id}:{scope_type}:{scope_ref}:{direction}",
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
    scope_keys: Iterable[tuple[str, str]],
) -> None:
    """Clear an incident-scoped inbox decision once the incident is over.

    Without this, suppression would be permanent: acknowledging a drop would
    silence that scope's drops forever. Called for the scopes whose alert state
    is closed, so their next firing is a new incident and alerts normally.

    Per SCOPE, matching ``_correlation_group_id``. The old rule-wide reset needed
    every scope of the rule to be quiet at once, which a suppressed scope could
    never be — it kept firing, unseen, holding its own release hostage.

    A mute is deliberately excluded, timed or indefinite. "Acknowledged" means
    "I am on this incident" and dies with it; "muted until T" means "do not tell
    me before T" regardless of what the signal does in between. Resetting it here
    killed a seven-day mute on the first quiet collection and paged the user
    again hours later (tripl-jfm3.98).

    An INDEFINITE mute (``muted_until`` NULL — "muted until I unmute") is the
    same promise with no T at all, and is the one a fall-through hurts most: its
    release is a deliberate human act, so nothing downstream would ever restore
    the row. The check below is therefore ``muted_until is None or muted_until >
    now`` and NOT ``is not None and > now``, which read a NULL as an expiry
    infinitely far in the past and silently released the strongest mute in the
    product on the first quiet scan (tripl-a50u). Unreachable until the inbox
    validator started accepting a mute with no expiry, which is precisely why it
    had to be fixed in the same change.

    Note the OPPOSITE shape at the rule-mute check in
    ``_prepare_alert_deliveries``: on an ``AlertRule`` a NULL ``muted_until``
    means NOT MUTED, because a rule carries no status column to tell "never
    muted" from "muted forever" and NULL is the default on every rule ever
    created. The two lines look alike and must not be made to agree — see
    ``AlertInboxActionRequest.validate_action``.

    A LAPSED mute is still reopened, by ``_suppressed_correlation_group_ids``, so
    mutes have their own lifecycle and this function does not run it.
    """
    group_ids = [
        _correlation_group_id(
            scan_config_id=scan_config_id,
            rule_id=rule_id,
            scope_type=scope_type,
            scope_ref=scope_ref,
            direction=direction.value,
        )
        for scope_type, scope_ref in scope_keys
        for direction in AnomalyDirection
    ]
    if not group_ids:
        return
    now = datetime.now(UTC)
    for state in session.execute(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.correlation_group_id.in_(group_ids),
            AlertCorrelationState.status != "open",
        )
    ).scalars():
        muted_until = _as_utc(state.muted_until)
        if state.status == "muted" and (muted_until is None or muted_until > now):
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


# Telegram rejects a sendMessage body over 4096 characters with a 400, and
# ``last_notified_at`` is stamped only on a SUCCESSFUL send (alerts.py), while
# the re-send gate below treats a NULL ``last_notified_at`` as "never told
# them" — so one oversized delivery is rebuilt and re-rejected on every
# collection, forever.
#
# Sized off the 29 Telegram deliveries windy-ios has ever sent ("TG dev",
# default templates, AI note attached): least squares over their
# (matched_count, rendered chars) gave 400 chars per item on a 516-char base,
# which crosses 4096 just under 9 items — and on the widest base observed (682,
# the AI note varies) exactly at 8.
#
# Those renders PREDATE aafa632, which collapsed the duplicate
# details/monitoring line when both resolve to the same page — worth about 90
# characters per item on an event scope, so the honest present-day crossover is
# nearer 13 than 9. Keeping 8 anyway: the per-item cost varies fourfold with
# which optional lines an item carries (97-389 chars across those same
# deliveries), the item template is user-editable, and being early with a second
# message costs nothing while being late costs the whole delivery.
#
# No delivery that large exists yet: the biggest real one is 5 items / 2420
# chars, because volume scopes could not alert at all (see
# ``signals._emission_lag``). The replay that unblocks them rendered 14 items /
# 4154 chars, which is when this ceiling starts to matter.
#
# This bounds the ITEM COUNT, not characters: the item template is user-editable
# and the AI explanation is generated after dispatch, so a chunk this size can
# still overshoot. The hard 4096 ceiling is enforced where the finished message
# exists — ``alerts_messages.split_telegram_messages`` measures each one
# assembled, in Telegram's UTF-16 units, and sends a chunk as several messages
# when it has to. This estimate stays anyway: it costs nothing and keeps the
# common case to one message per delivery. Only Telegram is capped — Slack,
# email and webhook have no comparable limit, and chunking jira/linear would file
# duplicate issues.
_MAX_ITEMS_PER_DELIVERY: dict[str, int] = {AlertDestinationType.telegram.value: 8}


def _delivery_chunks(
    anomalies: list[AlertMatchCandidate],
    *,
    channel: str,
) -> list[list[AlertMatchCandidate]]:
    """Split one rule's matches into deliveries the channel can actually carry.

    Chunking rather than truncating: every chunk is its own AlertDelivery with
    its own items, so no scope is silently dropped and each chunk stamps
    ``last_notified_at`` on the states it covers once it lands.
    """
    limit = _MAX_ITEMS_PER_DELIVERY.get(str(channel))
    if limit is None or len(anomalies) <= limit:
        return [anomalies]
    return [anomalies[start : start + limit] for start in range(0, len(anomalies), limit)]


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

        # A destination on a delivery cadence holds its alerts in
        # ``alert_pending_items`` until ``flush_due_alert_digests`` mints the
        # digest, and the cadence IS that destination's rate limiter. The
        # rule's ``cooldown_minutes`` is therefore NOT applied a second time
        # here.
        #
        # Applying both puts two limiters of comparable period in series, and
        # the default makes them the SAME period: ``cooldown_minutes`` defaults
        # to 1440 and "daily at 09:00" is the cadence people ask for. The
        # cooldown clock starts when the digest is SENT, a hair after the fire
        # instant, so the next day's collections are all a few seconds short of
        # elapsed and buffer nothing — every other digest arrives empty and the
        # real delivery rate halves. Letting the cadence own the rate is both
        # simpler and what a digest means: here is what is wrong right now.
        #
        # The freshness half of the gate is untouched, so a scope that produced
        # no new bucket is still not re-reported, and the buffer's unique key
        # collapses a scope that re-fires all day into ONE digest line.
        cooldown_applies = destination.delivery_schedule_cron is None

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
            # A scope's incident is over once that scope stops firing. Clear its
            # inbox decision now so the NEXT incident on it is not silenced by a
            # stale acknowledge — suppression would otherwise be permanent.
            # Every closed scope, every run, so this stays idempotent.
            #
            # ``key not in matched_keys`` carries the whole safety of this. A
            # state is still closed at this point when the scope's previous
            # anomaly aged out; the loop below is what reopens it. Reading the
            # flag alone would therefore clear the acknowledgement of a scope
            # that is firing RIGHT NOW — and that is the common case, not the
            # rare one, since a scope closes and re-enters on nearly every
            # collection (see the reactivation branch: 93% of sends arrive
            # through it). The rule-wide predicate this replaced was accidentally
            # safe here, because any other live scope of the rule vetoed the
            # reset; per-scope keys removed that veto and have to say it outright.
            closed_keys = [
                key
                for key, state in existing_states.items()
                if not state.is_active and key not in matched_keys
            ]
            if closed_keys:
                _reopen_closed_incidents(
                    session,
                    project_id=config.project_id,
                    scan_config_id=config.id,
                    rule_id=rule.id,
                    scope_keys=closed_keys,
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
                        # Reopen the state either way: open/close tracking has to
                        # stay accurate even when the cooldown swallows the
                        # notification, or the scope reads as quiet on the UI.
                        current_state.is_active = True
                        current_state.opened_at = now
                        current_state.closed_at = None
                        # Gated on elapsed time, not on the flag alone. A volume
                        # scope is a candidate for a bounded run of collections
                        # per anomaly bucket, then closes, and its next anomaly
                        # re-enters here — so an ungated reactivation IS the
                        # normal path, not the rare one: over a 24h replay of
                        # live data 406 of 436 sends (93%) came through here, 30
                        # were first-ever scope state and ZERO reached the
                        # cooldown branch below. Raising cooldown_minutes from
                        # 360 to 1440 moved zero deliveries and zero items,
                        # because nothing consulted it. Elapsed time still lets
                        # the case this branch exists for through: a scope that
                        # closed and reopens long after keeps alerting.
                        should_send = not cooldown_applies or _cooldown_elapsed(
                            current_state.last_notified_at,
                            now=now,
                            cooldown_minutes=rule.cooldown_minutes,
                        )
                    elif current_state.last_notified_at is None or (
                        (
                            current_state.last_anomaly_bucket is None
                            or anomaly.bucket > current_state.last_anomaly_bucket
                        )
                        and (
                            not cooldown_applies
                            or _cooldown_elapsed(
                                current_state.last_notified_at,
                                now=now,
                                cooldown_minutes=rule.cooldown_minutes,
                            )
                        )
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
            #
            # ``is not None and > now`` is correct HERE and must stay: a NULL on
            # an AlertRule means NOT MUTED (it is the default on every rule ever
            # created, and the rule has no status column to say otherwise). The
            # near-identical line in ``_reopen_closed_incidents`` reads a NULL
            # the OPPOSITE way — there it is the indefinite inbox mute — so do
            # not unify them (tripl-a50u). A rule's permanent lever is
            # ``enabled``.
            rule_muted_until = _as_utc(rule.muted_until)
            if rule_muted_until is not None and rule_muted_until > now:
                continue

            # EVERY item gets a correlation_group_id, not just co-fired ones.
            # The id doubles as the inbox handle, and the inbox only lists items
            # that have one — so while it was reserved for 2+ peers, a solitary
            # alert never reached the inbox and no action could reach it either.
            # That is the common case, and it was unactionable (tripl-jfm3.91).
            #
            # The id is per SCOPE now (see ``_correlation_group_id``), so peers
            # inside one group are the same scope over time, not the scopes that
            # fired together. Anything asking "did this co-fire?" has to count the
            # DELIVERY's items — ``alerts_messages._build_ai_explanation`` still
            # counts group members and now always sees one.
            correlation_by_anomaly: dict[int, uuid.UUID] = {}
            for anomaly in anomalies_to_send:
                correlation_by_anomaly[id(anomaly)] = _correlation_group_id(
                    scan_config_id=config.id,
                    rule_id=rule.id,
                    scope_type=anomaly.scope_type,
                    scope_ref=anomaly.scope_ref,
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

            if destination.delivery_schedule_cron is None:
                delivery_ids.extend(
                    _create_deliveries(
                        session,
                        config,
                        project_slug=project_slug,
                        rule=rule,
                        destination=destination,
                        anomalies=anomalies_to_send,
                        scope_names=scope_names,
                        correlation_by_anomaly=correlation_by_anomaly,
                        scan_job_id=scan_job_id,
                    )
                )
            else:
                # Held for this destination's next digest window. Nothing is
                # dispatched now and no AlertDelivery exists yet, so the
                # stranded-delivery reaper has nothing to sweep and the Inbox,
                # the delivery history and their created_at orderings are
                # untouched until the digest is actually minted.
                _buffer_pending_items(
                    session,
                    config,
                    rule=rule,
                    destination=destination,
                    anomalies=anomalies_to_send,
                    scope_names=scope_names,
                    correlation_by_anomaly=correlation_by_anomaly,
                    scan_job_id=scan_job_id,
                    metric_state_config_id=metric_state_config_id,
                    now=now,
                )

    return delivery_ids


def _create_deliveries(
    session: Session,
    config: ScanConfig,
    *,
    project_slug: str,
    rule: AlertRule,
    destination: AlertDestination,
    anomalies: list[AlertMatchCandidate],
    scope_names: dict[tuple[str, str], str],
    correlation_by_anomaly: dict[int, uuid.UUID],
    scan_job_id: uuid.UUID | None,
) -> list[uuid.UUID]:
    """Mint the AlertDelivery + AlertDeliveryItem rows for one (rule, destination).

    Extracted verbatim from ``_prepare_alert_deliveries`` so the immediate path
    and the scheduled flush (``worker/tasks/alert_flush.py``) mint deliveries
    through ONE code path. That matters more than it looks: this is where the
    three machine-readable encodings of a delivery are born together — the
    ``payload_snapshot`` JSON, the ``AlertDeliveryItem`` rows, and the chunking
    that keeps a Telegram message under its item cap. A second implementation
    for digests would be a second chance for them to disagree.
    """
    delivery_ids: list[uuid.UUID] = []
    for chunk in _delivery_chunks(anomalies, channel=destination.type):
        delivery = AlertDelivery(
            project_id=config.project_id,
            scan_config_id=config.id,
            scan_job_id=scan_job_id,
            destination_id=destination.id,
            rule_id=rule.id,
            status=AlertDeliveryStatus.pending.value,
            channel=destination.type,
            matched_count=len(chunk),
            payload_snapshot=None,
        )
        session.add(delivery)
        session.flush()
        # The snapshot is built AFTER the flush because it now contains
        # links back to this delivery's own audit row, and those need
        # the id. Whole-object assignment (not in-place mutation) so
        # SQLAlchemy sees the JSON column change.
        delivery.payload_snapshot = _build_delivery_snapshot(
            config,
            project_slug=project_slug,
            rule=rule,
            destination=destination,
            anomalies=chunk,
            scope_names=scope_names,
            delivery_id=delivery.id,
        )

        for anomaly in chunk:
            absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
            # 0.0 at a zero baseline is a PLACEHOLDER, not a measurement:
            # the ratio is undefined and the column is NOT NULL. Nothing
            # may emit it as it stands. Readers go through one of two
            # encodings of the same gate: humans get the words via
            # ``alert_templates.format_percent_delta`` (the message's
            # ${percent_delta_label}, the AI prompt) or the frontend's
            # ``lib/percentDelta`` mirror; machines get JSON ``null`` via
            # ``alert_templates.percent_delta_or_none`` (the generic
            # webhook body, ``payload_snapshot``). The percent gate admits
            # the class on purpose (tripl-l429.12); printing the
            # placeholder reported the largest possible relative move as
            # the smallest (tripl-l429.24, tripl-l429.27).
            # The one deliberate exception is the raw ${percent_delta}
            # template variable, whose documented contract is a bare
            # number; see ``alerts_messages._build_item_template_context``.
            percent_delta = (
                absolute_delta / anomaly.expected_count * 100 if anomaly.expected_count > 0 else 0.0
            )
            details_path, monitoring_path = _build_item_paths(
                project_slug,
                scope_type=anomaly.scope_type,
                scope_ref=anomaly.scope_ref,
                event_id=anomaly.event_id,
                delivery_id=delivery.id,
                correlation_group_id=correlation_by_anomaly.get(id(anomaly)),
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
                    details_path=details_path,
                    monitoring_path=monitoring_path,
                    drift_field=getattr(anomaly, "drift_field", None),
                    drift_type=getattr(anomaly, "drift_type", None),
                    sample_value=getattr(anomaly, "sample_value", None),
                    # Only release regressions carry one (see
                    # signals.py). It is snapshotted here rather than
                    # read back at render time because the source rows
                    # are deleted on every recalculation, so an Inbox
                    # retry would otherwise render an unqualified line.
                    window_from=getattr(anomaly, "window_from", None),
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


# The six columns of ``uq_alert_pending_item_scope``. Spelled out because the
# upsert names them as conflict targets and the model names them as the
# constraint — they have to stay the same list.
_PENDING_ITEM_CONFLICT_KEYS = (
    "destination_id",
    "rule_id",
    "scan_config_id",
    "scope_type",
    "scope_ref",
    "direction",
)


def _buffer_pending_items(
    session: Session,
    config: ScanConfig,
    *,
    rule: AlertRule,
    destination: AlertDestination,
    anomalies: list[AlertMatchCandidate],
    scope_names: dict[tuple[str, str], str],
    correlation_by_anomaly: dict[int, uuid.UUID],
    scan_job_id: uuid.UUID | None,
    metric_state_config_id: uuid.UUID,
    now: datetime,
) -> None:
    """Hold matched signals for this destination's next digest window.

    Upsert, not insert: a scope that keeps firing is re-offered on every
    collection, and each one overwrites its buffered row with the newest
    numbers. That is what makes the digest carry the state of the world at the
    moment it is SENT rather than the moment the incident opened — and it is
    why a scope firing all day still occupies exactly one line.

    Values are snapshotted rather than referenced. ``_recalculate_*`` deletes
    and rewrites the anomaly rows on every collection, so by flush time the row
    this was built from is gone; ``AlertDeliveryItem.window_from`` carries the
    same warning for the same reason.
    """
    dialect = session.bind.dialect.name if session.bind is not None else "postgresql"
    insert = sqlite_insert if dialect == "sqlite" else postgresql_insert

    for anomaly in anomalies:
        group_id = correlation_by_anomaly[id(anomaly)]
        # Mirror AlertRuleState's key exactly: metric scopes are project-global
        # and anchor on the canonical config, everything else on the firing one.
        # Recomputing this at flush time instead would be wrong — the buffered
        # row would then key differently from the rule state that gates it.
        scan_config_id = metric_state_config_id if anomaly.scope_type == SCOPE_METRIC else config.id
        statement = insert(AlertPendingItem).values(
            # UUIDMixin's default is Python-side and does not fire for a Core
            # insert, so the id is supplied here.
            id=uuid.uuid4(),
            project_id=config.project_id,
            destination_id=destination.id,
            rule_id=rule.id,
            scan_config_id=scan_config_id,
            scan_job_id=scan_job_id,
            source_anomaly_id=getattr(anomaly, "id", None),
            scope_type=anomaly.scope_type,
            scope_ref=anomaly.scope_ref,
            scope_name=scope_names[(anomaly.scope_type, anomaly.scope_ref)],
            event_type_id=anomaly.event_type_id,
            event_id=anomaly.event_id,
            bucket=anomaly.bucket,
            direction=anomaly.direction,
            actual_count=anomaly.actual_count,
            expected_count=anomaly.expected_count,
            drift_field=getattr(anomaly, "drift_field", None),
            drift_type=getattr(anomaly, "drift_type", None),
            sample_value=getattr(anomaly, "sample_value", None),
            window_from=getattr(anomaly, "window_from", None),
            correlation_group_id=group_id,
            observation_count=1,
        )
        upserted_group_id = session.execute(
            statement.on_conflict_do_update(
                index_elements=list(_PENDING_ITEM_CONFLICT_KEYS),
                set_={
                    "scan_job_id": statement.excluded.scan_job_id,
                    "source_anomaly_id": statement.excluded.source_anomaly_id,
                    "scope_name": statement.excluded.scope_name,
                    "event_type_id": statement.excluded.event_type_id,
                    "event_id": statement.excluded.event_id,
                    "bucket": statement.excluded.bucket,
                    "actual_count": statement.excluded.actual_count,
                    "expected_count": statement.excluded.expected_count,
                    "drift_field": statement.excluded.drift_field,
                    "drift_type": statement.excluded.drift_type,
                    "sample_value": statement.excluded.sample_value,
                    "window_from": statement.excluded.window_from,
                    # A Core upsert bypasses SQLAlchemy's ``onupdate``, so the
                    # age sweep's column is advanced by hand.
                    "updated_at": now,
                    "observation_count": AlertPendingItem.observation_count + 1,
                },
                # Never let a late collection of an OLDER bucket rewind the
                # numbers a newer one already wrote — the same stance
                # ``last_anomaly_bucket = max(...)`` takes in the send gate.
                where=AlertPendingItem.bucket <= statement.excluded.bucket,
            ).returning(AlertPendingItem.correlation_group_id)
        ).scalar_one_or_none()
        # RETURNING yields nothing when the ``where`` guard above vetoed the
        # update (a late collection of an older bucket), so fall back to the
        # row that is actually there.
        if upserted_group_id is None:
            upserted_group_id = session.execute(
                select(AlertPendingItem.correlation_group_id).where(
                    AlertPendingItem.destination_id == destination.id,
                    AlertPendingItem.rule_id == rule.id,
                    AlertPendingItem.scan_config_id == scan_config_id,
                    AlertPendingItem.scope_type == anomaly.scope_type,
                    AlertPendingItem.scope_ref == anomaly.scope_ref,
                    AlertPendingItem.direction == anomaly.direction,
                )
            ).scalar_one_or_none()

        # Keep the incident's inbox last-seen live while it waits, so an
        # operator can still acknowledge or mute it before the digest ships.
        #
        # Touch the id the ROW ended up carrying, not the one just computed.
        # They differ for a ``metric`` scope on a multi-scan project: the buffer
        # keys on the CANONICAL config while ``_correlation_group_id`` is
        # derived from the FIRING one (dispatch builds ``correlation_by_anomaly``
        # with ``config.id`` for every scope), so the second config's collection
        # would otherwise touch a group the delivered item never references —
        # leaving a stray AlertCorrelationState and an inbox decision the digest
        # cannot honour. Idempotent either way (``last_seen_at = max(...)``).
        if upserted_group_id is not None:
            _touch_correlation_state(
                session,
                project_id=config.project_id,
                correlation_group_id=upserted_group_id,
                seen_at=anomaly.bucket,
            )

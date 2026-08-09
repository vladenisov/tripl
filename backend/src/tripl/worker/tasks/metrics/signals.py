"""Signal-state and "latest active anomalies" helpers.

The pieces collect_metrics consults to decide which anomaly rows are still
visible (i.e. show up as monitoring signals on the UI) live here.

The classification RULE itself does not. It lives in
``tripl.services.monitoring_utils`` and is imported, because the same rule has to
answer for the Anomalies page and for alert dispatch, and while it was two
hand-maintained copies it drifted twice inside one PR — tripl-l429.14 widened
only the display copy's freshness horizon, tripl-l429.19 only its recent branch
— each time making the UI render a signal open while this path acted as though
it were closed. This file used to justify the copies with "the worker must not
import the async request-path services layer"; that was never true of
``monitoring_utils``, which imports no ``tripl`` module at all (pinned by
``test_monitors_summary.test_monitoring_utils_is_a_pure_leaf``), and the worker
already imports ``tripl.services`` from a dozen sibling task modules.

What stays local is what is session- and model-bound and therefore cannot live
in a pure leaf: ``_scan_config_freshness_inputs``, ``_ingestion_settling_delay``
and ``_emission_lag``, which resolve this path's INPUTS to that shared rule.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import (
    SCOPE_DISTRIBUTION_DRIFT,
    SCOPE_RELEASE_REGRESSION,
    SCOPE_VARIABLE_VALUE_DRIFT,
    DistributionDriftAlertCandidate,
    DriftAlertCandidate,
    SchemaDriftAlertCandidate,
    distribution_drift_scope_ref,
)
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_METRIC,
    SCOPE_PROJECT_TOTAL,
    settling_buckets_for,
)
from tripl.metric_grid import metric_grid_stmt, metric_grids
from tripl.metric_monitoring import monitored_metric_criteria
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project_anomaly_settings import (
    DEFAULT_ANOMALY_INGESTION_SETTLING_MINUTES,
    ProjectAnomalySettings,
)
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.models.variable import Variable
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.services.monitoring_utils import (
    classify_signal_state,
    recent_signal_window_from_hours,
    scan_interval_to_timedelta,
)

from ._helpers import SCOPE_SCHEMA_DRIFT
from .urls import _trim_alert_text


def _format_distribution_drift_sample(drift: DistributionDrift) -> str:
    parts = [f"psi={drift.psi:.3f}"]
    top_movers = drift.top_movers or []
    mover_parts: list[str] = []
    for mover in top_movers[:3]:
        value = str(mover.get("value", ""))
        baseline_share = _mover_float(mover.get("baseline_share")) * 100
        current_share = _mover_float(mover.get("current_share")) * 100
        mover_parts.append(f"{value} {baseline_share:.1f}%->{current_share:.1f}%")
    if mover_parts:
        parts.append(", ".join(mover_parts))
    return _trim_alert_text("; ".join(parts)) or ""


def _mover_float(value: object) -> float:
    if isinstance(value, (int, float, str)):
        return float(value)
    return 0.0


def _scan_config_freshness_inputs(
    session: Session,
    scan_config_id: uuid.UUID,
) -> tuple[timedelta | None, timedelta | None]:
    """The scan's interval and the project's configured open-signal window.

    Both are needed together: the latest-scan horizon is
    ``max(window, 3 × interval)``, so resolving the window without the interval
    would drop the floor that keeps a long-interval (daily/weekly) scan's signal
    open. ``None`` for either leaves ``classify_signal_state`` on its default.
    One query per scan, never per signal. Only the display path resolves this —
    alert candidates stay on the fixed window (see ``_get_latest_active_anomalies``).
    """
    row = session.execute(
        select(ScanConfig.interval, ProjectAnomalySettings.recent_signal_window_hours)
        .outerjoin(
            ProjectAnomalySettings,
            ProjectAnomalySettings.project_id == ScanConfig.project_id,
        )
        .where(ScanConfig.id == scan_config_id)
    ).first()
    if row is None:
        return None, None
    interval, hours = row
    return (
        scan_interval_to_timedelta(interval),
        recent_signal_window_from_hours(hours),
    )


def _ingestion_settling_delay(session: Session, project_id: uuid.UUID) -> timedelta:
    """The project's configured ingestion-settling allowance.

    Same value and same fallback as ``tasks._ingestion_settling_delay``, which is
    what the detection run reads. Duplicated rather than imported because
    ``tasks`` imports this module, so the dependency only goes one way.
    """
    minutes = session.execute(
        select(ProjectAnomalySettings.anomaly_ingestion_settling_minutes).where(
            ProjectAnomalySettings.project_id == project_id
        )
    ).scalar()
    if minutes is None:
        return timedelta(minutes=DEFAULT_ANOMALY_INGESTION_SETTLING_MINUTES)
    return timedelta(minutes=int(minutes))


def _emission_lag(interval: timedelta | None, settling_delay: timedelta) -> timedelta:
    """How far behind the metric head the newest EMITTABLE anomaly can sit.

    ``detect_anomalies`` withholds the newest ``settling_buckets`` of the series
    from emission (``anomaly_detector._emission_end``, wired at
    ``tasks.py`` via ``_ingestion_settling_delay``), so a scope that is still
    emitting into the freshest bucket carries its newest possible anomaly exactly
    ``settling_buckets × interval`` behind that bucket. Comparing an anomaly
    against the RAW metric head therefore asks for something the detector is
    forbidden to produce: on the default 120-minute allowance and an hourly grid
    that is two buckets, and the only scopes that could ever satisfy it were ones
    that had gone SILENT, whose metric head stops advancing while the zero-filled
    series keeps producing drops past it. That is visible in production: all 16
    event-scope alert items ever delivered carry actual_count 0.0 (x15) or 1.0,
    and 233 open signals were all state "recent", none "latest_scan".

    Grid arithmetic, which reproduces ``_emission_end`` exactly for the
    zero-filled count series every event scope runs on. A sparse fractional
    series (``fill_gaps=False``) holds its emission head further back than the
    grid says, so there this is a lower bound.
    """
    if interval is None:
        return timedelta(0)
    return settling_buckets_for(interval, settling_delay) * interval


def _get_latest_metric_buckets(
    session: Session,
    scan_config_id: uuid.UUID,
) -> dict[tuple[str, str], datetime]:
    latest_metrics: dict[tuple[str, str], datetime] = {}
    latest_project_total_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
    ).scalar_one_or_none()
    if latest_project_total_bucket is not None:
        latest_metrics[(SCOPE_PROJECT_TOTAL, str(scan_config_id))] = latest_project_total_bucket

    for event_type_id, bucket in session.execute(
        select(EventMetric.event_type_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
        .group_by(EventMetric.event_type_id)
    ).all():
        if event_type_id is not None:
            latest_metrics[(SCOPE_EVENT_TYPE, str(event_type_id))] = bucket

    for event_id, bucket in session.execute(
        select(EventMetric.event_id, sa_func.max(EventMetric.bucket))
        .join(Event, EventMetric.event_id == Event.id)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
            Event.status != "archived",
        )
        .group_by(EventMetric.event_id)
    ).all():
        if event_id is not None:
            latest_metrics[(SCOPE_EVENT, str(event_id))] = bucket

    return latest_metrics


def _get_visible_signal_scope_keys(
    session: Session,
    scan_config_id: uuid.UUID,
) -> set[tuple[str, str]]:
    """Open signals of ONE scan config, as the run summary's delta counts them.

    ``tasks.collect_metrics`` takes this set before and after a run and reports
    the difference as ``signals_added`` / ``signals_removed``. That answers "what
    did THIS RUN change", which is deliberately a different question from "what
    is open in the project" — the one the Anomalies page answers. Two
    consequences, stated here so the next reader does not re-file them:

    * catalog-``metric`` signals are project-global (NULL ``scan_config_id``) and
      are never counted. A run belongs to one scan config, so folding a
      project-wide metric signal in would re-report the same signal on every
      scan's card in the project;
    * an outage announced in an EARLIER run stays open on the Anomalies page
      indefinitely — ``monitoring_utils._outage_is_still_running`` re-checks the
      anchor against the series rather than ageing it out — while it leaves this
      set once its bucket passes the freshness horizon. It is not new in this run
      either way, so ``signals_added`` is unaffected; only ``signals_removed``
      can name a scope the page still lists.

      This is now the ONE place the two signal paths deliberately answer
      differently: ``_get_latest_active_anomalies`` runs the re-check, because
      closing an alert on a running outage is wrong, and this set does not,
      because a run summary reporting "0 signals removed" for a run that removed
      nothing is right. Passing the re-check's arguments here would make
      ``signals_removed`` stop naming a scope whose signal the page still lists,
      which is the opposite of what this docstring promises above. Pinned by
      ``test_metrics_tasks.test_an_aged_ongoing_outage_leaves_the_run_delta_but_not_alerting``
      so the next person to "unify" the two has to read this paragraph first.

    Within its own scan's event scopes it classifies by exactly the page's rule,
    interval floor included — literally the same function, since it calls
    ``monitoring_utils.classify_signal_state`` with the same arguments the API
    passes rather than a copy that has to be kept in step.
    """
    latest_metrics = _get_latest_metric_buckets(session, scan_config_id)
    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .outerjoin(Event, MetricAnomaly.event_id == Event.id)
        .where(
            MetricAnomaly.scan_config_id == scan_config_id,
            (MetricAnomaly.event_id.is_(None)) | (Event.status != "archived"),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    interval, recent_window = _scan_config_freshness_inputs(session, scan_config_id)
    # No emission lag here on purpose: this is the DISPLAY set, it keeps either
    # state, and the API renders the same signals through
    # ``services.monitoring_utils.classify_signal_state``, which has no notion of
    # the allowance. Feeding one side a settled head would only move signals
    # between "latest_scan" and "recent" and split the two counts apart.
    return {
        key
        for key, anomaly in latest_anomalies.items()
        if classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
            interval=interval,
            recent_window=recent_window,
        )
        is not None
    }


def _get_latest_active_anomalies(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], MetricAnomaly]:
    latest_metrics = _get_latest_metric_buckets(session, config.id)
    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .outerjoin(Event, MetricAnomaly.event_id == Event.id)
        .where(
            MetricAnomaly.scan_config_id == config.id,
            (MetricAnomaly.event_id.is_(None)) | (Event.status != "archived"),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    interval = scan_interval_to_timedelta(config.interval)
    emission_lag = _emission_lag(interval, _ingestion_settling_delay(session, config.project_id))
    # The scan's liveness probe, for the outage re-check below. The newest bucket
    # ANY scope of this config has stored — the same quantity
    # ``monitoring_utils.latest_bucket_by_scan`` computes for the display path,
    # taken from rows already in hand, so this costs no extra query.
    scan_latest_bucket = max(latest_metrics.values(), default=None)
    # Deliberately NOT narrowed by the project's open-signal window: this feeds
    # alert dispatch, which closes AlertRuleState rows for scopes that drop out.
    # Honouring a shortened window here would let a presentation setting close
    # alert state and re-trigger the same alert past its cooldown.
    #
    # The outage re-check IS honoured, and used not to be. These scopes are
    # exactly the population it is defined for — count-shaped and scan-backed —
    # and an outage is announced once, at onset, and never re-emitted, so ageing
    # that single row out closed the alert state of an incident that was still
    # running. The Anomalies page, the badge, the list and the drilldown all kept
    # rendering it open (they have run this re-check since tripl-l429.20), so at
    # ``max(24h, 3 x interval)`` into a live outage the monitor read healthy while
    # the page read down, and ``_reopen_closed_incidents`` cleared the operator's
    # inbox acknowledgement mid-incident.
    #
    # In STEADY STATE this sends strictly fewer messages, not more: a collapsed
    # outage anchor's bucket never advances, so the still-active branch
    # (``dispatch``: ``anomaly.bucket > last_anomaly_bucket``) cannot re-fire, and
    # staying open REMOVES the reactivation branch that a spurious close would
    # otherwise have opened. There is one ONE-OFF exception, on the first
    # dispatch run after this ships: a scope whose state had ALREADY wrongly
    # closed re-enters as a candidate, takes the reactivation branch, and — if its
    # ``last_notified_at`` is older than the rule's ``cooldown_minutes`` (default
    # 1440) — sends once. That is one message per scope that is genuinely still
    # down and whose monitor had gone quiet on it, and it does not repeat.
    #
    # The cap still holds: once the scan itself stops collecting,
    # ``scan_latest_bucket`` goes stale, ``_outage_is_still_running`` returns
    # False and the state closes exactly as before (tripl-l429.26).
    return {
        key: anomaly
        for key, anomaly in latest_anomalies.items()
        if classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
            interval=interval,
            emission_lag=emission_lag,
            anomaly_actual_count=anomaly.actual_count,
            scan_latest_bucket=scan_latest_bucket,
        )
        == "latest_scan"
    }


def _get_active_metric_anomaly_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], MetricAnomaly]:
    """Latest active ``metric``-scope anomaly per MONITORED catalog metric.

    Monitored is ``active`` AND ``anomaly_detection_enabled``
    (``tripl.metric_monitoring``) — the same predicate detection scores on. This
    pass used to require only the flag, which made it WIDER than its own
    producer: an archived metric stops collecting but keeps its stored anomalies,
    so its frozen last anomaly stayed on the settled head and remained a live
    alert candidate — able to newly fire a Telegram/Slack message about a metric
    the user had just archived — until the wall-clock horizon closed it up to
    three weeks later on a weekly grid (tripl-l429.25).

    Catalog metric anomalies are project-global (NULL ``scan_config_id``), so —
    unlike event scopes — they are not picked up by the config-partitioned
    ``_get_latest_active_anomalies``. We load them here keyed by their metric
    definition, classify against the settled head of the latest stored value
    bucket, and keep only the ones whose newest anomaly is on the latest scan
    (an open signal).

    Each metric is measured on its OWN grid, so the settled head is computed per
    metric: the same 120-minute allowance withholds two buckets of an hourly
    metric and a whole bucket of a daily one.

    That grid is the METRIC's, never the caller's. This pass runs once per scan
    config while the anomalies it judges are project-global and share ONE
    ``AlertRuleState`` row, so substituting ``config.interval`` for an
    interval-less ``event_composition`` metric made the same metric a candidate
    under one scan and not under another — the two dispatch runs then opened and
    closed the same alert state in turn (tripl-l429.22).
    """
    metric_grids_by_ref = {
        str(metric_id): grid
        for metric_id, grid in metric_grids(
            session.execute(
                metric_grid_stmt(
                    MetricDefinition.project_id == config.project_id,
                    *monitored_metric_criteria(),
                )
            ).all()
        ).items()
    }
    scope_refs = list(metric_grids_by_ref)
    if not scope_refs:
        return {}

    metric_ids = [uuid.UUID(ref) for ref in scope_refs]
    latest_value_buckets: dict[str, datetime] = {
        str(metric_definition_id): bucket
        for metric_definition_id, bucket in session.execute(
            select(MetricValue.metric_definition_id, sa_func.max(MetricValue.bucket))
            .where(MetricValue.metric_definition_id.in_(metric_ids))
            .group_by(MetricValue.metric_definition_id)
        ).all()
    }

    latest_anomalies: dict[str, MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .where(
            MetricAnomaly.scope_type == SCOPE_METRIC,
            MetricAnomaly.scope_ref.in_(scope_refs),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        latest_anomalies.setdefault(anomaly.scope_ref, anomaly)

    settling_delay = _ingestion_settling_delay(session, config.project_id)
    intervals = {
        scope_ref: scan_interval_to_timedelta(grid.interval)
        for scope_ref, grid in metric_grids_by_ref.items()
    }
    # See _get_latest_active_anomalies: alert candidates stay on the fixed
    # window so the presentation setting cannot close alert state.
    #
    # No outage re-check here, unlike _get_latest_active_anomalies: a catalog
    # metric has no scan to prove its collector is alive, and a fractional
    # series' 0.0 is a value rather than silence, so passing the two arguments
    # would pin a ratio metric's legitimate zero open forever and alert on it.
    return {
        (SCOPE_METRIC, scope_ref): anomaly
        for scope_ref, anomaly in latest_anomalies.items()
        if classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_value_buckets.get(scope_ref),
            interval=intervals.get(scope_ref),
            emission_lag=_emission_lag(intervals.get(scope_ref), settling_delay),
        )
        == "latest_scan"
    }


def _get_active_schema_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], SchemaDriftAlertCandidate]:
    retention_cutoff = datetime.now(UTC) - timedelta(days=30)
    candidates: dict[tuple[str, str], SchemaDriftAlertCandidate] = {}
    for drift in session.execute(
        select(SchemaDrift)
        .join(EventType, EventType.id == SchemaDrift.event_type_id)
        .where(
            EventType.project_id == config.project_id,
            SchemaDrift.scan_config_id == config.id,
            SchemaDrift.detected_at >= retention_cutoff,
            SchemaDrift.status.in_(("open", "snoozed")),
            (SchemaDrift.status != "snoozed")
            | (SchemaDrift.snoozed_until.is_(None))
            | (SchemaDrift.snoozed_until <= datetime.now(UTC)),
        )
        .order_by(SchemaDrift.detected_at.desc())
    ).scalars():
        scope_ref = str(drift.id)
        candidate = SchemaDriftAlertCandidate(
            id=drift.id,
            scan_config_id=config.id,
            scope_type=SCOPE_SCHEMA_DRIFT,
            scope_ref=scope_ref,
            event_id=None,
            event_type_id=drift.event_type_id,
            bucket=drift.detected_at,
            direction="spike",
            actual_count=1,
            expected_count=0.0,
            drift_field=drift.field_name,
            drift_type=drift.drift_type,
            sample_value=_trim_alert_text(drift.sample_value),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates


def _get_active_variable_value_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DriftAlertCandidate]:
    """Turn open/snooze-expired variable value drifts into alert candidates.

    Rides the shared drift fields: variable display name -> drift_field,
    "value_drift" -> drift_type, sampled novel values -> sample_value. The
    per-event anchor flows through ``event_id`` so event filters apply.
    """
    retention_cutoff = datetime.now(UTC) - timedelta(days=30)
    candidates: dict[tuple[str, str], DriftAlertCandidate] = {}
    for drift, variable_name in session.execute(
        select(VariableValueDrift, Variable.name)
        .join(Variable, Variable.id == VariableValueDrift.variable_id)
        .where(
            VariableValueDrift.project_id == config.project_id,
            VariableValueDrift.scan_config_id == config.id,
            VariableValueDrift.detected_at >= retention_cutoff,
            VariableValueDrift.status.in_(("open", "snoozed")),
            (VariableValueDrift.status != "snoozed")
            | (VariableValueDrift.snoozed_until.is_(None))
            | (VariableValueDrift.snoozed_until <= datetime.now(UTC)),
        )
        .order_by(VariableValueDrift.detected_at.desc())
    ).all():
        scope_ref = str(drift.id)
        candidate = DriftAlertCandidate(
            id=drift.id,
            scan_config_id=config.id,
            scope_type=SCOPE_VARIABLE_VALUE_DRIFT,
            scope_ref=scope_ref,
            event_id=drift.event_id,
            event_type_id=None,
            bucket=drift.detected_at,
            direction="spike",
            actual_count=float(len(drift.observed_values or [])),
            expected_count=0.0,
            drift_field=variable_name,
            drift_type="value_drift",
            sample_value=_trim_alert_text(", ".join(drift.observed_values or [])),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates


def _get_active_release_regression_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DriftAlertCandidate]:
    """Turn the scan's current ReleaseRegression rows into alert candidates.

    The recalculation step keeps only the latest release's regressions, so every
    row here is current. Version context rides on the shared drift fields
    (version -> drift_field, kind -> drift_type, previous release -> sample_value)
    so it flows through the existing delivery-item and message machinery.
    Naturally inert: no rows exist when the scan has no version column.
    """
    if not config.app_version_column:
        return {}
    candidates: dict[tuple[str, str], DriftAlertCandidate] = {}
    for regression in session.execute(
        select(ReleaseRegression)
        .where(ReleaseRegression.scan_config_id == config.id)
        .order_by(ReleaseRegression.scope_ref)
    ).scalars():
        candidate = DriftAlertCandidate(
            id=regression.id,
            scan_config_id=regression.scan_config_id,
            scope_type=SCOPE_RELEASE_REGRESSION,
            scope_ref=regression.scope_ref,
            event_id=regression.event_id,
            event_type_id=regression.event_type_id,
            bucket=regression.window_to,
            direction="drop",
            actual_count=regression.observed_count,
            expected_count=regression.expected_count,
            drift_field=regression.version,
            drift_type=regression.kind,
            sample_value=regression.previous_version,
            # ``bucket`` above is window_to. Carrying the other end too is what
            # lets the alert name the rollout-overlap window it measured, so
            # ``expected`` cannot be read as a raw count over the chart's range.
            window_from=regression.window_from,
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates


def _get_active_distribution_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DistributionDriftAlertCandidate]:
    latest_bucket = session.execute(
        select(sa_func.max(DistributionDrift.bucket)).where(
            DistributionDrift.scan_config_id == config.id,
        )
    ).scalar_one_or_none()
    if latest_bucket is None:
        return {}

    candidates: dict[tuple[str, str], DistributionDriftAlertCandidate] = {}
    for drift in session.execute(
        select(DistributionDrift)
        .where(
            DistributionDrift.scan_config_id == config.id,
            DistributionDrift.bucket == latest_bucket,
            DistributionDrift.band == "significant",
        )
        .order_by(DistributionDrift.field_name)
    ).scalars():
        owner_id = drift.event_type_id or drift.scan_config_id
        scope_ref = distribution_drift_scope_ref(owner_id, drift.field_name)
        candidate = DistributionDriftAlertCandidate(
            id=drift.id,
            scan_config_id=drift.scan_config_id,
            scope_type=SCOPE_DISTRIBUTION_DRIFT,
            scope_ref=scope_ref,
            event_id=None,
            event_type_id=drift.event_type_id,
            bucket=drift.bucket,
            direction="spike",
            actual_count=drift.current_total,
            expected_count=float(drift.baseline_total),
            drift_field=drift.field_name,
            drift_type="distribution_shift",
            sample_value=_format_distribution_drift_sample(drift),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates

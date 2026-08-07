"""URL builders + small text helpers used by alert payloads."""

from __future__ import annotations

import uuid
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import (
    SCOPE_DISTRIBUTION_DRIFT,
    SCOPE_METRIC,
    SCOPE_RELEASE_REGRESSION,
    SCOPE_VARIABLE_VALUE_DRIFT,
)
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.project import Project
from tripl.services import app_settings_service

from ._helpers import SCOPE_SCHEMA_DRIFT

# Scopes that describe a slice of a scan rather than one catalog entity, so no
# entity-level monitoring page can show them. This is the backend half of a
# decision the frontend already made: ``getMonitoringPath``
# (frontend/src/lib/monitoring.ts) THROWS for exactly these rather than fall
# through to the event route, because "routing them to the event URL (the
# previous silent default) mis-renders an unrelated event".
#
# The fallthrough below used to be that silent default. For a release
# regression it emitted the event's own monitoring page, which charts ALL
# versions over the chart's own range against the seasonal baseline — a
# different numerator, denominator, window AND estimator than the alert's
# release-cohort comparison, so it cannot corroborate the alert even in
# principle. For an event-TYPE-scoped release regression it was worse: the
# scope_ref is an event_type_id, so the fallthrough emitted
# ``/monitoring/event/{event_type_id}`` — a valid-looking URL for a page that
# does not exist. Same reasoning already killed the sparkline on these items.
_SCOPES_WITHOUT_MONITORING_PAGE = frozenset(
    {
        SCOPE_SCHEMA_DRIFT,
        SCOPE_DISTRIBUTION_DRIFT,
        SCOPE_RELEASE_REGRESSION,
        SCOPE_VARIABLE_VALUE_DRIFT,
    }
)

# ...and of those, the one with nowhere else to go at all.
#
# The audit row renders a fixed 8 columns — Grp / Scope / Direction / Actual /
# Expected / Abs delta / % delta / Link (frontend AlertDeliveryRow.tsx) — and
# ``drift_field`` and ``sample_value`` are not among them. For a drift scope
# those two fields ARE the finding, so the audit row shows a reader strictly
# LESS than the message that brought them there. It is only an upgrade for
# release regression, whose actual/expected/% delta exist nowhere else.
#
# Hence the rule, which is a last resort rather than a default: link an item
# to the audit row only when NO page shows more than the message does.
#
# ``variable_value_drift`` was briefly in this set and should not have been: its
# ``event_id`` is NOT NULL, and /monitoring/event/{event_id} mounts
# EventValueDriftPanel, which names the variable, lists every observed value
# (not the truncation the message sends) and can resolve the drift. ``schema``
# and ``distribution`` stay out for the first reason above; they carry a NULL
# ``event_id``, so they simply get no link, which at least does not mislead.
_SCOPES_LINKED_TO_ALERT_AUDIT = frozenset({SCOPE_RELEASE_REGRESSION})


def _build_monitoring_url(
    project_slug: str,
    *,
    scope_type: str,
    scope_ref: str,
) -> str | None:
    app_base_url = app_settings_service.get_runtime_config_sync().app_base_url
    if not app_base_url:
        return None
    base = app_base_url.rstrip("/")
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"{base}/p/{project_slug}/monitoring/project-total/{scope_ref}"
    if scope_type == SCOPE_EVENT_TYPE:
        return f"{base}/p/{project_slug}/monitoring/event-type/{scope_ref}"
    if scope_type == SCOPE_METRIC:
        # Catalog-metric anomalies carry scope_ref = metric_definition_id, and
        # the metric drilldown is its own route. The fallthrough used to send
        # them to /monitoring/event/{metric_definition_id} — same defect class
        # as the release-regression link, just a quieter one.
        return f"{base}/p/{project_slug}/monitoring/metric/{scope_ref}"
    if scope_type == SCOPE_EVENT:
        return f"{base}/p/{project_slug}/monitoring/event/{scope_ref}"
    # Every scope is now named, including the ones that get None. An unknown
    # scope gets no link rather than a guessed one: this function's whole
    # history of defects is a fallthrough emitting a plausible URL for a page
    # that shows something else.
    return None


def _build_event_details_url(project_slug: str, event_id: uuid.UUID | None) -> str | None:
    app_base_url = app_settings_service.get_runtime_config_sync().app_base_url
    if not app_base_url or event_id is None:
        return None
    base = app_base_url.rstrip("/")
    return f"{base}/p/{project_slug}/monitoring/event/{event_id}"


# Query parameter naming the ONE item inside a delivery that a given message
# line was printed for. A query param rather than a fragment because that is the
# convention this frontend already uses for cross-page focus state — branch
# context, saved views, the events route state and the metrics catalog all ride
# ``useSearchParams``, and nothing in the app reads ``location.hash``.
ALERT_AUDIT_ITEM_PARAM = "item"


def _alert_audit_item_anchor(scope_type: str, scope_ref: str) -> str:
    """Identity of one item within a delivery, as a URL query value.

    ``scope_ref`` alone is NOT an identity, even inside a single delivery: a
    release regression's scope_ref IS its event id, and one rule can carry both
    ``include_events`` and ``include_release_regressions``, so the event-scoped
    item and the regression arrive together holding the same ref. The pair
    ``(scope_type, scope_ref)`` is unique by construction — it is the key
    ``_prepare_alert_deliveries`` dedupes candidates on, and the partition
    cooldown is applied over.

    The pair is also what the frozen ``payload_snapshot`` stores, so the anchor
    stays resolvable against the audit record itself, which a row primary key
    (not present in the snapshot, and not yet minted when the URL is built)
    would not be.

    ``scope_type`` is a DB enum and can never contain ``:``, so the separator is
    unambiguous however free-form the ref gets; the value is percent-encoded
    because ``AlertDeliveryItem.scope_ref`` is a plain ``String(64)`` and the
    drift scopes key theirs on a field name.
    """
    return quote(f"{scope_type}:{scope_ref}", safe=":")


def _build_alert_audit_url(
    project_slug: str,
    delivery_id: uuid.UUID | None,
    *,
    scope_type: str,
    scope_ref: str,
) -> str | None:
    """Deep link to one ITEM of one delivery's own audit row.

    The only surface that can show a release regression's ``actual`` /
    ``expected`` / ``% delta`` for one scope is the delivery that carried them:
    they are read back from the frozen delivery record, so the page can never
    disagree with the message a reader is holding, and it never goes stale.
    The monitoring panel cannot do that job — its rows are deleted and
    recomputed on every scan, so they only ever describe the CURRENT latest
    release.

    The delivery alone is not the destination, though. ``_delivery_chunks``
    packs up to ``_MAX_ITEMS_PER_DELIVERY`` (8, telegram) items into one
    delivery, so a delivery-keyed URL made every line of an 8-scope message
    byte-identical: clicking the sixth opened a row expanded over 8 siblings
    with nothing marking the one the message quoted. The production alert that
    prompted this link carried a single item, which is why it looked right.
    """
    app_base_url = app_settings_service.get_runtime_config_sync().app_base_url
    if not app_base_url or delivery_id is None:
        return None
    base = app_base_url.rstrip("/")
    anchor = _alert_audit_item_anchor(scope_type, scope_ref)
    return (
        f"{base}/p/{project_slug}/settings/alerting/{delivery_id}?{ALERT_AUDIT_ITEM_PARAM}={anchor}"
    )


def _build_item_paths(
    project_slug: str,
    *,
    scope_type: str,
    scope_ref: str,
    event_id: uuid.UUID | None,
    delivery_id: uuid.UUID | None,
) -> tuple[str | None, str | None]:
    """``(details_path, monitoring_path)`` for one alert item.

    One choke point so the two builders can never be applied to a scope they
    were not written for. ``_build_event_details_url`` in particular takes no
    scope_type at all and fired for anything with a non-null ``event_id`` —
    which for an event-scoped release regression meant the event page, the one
    page guaranteed to contradict the alert.
    """
    if scope_type in _SCOPES_LINKED_TO_ALERT_AUDIT:
        # ``details`` rather than ``monitoring``: the destination is this
        # alert's own detail, not a monitoring page. Leaving monitoring_path
        # empty also keeps the message to one link.
        return (
            _build_alert_audit_url(
                project_slug,
                delivery_id,
                scope_type=scope_type,
                scope_ref=scope_ref,
            ),
            None,
        )
    return (
        _build_event_details_url(project_slug, event_id),
        _build_monitoring_url(project_slug, scope_type=scope_type, scope_ref=scope_ref),
    )


def _get_project_slug(session: Session, project_id: uuid.UUID) -> str:
    slug = session.execute(
        select(Project.slug).where(Project.id == project_id)
    ).scalar_one_or_none()
    if slug is None:
        msg = f"Project {project_id} not found"
        raise ValueError(msg)
    return slug


def _trim_alert_text(value: str | None, *, max_length: int = 500) -> str | None:
    if value is None or len(value) <= max_length:
        return value
    return value[: max_length - 3] + "..."

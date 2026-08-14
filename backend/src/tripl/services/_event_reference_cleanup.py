"""Clear the references to an event that is being deleted outright.

The sibling of ``core.analyzers._event_generator_merge_refs``. A group-rule
MERGE has a survivor and re-points every reference onto it; a DELETE has none,
so the same references are dropped instead. The two share their list mechanics
through ``core.event_references`` so one rule cannot become two.

Neither refusing nor cascading was right here. The house precedent is
``disable_rules_bound_to_scan``: when the thing a dependent row was aimed at
disappears, make the dependent inert and VISIBLE — do not refuse the delete
(none of these breaks a running mechanism the way a missing name-format column
does) and do not CASCADE it away (that would take an alert rule's whole delivery
history with it).

**The heaviest item here is not one of the four the issue named.**
``metric_anomalies.event_id`` and ``metric_breakdown_anomalies.event_id`` are
``ondelete="SET NULL"``, not CASCADE, so a deleted event leaves its anomalies
behind with a NULL ``event_id`` — and both gates that would have contained them
read NULL as "allow": the signal query keeps a row whose joined event is NULL, so
that project- and metric-scope rows are not dropped, and
``filter_matches_anomaly`` returns ``True`` when the actual value is None, so the
orphan satisfies EVERY event filter. Archiving an event suppresses its alerts;
deleting one used to UN-suppress them, straight past the filters written to scope
them. They are deleted here by both keys, the way the merge path already does.

``release_regressions`` has the identical shape and is here for the identical
reason, though its own per-scan recompute makes the exposure a window rather
than a permanent state.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.event_references import drop_preserving_order, plan_alert_filter_change
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.anomaly_scope_override import AnomalyScopeOverride
from tripl.models.chart_annotation import ChartAnnotation
from tripl.models.domain_enums import (
    AlertRuleFilterField,
    ChartAnnotationScopeType,
    MetricScopeType,
)
from tripl.models.implementation_ticket import ImplementationTicket
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.release_regression import ReleaseRegression
from tripl.services._alerting_destinations import clear_rule_states

__all__ = ["DELETE_PATH_COLUMNS", "drop_dangling_event_references"]

# Exactly the (table, column) pairs this module touches. The FK ledger asserts
# against it, so a reference that gains a delete-path policy here cannot keep a
# merge-only reason over there.
DELETE_PATH_COLUMNS: frozenset[tuple[str, str]] = frozenset(
    {
        ("metric_anomalies", "event_id"),
        ("metric_anomalies", "scope_ref"),
        ("metric_breakdown_anomalies", "event_id"),
        ("metric_breakdown_anomalies", "scope_ref"),
        ("release_regressions", "event_id"),
        ("release_regressions", "scope_ref"),
        ("anomaly_scope_overrides", "scope_ref"),
        ("alert_rule_filters", "values"),
        ("chart_annotations", "scope_ref"),
        ("implementation_tickets", "event_ids"),
    }
)

_TICKET_STATUS_OPEN = "open"


async def drop_dangling_event_references(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    event_ids: Sequence[uuid.UUID],
) -> None:
    """Remove every reference to *event_ids* that would outlive the rows.

    Call BEFORE the delete, while the events still exist. Nothing here reads
    them, but going first keeps the whole cleanup inside the caller's single
    transaction rather than depending on flush order. Adds no commit of its own:
    both callers already have exactly one.
    """
    if not event_ids:
        return
    dead_ids = list(event_ids)
    dead_refs = {str(event_id) for event_id in dead_ids}

    await _delete_orphan_detections(session, dead_ids=dead_ids, dead_refs=dead_refs)
    await _delete_scope_overrides(session, project_id=project_id, dead_refs=dead_refs)
    await _delete_chart_annotations(session, project_id=project_id, dead_refs=dead_refs)
    await _apply_alert_filter_changes(session, project_id=project_id, dead_refs=dead_refs)
    await _drop_ticket_event_ids(session, project_id=project_id, dead_refs=dead_refs)


async def _delete_orphan_detections(
    session: AsyncSession, *, dead_ids: list[uuid.UUID], dead_refs: set[str]
) -> None:
    """Delete every detection row about a deleted event, by BOTH keys.

    Two keys because there is no foreign key on ``scope_ref`` — it is a plain
    string — which is also why ``_delete_event_anomalies`` deletes twice on the
    merge path. Doing it in Python rather than changing the FK to CASCADE is
    deliberate: a CASCADE could only ever reach the ``event_id`` half, leaving
    two mechanisms for one rule and the string half still stranded.

    Deleting rather than re-pointing is forced by there being nowhere to point:
    the row described a stream that no longer exists. Losing them costs nothing
    — detection rescores from the metric series, and that went with the event.

    ``release_regressions`` is here for the same reason as the two anomaly
    tables and was nearly missed, because its own recompute looks like a fix: it
    is wiped and rebuilt per scan config on every collection, so an orphan
    clears itself eventually. But "eventually" is one scan interval, and inside
    that window ``signals`` lifts the orphan into a drift candidate whose
    matcher is a bare ``all(filter_matches_anomaly(...))`` — so a NULL
    ``event_id`` satisfies every event filter, including one written to exclude
    exactly that event. Self-healing is not the same as harmless.
    """
    scope = MetricScopeType.event.value
    await session.execute(
        delete(MetricAnomaly)
        .where(
            MetricAnomaly.scope_type == scope,
            or_(
                MetricAnomaly.event_id.in_(dead_ids),
                MetricAnomaly.scope_ref.in_(dead_refs),
            ),
        )
        .execution_options(synchronize_session=False)
    )
    await session.execute(
        delete(MetricBreakdownAnomaly)
        .where(
            MetricBreakdownAnomaly.scope_type == scope,
            or_(
                MetricBreakdownAnomaly.event_id.in_(dead_ids),
                MetricBreakdownAnomaly.scope_ref.in_(dead_refs),
            ),
        )
        .execution_options(synchronize_session=False)
    )
    await session.execute(
        delete(ReleaseRegression)
        .where(
            ReleaseRegression.scope_type == scope,
            or_(
                ReleaseRegression.event_id.in_(dead_ids),
                ReleaseRegression.scope_ref.in_(dead_refs),
            ),
        )
        .execution_options(synchronize_session=False)
    )


async def _delete_scope_overrides(
    session: AsyncSession, *, project_id: uuid.UUID, dead_refs: set[str]
) -> None:
    """Drop the false-positive ratchet for a scope that no longer exists.

    The merge folds this onto the survivor; a delete has none, and the model is
    explicit that deleting the row IS the undo. Leaving it would strand a tuned
    threshold in Detection settings, naming an event nobody can open.

    Scoped to ``event`` because ``scope_ref`` is polymorphic across seven scope
    types: a metric- or event-type-scoped row whose ref happened to collide must
    never be touched.
    """
    await session.execute(
        delete(AnomalyScopeOverride)
        .where(
            AnomalyScopeOverride.project_id == project_id,
            AnomalyScopeOverride.scope_type == MetricScopeType.event.value,
            AnomalyScopeOverride.scope_ref.in_(dead_refs),
        )
        .execution_options(synchronize_session=False)
    )


async def _delete_chart_annotations(
    session: AsyncSession, *, project_id: uuid.UUID, dead_refs: set[str]
) -> None:
    """Drop event-scoped markers whose chart is gone.

    Promoting them to project-wide markers was rejected: that would paint a
    deleted event's annotation onto every chart in the project. With no event
    there is no chart to draw it on, and the reader can never select it again.
    """
    await session.execute(
        delete(ChartAnnotation)
        .where(
            ChartAnnotation.project_id == project_id,
            ChartAnnotation.scope_type == ChartAnnotationScopeType.event.value,
            ChartAnnotation.scope_ref.in_(dead_refs),
        )
        .execution_options(synchronize_session=False)
    )


async def _apply_alert_filter_changes(
    session: AsyncSession, *, project_id: uuid.UUID, dead_refs: set[str]
) -> None:
    """Rewrite, or retire, the alert filters that named a deleted event.

    The decision lives in ``core.event_references.plan_alert_filter_change``;
    this only carries it out. The emptied-inclusive case additionally disables
    the rule and clears its incident states, matching
    ``disable_rules_bound_to_scan``: an orphaned rule should be inert and visibly
    off, never silently re-aimed at everything.

    Filters are read and matched in Python rather than with a JSON containment
    query because that operator is PostgreSQL-only and the suite runs on SQLite —
    a portable predicate is what makes this testable at all.

    Scoped to the project through the rule's destination. A uuid match is
    globally unique so an unscoped read would be *correct*, but it would also
    read every event filter in the instance on every single event delete, while
    the four helpers around it are all project-bounded.
    """
    rows = (
        (
            await session.execute(
                select(AlertRuleFilter)
                .join(AlertRule, AlertRuleFilter.rule_id == AlertRule.id)
                .join(AlertDestination, AlertRule.destination_id == AlertDestination.id)
                .where(
                    AlertDestination.project_id == project_id,
                    AlertRuleFilter.field == AlertRuleFilterField.event.value,
                )
            )
        )
        .scalars()
        .all()
    )

    disable_rule_ids: list[uuid.UUID] = []
    for row in rows:
        change = plan_alert_filter_change(
            operator=row.operator, values=row.values or [], removed=dead_refs
        )
        if change is None:
            continue
        if not change.delete_filter:
            row.values = change.remaining
            continue
        if change.disable_rule:
            disable_rule_ids.append(row.rule_id)
        await session.delete(row)

    if not disable_rule_ids:
        return
    for rule in (
        (await session.execute(select(AlertRule).where(AlertRule.id.in_(disable_rule_ids))))
        .scalars()
        .all()
    ):
        rule.enabled = False
    await session.flush()
    await clear_rule_states(session, disable_rule_ids)


async def _drop_ticket_event_ids(
    session: AsyncSession, *, project_id: uuid.UUID, dead_refs: set[str]
) -> None:
    """Drop deleted events from OPEN delivery tickets.

    Inert either way on this path — both steps of the ticket sync already drop
    ids that resolve to nothing — but dropped so the two paths state one rule
    rather than one rule and an exception. Closed tickets record what shipped and
    are never rewritten.
    """
    for ticket in (
        (
            await session.execute(
                select(ImplementationTicket).where(
                    ImplementationTicket.project_id == project_id,
                    ImplementationTicket.status == _TICKET_STATUS_OPEN,
                )
            )
        )
        .scalars()
        .all()
    ):
        event_ids = [str(value) for value in (ticket.event_ids or [])]
        if not dead_refs.intersection(event_ids):
            continue
        ticket.event_ids = drop_preserving_order(event_ids, dead_refs)

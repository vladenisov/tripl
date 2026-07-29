"""Scan columns that are metric dimensions or identity, not tracked event fields.

Lives here rather than in ``worker.tasks.metrics.tasks`` because the scan task
needs it too, and importing the metrics task module for one pure helper would
couple two Celery entry points for no reason.
"""

from __future__ import annotations

from collections.abc import Mapping

from tripl.models.scan_config import ScanConfig


def _event_group_rule_columns(config: ScanConfig) -> set[str]:
    """Columns the scan's event group rules match on.

    A group rule decides WHICH catalog event a row folds into, so the columns it
    reads are identity inputs — exactly like ``event_type_column`` — not tracked
    properties of the resulting event. They were missing from the reserved set,
    which is the second grouping column the catalog sync never knew about: it
    auto-created a FieldDefinition for the rule's column on every event type,
    and the scan then captured a sample value for it. On the demo that produced
    a "Screen View" field literally rendering the rule's own pattern,
    ``/^Home\\ Screen\\ View$/`` (tripl-jfm3.57).

    Read defensively: ``event_group_rules`` is a JSON column, so a row written
    by an older release (or by hand) may not match the current shape.
    """
    columns: set[str] = set()
    for rule in config.event_group_rules or ():
        if not isinstance(rule, Mapping):
            continue
        conditions = rule.get("conditions")
        if not isinstance(conditions, list):
            continue
        for condition in conditions:
            if not isinstance(condition, Mapping):
                continue
            field = str(condition.get("field", "")).strip()
            if field:
                columns.add(field)
    return columns


def reserved_catalog_columns(config: ScanConfig) -> set[str]:
    """Scan columns that are metric dimensions or identity, not tracked event fields.

    The event-type/time grouping columns and the app-version & platform breakdown
    columns are collected into metric tables (EventMetric / EventMetricBreakdown),
    never the catalog. Excluding them from FieldDefinition creation keeps them off
    the events table, where they'd otherwise show up as useless columns carrying
    non-deterministic per-event sample values. Event-group-rule columns join them
    for the same reason — see ``_event_group_rule_columns``.

    Two consumers, both catalog-facing:

    * ``catalog_sync`` takes it as ``skip_columns`` (no FieldDefinition is created)
    * ``generate_events`` takes it as ``reserved_columns`` and stays quiet about a
      reserved column having no FieldDefinition — of course it has none, that is
      this function's doing, and reporting it as a plan gap sent a fresh demo's
      very first scan out with six of seven detail lines wrong (tripl-jfm3.90)

    It deliberately does NOT feed ``check_scalar_columns_unreserved`` — a project
    that already selected a group-rule column as a breakdown keeps working.
    """
    reserved = (
        config.event_type_column,
        config.time_column,
        config.app_version_column,
        config.platform_column,
    )
    return {column for column in reserved if column} | _event_group_rule_columns(config)

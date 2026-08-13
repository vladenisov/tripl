"""Every reference to an event must be a decision, not an oversight (tripl-xfxa).

``_event_generator_merge._merge_event_into_group`` migrates a merged-away
event's rows onto the surviving group event and then calls
``session.delete(source)``. Eighteen columns FK to ``events.id``; the merge
handled six of them, and the other twelve went quietly over the cliff. Nothing
failed, nothing logged, and the loss only surfaced months later as variables
whose ``/values`` list had gone empty behind an HTTP 200.

The defect was not "somebody wrote the wrong code". It was that the list of
things a merge has to think about lived nowhere — not in a docstring, not in a
test, only in whichever columns the author happened to remember. So this module
derives that list from the schema instead, and forces every entry into one of
three buckets with a written reason. Adding a new ``ForeignKey("events.id")``
anywhere in the codebase now fails here until someone decides what a merge
should do with it.

This is a schema-shape test, not a behaviour test: it never opens a database.
The behavioural counterparts live in ``test_event_generator.py``.
"""

from __future__ import annotations

import tripl.models  # noqa: F401  (imports every model so Base.metadata is complete)
from tripl.models.base import Base

EVENT_PRIMARY_KEY = "events.id"

# The merge re-points or folds these onto the target before deleting the source.
# Value: where in ``_event_generator_merge.py`` that happens.
MIGRATED: dict[tuple[str, str], str] = {
    ("event_tags", "event_id"): "_move_event_tags: re-points, target wins on duplicate name",
    ("event_meta_values", "event_id"): (
        "_move_event_meta_values: re-points, target wins per meta field definition"
    ),
    (
        "event_photos",
        "event_id",
    ): "_merge_event_into_group: blanket UPDATE, photos have no unique key",
    ("event_metrics", "event_id"): (
        "_merge_event_metric_rows: sums both events' counts per (scan_config, bucket) onto target"
    ),
    ("event_metric_breakdowns", "event_id"): (
        "_merge_event_metric_breakdown_rows: sums both events' counts onto the target"
    ),
    ("alert_delivery_items", "event_id"): (
        "_merge_event_into_group: UPDATE re-points event_id and rewrites scope_ref/scope_name"
    ),
    ("variable_values", "event_id"): (
        "_move_variable_contexts: re-points, folds on uq_variable_value_context, "
        "drops when the target's field value no longer names the variable"
    ),
    ("variable_event_value_overrides", "event_id"): (
        "_move_variable_event_overrides: re-points, target wins on uq_variable_event_value_override"
    ),
    ("variable_value_drifts", "event_id"): (
        "_move_variable_value_drifts: re-points, target wins on uq_variable_value_drift_context"
    ),
}

# The merge intentionally lets these go. Nothing rebuilds them; losing them is
# the accepted cost of collapsing two catalog rows into one.
DELIBERATELY_DROPPED: dict[tuple[str, str], str] = {
    ("event_changes", "event_id"): (
        "Append-only edit history of the row being deleted. Re-pointing would attribute the "
        "source's edits to the group event, which is a lie about who changed what."
    ),
    ("shadow_event_candidates", "accepted_event_id"): (
        "Cosmetic resolution-audit pointer ('a human triaged this ghost identity into that "
        "event'), read only by the reconciliation list response; nothing operational consumes it."
    ),
}

# Known defects, parked here so the ledger stays complete without pretending
# they are settled.
#
# A reason string that says "this is a bug" inside a set called
# DELIBERATELY_DROPPED is only as good as the reader's willingness to read it,
# and a ledger like this gets skimmed by set NAME years after anyone remembers
# why. A fourth name means an open gap cannot be mistaken for a decision.
# Entries move to MIGRATED when fixed; the healthy state of this set is empty.
KNOWN_GAPS: dict[tuple[str, str], str] = {
    ("metric_definitions", "numerator_event_id"): (
        "tripl-jtnv: the merge NULLs a user-configured event_composition operand and the metric "
        "collects zero rows forever with nothing surfaced — _collect_event_composition returns "
        "a SUCCESS carrying values=0, so last_collection_status never goes red — even though "
        "_merge_event_metric_rows moved the underlying series onto the target."
    ),
    ("metric_definitions", "denominator_event_id"): (
        "tripl-jtnv: the ratio's other operand, same silent NULL on merge, same flatline with no "
        "reported failure."
    ),
}

# Recreated by a later step, so losing them on merge is harmless.
DELIBERATELY_CASCADES: dict[tuple[str, str], str] = {
    ("event_field_values", "event_id"): (
        "_create_group_event_from_source already wrote the target's own values with the rule "
        "overrides applied; the source's are redundant and would collide on "
        "uq_event_field_value_event_field anyway."
    ),
    ("metric_anomalies", "event_id"): (
        "_delete_event_anomalies deletes BOTH events' rows on purpose — merging the metric series "
        "invalidates the target's baseline too — and worker/tasks/metrics/detect.py rescores the "
        "window on the next collect_metrics."
    ),
    ("metric_breakdown_anomalies", "event_id"): (
        "Same as metric_anomalies: explicitly deleted for both events by _delete_event_anomalies "
        "and rescored by detect.py on the next collect_metrics."
    ),
    ("release_regressions", "event_id"): (
        "Wiped and recomputed in full per scan_config on every collect_metrics "
        "(worker/tasks/metrics/regression.py), and event_id is re-derived from the event_metrics "
        "rows the merge already re-pointed."
    ),
    ("search_documents", "parent_event_id"): (
        "Derived index. worker/tasks/scan.py reindex_main_branch_from_worker rebuilds documents "
        "from the live entities after the merge commits, deleting rows no live entity produces."
    ),
}

# Reflection cannot see these: they are String/JSON columns that happen to hold
# an event's uuid, with no ForeignKey for ``Base.metadata`` to report. The list
# is therefore MANUAL — nothing detects a new one for you, so a new polymorphic
# ``scope_ref`` or a new JSON payload embedding an event id has to be added here
# by hand. The tests below only check that what is pinned still exists and is
# still not a foreign key.
NON_FK_EVENT_REFERENCES: dict[tuple[str, str], str] = {
    ("metric_anomalies", "scope_ref"): (
        "str(event.id) when scope_type == 'event'. Handled: _delete_event_anomalies deletes by "
        "scope_ref as well as by event_id, for both events."
    ),
    ("metric_breakdown_anomalies", "scope_ref"): (
        "Same as metric_anomalies.scope_ref, breakdown variant; deleted by _delete_event_anomalies."
    ),
    ("alert_delivery_items", "scope_ref"): (
        "str(event.id) copied off the anomaly. Handled: rewritten to str(target.id) alongside "
        "event_id in _merge_event_into_group."
    ),
    ("alert_delivery_items", "details_path"): (
        "Frozen '/monitoring/event/{event_id}' link. NOT rewritten by the merge — a delivered "
        "alert is a historical record of what was said, so the stale link is tolerated."
    ),
    ("alert_delivery_items", "monitoring_path"): (
        "Frozen '/monitoring/event/{scope_ref}' link, same historical-record argument as "
        "details_path; NOT rewritten by the merge."
    ),
    ("alert_rule_states", "scope_ref"): (
        "The open/closed incident + cooldown key, keyed on str(event.id) with no event_id column "
        "at all. NOT rewritten: a merge strands the open incident where no FK sweep can see it."
    ),
    ("anomaly_scope_overrides", "scope_ref"): (
        "The per-scope false-positive sigma ratchet, keyed on str(event.id) with no event_id "
        "column. NOT rewritten: the tuned threshold is stranded and the group event starts from "
        "project defaults."
    ),
    ("release_regressions", "scope_ref"): (
        "str(event.id) beside the real event_id FK. Not rewritten, but harmless: the whole table "
        "is wiped and recomputed per scan_config on every collect_metrics."
    ),
    ("chart_annotations", "scope_ref"): (
        "str(event.id) when scope_type == 'event', no event_id column. NOT rewritten: a "
        "hand-authored chart marker silently stops rendering after a merge."
    ),
    ("implementation_tickets", "event_ids"): (
        "JSON list of event uuid STRINGS the ticket covers, read back to flip events to "
        "'implemented' when the ticket closes. NOT rewritten: a merged event never gets marked."
    ),
    ("alert_rule_filters", "values"): (
        "JSON list of str(event.id) when field == 'event'. NOT rewritten: an in/eq rule silently "
        "stops covering the merged traffic and a not_in rule silently stops excluding it."
    ),
    ("scan_jobs", "result_summary"): (
        "JSON generation snapshot embedding str(event.id) per generated event, read back as a "
        "live id by the metric replay path. NOT rewritten: a replay off a pre-merge job "
        "reconstructs an Event with a deleted id."
    ),
    ("search_documents", "entity_id"): (
        "event.id for entity_type == 'event', no FK of its own. Covered anyway: the same row's "
        "parent_event_id FK cascades, and the reindex rebuilds it."
    ),
    ("search_documents", "route_path"): (
        "'/p/{slug}/monitoring/event/{event.id}'. Covered by the same parent_event_id cascade "
        "plus reindex as entity_id."
    ),
    ("plan_revisions", "payload"): (
        "JSON plan snapshot serialising each event as str(ev.id). Deliberately frozen: a revision "
        "records what the plan looked like then, so rewriting it would falsify history."
    ),
    ("alert_deliveries", "payload_snapshot"): (
        "JSON record of exactly what one delivery said, event ids included. Deliberately frozen "
        "for the same reason as plan_revisions.payload."
    ),
    ("audit_log", "payload"): (
        "JSON audit entries embedding str(event_id). Deliberately immutable — an audit trail that "
        "gets rewritten is not an audit trail."
    ),
}

_ALL_CLASSIFICATIONS: dict[str, dict[tuple[str, str], str]] = {
    "MIGRATED": MIGRATED,
    "DELIBERATELY_DROPPED": DELIBERATELY_DROPPED,
    "DELIBERATELY_CASCADES": DELIBERATELY_CASCADES,
    "KNOWN_GAPS": KNOWN_GAPS,
}

_UNCLASSIFIED_HINT = (
    "Decide what a group-event merge should do with each column before this test can pass:\n"
    "  * if the merge should carry the row onto the surviving event, teach\n"
    "    _merge_event_into_group to move it (mind the unique constraint — a blanket\n"
    "    UPDATE ... SET event_id raises on the first collision) and add it to MIGRATED;\n"
    "  * if the row is rebuilt by a later pipeline step, add it to DELIBERATELY_CASCADES\n"
    "    naming the step that rebuilds it;\n"
    "  * if the row should simply die with the source event, add it to DELIBERATELY_DROPPED;\n"
    "  * if it SHOULD be carried but is not yet, add it to KNOWN_GAPS — an honest gap beats\n"
    "    a decision nobody made.\n"
    "All three of the latter require a written reason — the whole point of this ledger is\n"
    "that the next person can see the decision instead of re-deriving it.\n"
    "See backend/src/tripl/core/analyzers/_event_generator_merge.py."
)


def _event_foreign_keys() -> set[tuple[str, str]]:
    """Every ``(table, column)`` in the mapped schema that FKs to ``events.id``."""
    references: set[tuple[str, str]] = set()
    for table_name, table in Base.metadata.tables.items():
        for column in table.columns:
            for foreign_key in column.foreign_keys:
                if foreign_key.target_fullname == EVENT_PRIMARY_KEY:
                    references.add((table_name, column.name))
    return references


def test_reflection_actually_finds_the_event_foreign_keys():
    """Guard the guard: a broken walk would make every test below pass vacuously."""
    references = _event_foreign_keys()
    assert references, (
        "Reflection found NO foreign keys to events.id. Either `import tripl.models` no longer "
        "registers every model on Base.metadata, or the target_fullname comparison against "
        f"{EVENT_PRIMARY_KEY!r} has drifted. Fix the walk — do not relax the assertion."
    )


def test_every_foreign_key_to_events_is_classified():
    """A new FK to events.id is a new decision the merge has to make."""
    references = _event_foreign_keys()

    unclassified = sorted(
        reference
        for reference in references
        if not any(reference in bucket for bucket in _ALL_CLASSIFICATIONS.values())
    )

    assert not unclassified, (
        "These columns reference events.id but no one has said what "
        "_merge_event_into_group should do with them:\n"
        + "".join(f"  - {table}.{column}\n" for table, column in unclassified)
        + _UNCLASSIFIED_HINT
    )


def test_no_column_is_classified_two_ways():
    """One column, one decision — otherwise the ledger says two things at once."""
    duplicates = sorted(
        (reference, sorted(names))
        for reference in _event_foreign_keys()
        if len(
            names := [name for name, bucket in _ALL_CLASSIFICATIONS.items() if reference in bucket]
        )
        > 1
    )
    assert not duplicates, f"Columns classified in more than one bucket: {duplicates}"


def test_the_classification_ledger_has_no_stale_entries():
    """A ledger that outlives its schema is worse than none — it reads as verified."""
    references = _event_foreign_keys()
    stale = sorted(
        (name, reference)
        for name, bucket in _ALL_CLASSIFICATIONS.items()
        for reference in bucket
        if reference not in references
    )
    assert not stale, (
        "These entries no longer reference events.id — the column was renamed, dropped, or its "
        f"foreign key removed. Delete the entry: {stale}"
    )


def test_every_deliberate_classification_carries_a_reason():
    """The reason is the deliverable; the set membership alone explains nothing."""
    missing = sorted(
        f"{name}[{table}.{column}]"
        for name, bucket in _ALL_CLASSIFICATIONS.items()
        for (table, column), reason in bucket.items()
        if not reason.strip()
    )
    assert not missing, f"Classified without a written reason: {missing}"


def test_non_fk_event_references_are_pinned_and_still_invisible_to_reflection():
    """The manual half of the ledger, checked against the schema it describes.

    Reflection cannot find a uuid stored in a ``String`` or buried in a JSON
    payload, so ``NON_FK_EVENT_REFERENCES`` is hand-maintained and nothing here
    can prove it complete. What these assertions do buy: the pinned columns
    still exist under those names, and none of them has quietly grown a real
    foreign key — in which case the entry belongs in one of the reflected sets
    instead, where the completeness check applies.
    """
    assert NON_FK_EVENT_REFERENCES, "The manual ledger is empty; see the module docstring."

    reflected = _event_foreign_keys()
    problems: list[str] = []
    for (table_name, column_name), reason in NON_FK_EVENT_REFERENCES.items():
        table = Base.metadata.tables.get(table_name)
        if table is None:
            problems.append(f"{table_name}.{column_name}: table no longer exists")
            continue
        if column_name not in table.columns:
            problems.append(f"{table_name}.{column_name}: column no longer exists")
            continue
        if (table_name, column_name) in reflected:
            problems.append(
                f"{table_name}.{column_name}: now a real FK to events.id — move it into "
                "MIGRATED / DELIBERATELY_DROPPED / DELIBERATELY_CASCADES"
            )
        if not reason.strip():
            problems.append(f"{table_name}.{column_name}: pinned without a written reason")

    assert not problems, "Manual event-reference ledger is out of date:\n" + "\n".join(
        f"  - {problem}" for problem in problems
    )

"""Which metrics a fact table's shape is holding up, and the sentence that says so.

There is exactly ONE definition of "this metric would break if that fact table
changed" and it lives here. The pattern is ``services/scan_config_lookup`` for a
different entity: that module exists because three doors could delete a
``FieldDefinition`` and strand a scan's event-name format, so it holds one
predicate plus one message builder and every door calls both.

The doors here are ``fact_table_service.update_fact_table`` (renaming or dropping
a named row filter, and unbinding the data source) and
``fact_table_service.delete_fact_table``. All three edits leave a metric pointing
at something that no longer exists, and the reference is stored by NAME or by id
inside opaque JSON — nothing repoints it. The failure is not raised at edit time
today: it surfaces later, in a Celery worker, as
``_fact_conditions._resolve_named_filter_fragment``'s "row filter {name!r} is not
defined on fact table {id}" or ``metric_collect``'s "FactTable {id} has no data
source bound", against a metric the user did not touch.

Why 409 rather than cascading the rename: a ratio metric stores its operands'
``fact_table_id`` and ``row_filters`` as plain JSON inside ANOTHER metric's
``config`` column, so a cascade would be a cross-entity write into untyped data —
exactly the option ``scan_config_lookup`` declined for the same reason. The save
path already answers this question the same way, with a 422 from
``metric_definition_service._verify_fact_metric``; the user learns the same fact
either way.

Status is deliberately NOT filtered. ``metric_definition_service``'s
``_fact_collection_group`` keeps only ``active`` metrics because it is choosing
what to collect NOW; a referential guard is about the stored graph, and a paused
metric hits the identical error the moment it is reactivated.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.domain_enums import MetricKind
from tripl.models.metric_definition import MetricDefinition

__all__ = [
    "fact_table_conflict_detail",
    "metric_named_filters",
    "metrics_depending_on",
    "metrics_needing_filter",
]

# How many metric names one conflict sentence spells out before it summarises the
# rest. NOTHING bounds how many metric definitions a project may hold: creation
# checks only that the name is unique in the project, and the model's only
# constraint is ``uq_metric_def_project_name``. (``_LIST_HARD_CAP`` is not that
# bound — it clamps the ``LIMIT`` of ``list_metric_definitions``, a page size on a
# different query.) ``metrics_depending_on`` selects the project's fact metrics
# with no limit and hands the whole list to the sentence, so without this cap one
# PATCH produces an error body that grows with the project — a name is up to 255
# characters. Ten is enough to recognise what is in the way; the count that
# follows is enough to know how much more there is.
_MAX_NAMED_METRICS = 10


async def metrics_depending_on(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    fact_table_id: uuid.UUID,
) -> list[MetricDefinition]:
    """Every fact metric in the project that reads this fact table, any status.

    One query for the project's fact metrics, then the membership test in Python:
    a ratio metric's operand ids live in the ``config`` JSON, which is not
    indexable, so there is no narrower SQL predicate to push down. Bounded by the
    project's metric count, and this runs only on the mutating paths.

    The membership rule itself is ``metric_definition_service._metric_fact_table_ids``
    — imported rather than re-derived, because it already handles the
    ``fact_table_id`` column, both ratio operand ids, and the corrupt-UUID skip,
    and a second copy that disagreed would guard the wrong set of metrics.
    """
    # Function-local so a fact-table mutation never puts the metrics service in
    # its module-level import graph: the reach already exists in the other
    # direction (``metric_preview_service`` pulls ``_fact_collection_group`` out
    # of ``metric_definition_service`` inside the function body for the same
    # reason), and a module-level import here would close that loop.
    from tripl.services.metric_definition_service import _metric_fact_table_ids

    candidates = (
        (
            await session.execute(
                select(MetricDefinition).where(
                    MetricDefinition.project_id == project_id,
                    MetricDefinition.kind == MetricKind.fact,
                )
            )
        )
        .scalars()
        .all()
    )
    return [metric for metric in candidates if fact_table_id in _metric_fact_table_ids(metric)]


def metric_named_filters(metric: MetricDefinition) -> set[str]:
    """Every stored row-filter NAME this metric resolves at collection time.

    Mirrors ``worker/tasks/metrics/_fact_conditions._effective_filter_names``:
    the ``row_filters`` list plus a legacy single ``row_filter`` string, read from
    the single-operand config and from both ratio operands. Reading only
    ``row_filters`` would miss configs written before multi-filter support and
    let their filter be renamed out from under them.
    """
    config = metric.config if isinstance(metric.config, Mapping) else {}
    names: set[str] = set()
    for scope in (config, config.get("numerator"), config.get("denominator")):
        if not isinstance(scope, Mapping):
            continue
        raw_list = scope.get("row_filters")
        if isinstance(raw_list, Sequence) and not isinstance(raw_list, (str, bytes)):
            names.update(item for item in raw_list if isinstance(item, str) and item)
        legacy = scope.get("row_filter")
        if isinstance(legacy, str) and legacy:
            names.add(legacy)
    return names


def metrics_needing_filter(
    metrics: Sequence[MetricDefinition], name: str
) -> list[MetricDefinition]:
    """The subset of ``metrics`` that would lose a filter if ``name`` disappeared."""
    return [metric for metric in metrics if name in metric_named_filters(metric)]


def fact_table_conflict_detail(
    *,
    metrics: Sequence[MetricDefinition],
    lead: str,
    reason: str,
    then: str,
) -> str:
    """The 409 body every fact-table door shares, with three clauses differing.

    ``lead`` is a complete sentence naming the refused action; ``reason`` is a
    clause the count completes — "<reason> 2 metrics: …" — and ``then`` completes
    "…, then <then>." Everything between is identical on purpose: an operator who
    hits this on a filter rename and again on Delete must read one rule, not three
    similar-sounding ones.

    ``reason`` is PASSIVE ("This fact table is read by") rather than active ("read
    it") so the one sentence stays grammatical at both counts; with an active verb
    the singular case reads "1 metric read it".

    It names the metrics, states that nothing repoints the reference, and names
    the one edit that unblocks the change.
    """
    listed = list(metrics[:_MAX_NAMED_METRICS])
    named = "; ".join(f"'{metric.name}'" for metric in listed)
    remaining = len(metrics) - len(listed)
    if remaining > 0:
        named = f"{named} and {remaining} more"
    one = len(metrics) == 1
    counted = f"{len(metrics)} metric" if one else f"{len(metrics)} metrics"
    # The back-references have to agree with the count, or the plural case reads
    # "2 metrics reference it: 'A'; 'B'. ... so THAT METRIC'S collection fails" —
    # a sentence that names two metrics and then instructs the reader about one.
    # Same defect "(s)" had, moved one clause along (see the identical note in
    # scan_config_lookup.name_format_conflict_detail).
    subject = "that metric's collection fails" if one else "those metrics' collections fail"
    instruction = "Edit the metric" if one else "Edit those metrics"
    return (
        f"{lead} {reason} {counted}: {named}. "
        f"Nothing repoints that reference, so {subject} on the next run. "
        f"{instruction} first, then {then}."
    )

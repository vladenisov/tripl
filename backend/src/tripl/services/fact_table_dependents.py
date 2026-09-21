"""Which metrics a fact table's shape is holding up, and the sentence that says so.

There is exactly ONE definition of "this metric would break if that fact table
changed" and it lives here. The pattern is ``services/scan_config_lookup`` for a
different entity: that module exists because three doors could delete a
``FieldDefinition`` and strand a scan's event-name format, so it holds one
predicate plus one message builder and every door calls both.

The doors here are ``fact_table_service.update_fact_table`` (renaming or dropping
a named row filter, dropping or renaming an introspected COLUMN a metric
aggregates or filters on, and unbinding the data source) and
``fact_table_service.delete_fact_table``. All four edits leave a metric pointing
at something that no longer exists, and the reference is stored by NAME or by id
inside opaque JSON — nothing repoints it. The failure is not raised at edit time
today: it surfaces later, in a Celery worker, as
``_fact_conditions._resolve_named_filter_fragment``'s "row filter {name!r} is not
defined on fact table {id}", as ``_fact_conditions``'s ``allowed_columns``
rejection of a measure / breakdown / condition column, or as ``metric_collect``'s
"FactTable {id} has no data source bound", against a metric the user did not
touch.

Every predicate here is scoped to ONE fact table id, because the names it matches
are only meaningful against the table that defines them: two tables routinely
carry a filter or a column of the same name, and a cross-table ratio metric reads
both. An unscoped union would refuse an edit to one table by citing a reference
that lives on the other — a refusal the operator cannot act on, because the
metric it names is not doing anything wrong.

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
    "metric_used_columns",
    "metrics_depending_on",
    "metrics_needing_column",
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


def _operand_fact_table_id(scope: Mapping[str, object]) -> uuid.UUID | None:
    """Which fact table ONE ratio operand reads, or ``None`` when it does not say.

    ``metric_definition_service._metric_fact_table_ids`` parses the same key, but
    it answers a different question — the SET of tables a metric touches — and
    collapses exactly the per-operand attribution needed here to decide which
    side of a ratio a filter or column name belongs to, so it cannot be reused.
    A corrupt id is swallowed rather than raised for the reason given there:
    dependency discovery must not turn an unrelated edit into a 500.
    """
    raw = scope.get("fact_table_id")
    if raw is None:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        return None


def _scopes_reading(
    metric: MetricDefinition, fact_table_id: uuid.UUID | None
) -> list[Mapping[str, object]]:
    """The config scopes of ``metric`` whose names resolve against ``fact_table_id``.

    ``fact_table_id=None`` means "do not scope" and returns every scope.

    A scope is EXCLUDED only when it positively names a different table. An
    operand carrying no id, or an unparseable one, stays included: a scope whose
    table cannot be determined has to remain guarded, or one corrupt row quietly
    becomes an unprotected one.

    The top-level scope is the single-operand config, so it is matched against
    the metric's own ``fact_table_id`` — which for a ratio is the numerator's
    table (see ``models/metric_definition``: "the single operand, or the ratio
    numerator").
    """
    config = metric.config if isinstance(metric.config, Mapping) else {}
    scopes: list[Mapping[str, object]] = []
    if fact_table_id is None or metric.fact_table_id in (None, fact_table_id):
        scopes.append(config)
    for role in ("numerator", "denominator"):
        scope = config.get(role)
        if not isinstance(scope, Mapping):
            continue
        operand_id = _operand_fact_table_id(scope)
        if fact_table_id is None or operand_id is None or operand_id == fact_table_id:
            scopes.append(scope)
    return scopes


def metric_named_filters(
    metric: MetricDefinition, *, fact_table_id: uuid.UUID | None = None
) -> set[str]:
    """Every stored row-filter NAME this metric resolves on ``fact_table_id``.

    Mirrors ``worker/tasks/metrics/_fact_conditions._effective_filter_names``:
    the ``row_filters`` list plus a legacy single ``row_filter`` string, read from
    the single-operand config and from both ratio operands. Reading only
    ``row_filters`` would miss configs written before multi-filter support and
    let their filter be renamed out from under them.

    ``fact_table_id`` narrows the answer to the operands that actually read that
    table; pass ``None`` for the unscoped question — every name this metric
    resolves anywhere — which is what a caller wants only when it is not deciding
    whether ONE table's edit is safe.
    """
    names: set[str] = set()
    for scope in _scopes_reading(metric, fact_table_id):
        raw_list = scope.get("row_filters")
        if isinstance(raw_list, Sequence) and not isinstance(raw_list, (str, bytes)):
            names.update(item for item in raw_list if isinstance(item, str) and item)
        legacy = scope.get("row_filter")
        if isinstance(legacy, str) and legacy:
            names.add(legacy)
    return names


def metric_used_columns(
    metric: MetricDefinition, *, fact_table_id: uuid.UUID | None = None
) -> set[str]:
    """Every COLUMN of ``fact_table_id`` this metric names at collection time.

    The operand scopes contribute ``measure_column``, ``distinct_column`` and
    every ``conditions[].column`` — the same three the save path checks in
    ``metric_definition_service._verify_fact_operand`` and the worker rechecks
    against ``allowed_columns``.

    The breakdown dimensions live on the metric ROW rather than in ``config``
    (``metric_collect._metric_breakdown_columns`` reads exactly these three) and
    carry no operand of their own. Attributing them to every table this metric
    reads is not an approximation: a ratio whose operands sit on DIFFERENT tables
    is refused breakdowns outright at save time by
    ``metric_definition_service._reject_cross_table_ratio_breakdowns``, so a
    metric that has any reads one table on both sides.
    """
    scopes = _scopes_reading(metric, fact_table_id)
    names: set[str] = set()
    for scope in scopes:
        for key in ("measure_column", "distinct_column"):
            value = scope.get(key)
            if isinstance(value, str) and value:
                names.add(value)
        raw_conditions = scope.get("conditions")
        if isinstance(raw_conditions, Sequence) and not isinstance(raw_conditions, (str, bytes)):
            for condition in raw_conditions:
                if isinstance(condition, Mapping):
                    column = condition.get("column")
                    if isinstance(column, str) and column:
                        names.add(column)
    if scopes:
        names.update(
            item for item in (metric.breakdown_columns or []) if isinstance(item, str) and item
        )
        for extra in (metric.app_version_column, metric.platform_column):
            if isinstance(extra, str) and extra:
                names.add(extra)
    return names


def metrics_needing_filter(
    metrics: Sequence[MetricDefinition], name: str, *, fact_table_id: uuid.UUID
) -> list[MetricDefinition]:
    """The subset of ``metrics`` that would lose a filter if ``name`` disappeared.

    ``fact_table_id`` is required, not optional: the name is a key into ONE
    table's stored filters, and the caller is always asking about one table's
    pending edit.
    """
    return [
        metric
        for metric in metrics
        if name in metric_named_filters(metric, fact_table_id=fact_table_id)
    ]


def metrics_needing_column(
    metrics: Sequence[MetricDefinition], name: str, *, fact_table_id: uuid.UUID
) -> list[MetricDefinition]:
    """The subset of ``metrics`` that would lose a column if ``name`` disappeared."""
    return [
        metric
        for metric in metrics
        if name in metric_used_columns(metric, fact_table_id=fact_table_id)
    ]


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

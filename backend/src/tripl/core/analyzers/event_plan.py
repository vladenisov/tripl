"""Plan the events a breakdown analysis WOULD produce, writing nothing.

This is the pure half of :mod:`tripl.core.analyzers.event_generator`. It was
extracted so a dry-run can answer "what would this scan create?" through the
*same* code that a real run uses. ``generate_events`` persists at eleven sites
and cannot be made not to with a ``dry_run`` flag; a savepoint-and-rollback was
rejected because it really executes ``session.delete(Event)`` and
``delete(EventMetric)`` (``_event_generator_merge``). Re-implementing name
formatting, grouping and cardinality collapse for the preview would be a second
copy of the rules — a bug class this repository has already shipped twice — so
the rules live here once and both callers read them.

The split is: everything from the breakdown rows up to and including the group
rules is here; everything that touches a ``Session`` stays in
``generate_events``. Two consequences worth naming:

* the two ``ensure_variable`` calls become :class:`VariableNeed` entries on the
  result, in first-seen order. Order is load-bearing — ``ensure_variable``
  creates a variable with the FIRST type it is asked for and registers it on the
  index — so this is an ordered, de-duplicated list and not the ``set`` an
  earlier sketch called for;
* ``normalize_variable_tokens`` is NOT applied here. It rewrites raw path tokens
  to a variable's display name and needs the session-built index; it also runs
  strictly after the event name is built, so nothing here depends on it.

The event name is built from columns that have a field definition, which is why
``field_ids`` is the input rather than the ``FieldDefinition`` objects: a caller
planning a *hypothetical* catalog (the dry-run) can mint ids for fields the run
would create, and a caller writing a real one passes the ids it already has.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from tripl.core.analyzers._event_generator_merge import apply_event_group_rules
from tripl.core.analyzers._event_generator_variables import (
    VariableObservation,
    sample_variable_values,
)
from tripl.core.analyzers.cardinality import BreakdownAnalysis
from tripl.core.analyzers.variable_detector import DetectedPattern, detect_variables
from tripl.core.name_template import NAME_FORMAT_PATTERN, NameFormatError, format_keys
from tripl.json_paths import build_json_value, decode_json_path_value, format_json_path_value
from tripl.models.variable_value import VariableValueKind

logger = logging.getLogger(__name__)

# How many events a single generation pass may create before it stops.
# Declared here so the real run and the dry-run cap at the same number instead of
# each spelling 10000 in its own module.
DEFAULT_MAX_EVENTS = 10000

# How many available column names a NameFormatError lists before summarising.
# ``user_facing_error`` truncates a curated message at 500 chars from the RIGHT,
# so an uncapped list on a wide table pushes the missing key — the only
# actionable part — out of the persisted message (tripl-3mmh).
_AVAILABLE_KEYS_IN_ERROR = 10

# The same 500 chars, as a character budget rather than a name count. A count
# alone is not enough: ten 60-character column names still overrun the cap, and
# the truncation lands mid-token and eats the "… and N more" tail that tells the
# operator the list was summarised at all.
#
# Declared here rather than imported: this is ``core``, which must never import
# ``worker`` (``test_core_does_not_import_worker``). The mirror is pinned by
# ``test_name_format_errors.test_error_budget_mirrors_the_curated_cap``.
_NAME_FORMAT_ERROR_BUDGET = 500

# The ``{key}`` grammar has exactly one definition, in ``core.name_template``.
# It used to be re-declared here and in worker/tasks/metrics/generation.py, held
# in step by a comment in name_template's docstring saying the three "MUST stay
# identical" — which is the drift this repo keeps paying for (Copilot, PR #74).
_FMT_PATTERN = NAME_FORMAT_PATTERN

# Database limit on ``events.name``.
_EVENT_NAME_MAX_LEN = 500


def event_name_format_columns(event_name_format: str | None) -> set[str]:
    """Columns an ``event_name_format`` builds the event name from.

    Shared with ``worker.utils.reserved_columns`` and the replay path in
    ``worker.tasks.metrics.generation`` so none of them can disagree about what
    a placeholder is: a column named here is the event's identity, which makes
    it both something to enumerate (see ``name_columns`` below) and something
    that must never be reserved away — reserving it skips its FieldDefinition,
    and the name format is then evaluated without it (tripl-lpin).
    """
    return set(format_keys(event_name_format)) if event_name_format else set()


def name_format_base_columns(event_name_format: str | None) -> set[str]:
    """Warehouse columns a name format needs a FieldDefinition for.

    Placeholders come from ``event_name_format_columns`` — the one ``{key}``
    grammar — and are then reduced to their BASE column. A dotted placeholder
    like ``{event.category}`` is resolved by walking JSON out of the ``event``
    column, and the ``col.path`` keys below are assembled only from ``col_meta``
    entries, which every column enters through ``field_ids.get(col_name)``.
    So deleting the FieldDefinition for ``event`` kills ``{event.category}``
    exactly as it kills ``{action}`` (tripl-3mmh), and reserving ``event`` away
    from ``catalog_sync`` does the same thing by another route (tripl-lpin).

    The base column is also the only thing a ``missing_field`` drift can name:
    the detector builds those from ``{fd.name for fd in field_definitions}``,
    which are always top-level column names, never dotted paths.

    Lives beside ``event_name_format_columns`` because both consumers already
    import from here — ``services.scan_config_lookup`` (which guards field
    deletion) and ``worker.utils.reserved_columns`` (which guards reservation).
    Putting it in ``services`` would make the sync worker import an async-session
    module for one pure string helper.
    """
    return {key.split(".", 1)[0] for key in event_name_format_columns(event_name_format)}


@dataclass(frozen=True)
class VariableNeed:
    """A variable the plan needs, hoisted out of the column loop.

    ``generate_events`` turns each of these into an ``ensure_variable`` call; the
    dry-run counts them and writes nothing.
    """

    name: str
    inferred_type: str


@dataclass(frozen=True)
class PlannedEvent:
    """One breakdown row resolved to an event identity and its field values.

    ``name`` is the scan identity — the formatted name AFTER group rules, which
    is what ``Event.source_name`` stores and what dedup keys on. There is one
    entry per breakdown row, so the same ``name`` appears more than once whenever
    rows collapse; collapsing them is the caller's job because "already in the
    plan" means different things to a run and to a preview.
    """

    name: str
    field_values: tuple[tuple[uuid.UUID, str, str], ...]
    matched_rule_name: str | None
    row_count: int | None


@dataclass
class EventPlan:
    col_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: list[PlannedEvent] = field(default_factory=list)
    variables_needed: list[VariableNeed] = field(default_factory=list)
    details: list[str] = field(default_factory=list)
    columns_analyzed: int = 0
    events_grouped: int = 0
    # Set only when ``max_events`` was supplied AND hit. ``generate_events``
    # passes no cap and applies its own against the events it actually creates.
    truncated: bool = False


def plan_column_meta(
    analysis: BreakdownAnalysis,
    field_ids: Mapping[str, uuid.UUID],
    *,
    cardinality_threshold: int = 100,
    event_type_column: str | None = None,
    time_column: str | None = None,
    event_name_format: str | None = None,
    reserved_columns: Collection[str] | None = None,
) -> tuple[dict[str, dict[str, Any]], list[VariableNeed], list[str], int]:
    """Per-column metadata: is it JSON, is it enumerated, or is it templated.

    Returns ``(col_meta, variables_needed, details, columns_analyzed)``.
    """
    col_meta: dict[str, dict[str, Any]] = {}
    variables_needed: list[VariableNeed] = []
    seen_variables: set[tuple[str, str]] = set()
    details: list[str] = []
    columns_analyzed = 0

    def need_variable(name: str, inferred_type: str) -> None:
        key = (name, inferred_type)
        if key in seen_variables:
            return
        seen_variables.add(key)
        variables_needed.append(VariableNeed(name=name, inferred_type=inferred_type))

    # Columns referenced by the event-name format are the event's identity, so they must be
    # enumerated (one event per distinct value) even when high-cardinality — otherwise they
    # collapse into a single ${col} template and every row dedups to one event.
    name_columns = event_name_format_columns(event_name_format)
    n_reg = len(analysis.reg_names)
    json_value_index = {
        name: n_reg + len(analysis.json_names) + idx
        for idx, name in enumerate(analysis.json_value_names)
    }
    # Membership is tested once per column; a list argument would make the loop
    # quadratic on a wide table.
    reserved = frozenset(reserved_columns or ())

    for col_name, card_result in analysis.results.items():
        if col_name == event_type_column:
            continue
        if col_name == time_column:
            continue

        fd_id = field_ids.get(col_name)
        if fd_id is None:
            # A grouped scan reads one flat table, so this pass sees every
            # column of the query even when the event type in hand uses only a
            # few. Staying silent about a column that held NOTHING for these
            # rows keeps the warning meaningful: an undeclared column that DOES
            # carry data is a real plan gap and still reports (tripl-jfm3.57).
            # ``count`` excludes NULLs, so 0 means no value in any row here.
            #
            # A RESERVED column is the other false positive: app_version,
            # platform and the event-group-rule columns are metric dimensions or
            # identity inputs, and ``reserved_catalog_columns`` is precisely what
            # kept them from ever getting a FieldDefinition. Reporting that as a
            # plan gap sent a fresh demo's first scan out claiming six missing
            # fields when one was missing (tripl-jfm3.90). Only the MESSAGE is
            # suppressed — a reserved column that does carry a FieldDefinition
            # (an older project, declared before the column was reserved) falls
            # through to the normal path and collects values exactly as before.
            if card_result.count > 0 and col_name not in reserved:
                details.append(f"Skipped column {col_name!r}: no matching field definition")
            continue

        columns_analyzed += 1
        meta: dict[str, Any] = {"fd_id": fd_id, "col_name": col_name}

        if card_result.json_path_combos is not None:
            meta["is_json"] = True
            all_paths: set[str] = set()
            passthrough_paths: list[str] = []
            variable_observations: list[VariableObservation] = []
            for combo in card_result.json_path_combos:
                for path in combo:
                    all_paths.add(path)
            for path in sorted(all_paths):
                full_path = f"{col_name}.{path}"
                if full_path in json_value_index:
                    passthrough_paths.append(full_path)
                    continue
                need_variable(full_path, "string")
                variable_observations.append(
                    VariableObservation(
                        name=full_path,
                        source_column=full_path,
                        value_kind=VariableValueKind.high.value,
                        observed_count=0,
                        values=[],
                    )
                )
            meta["json_passthrough_paths"] = passthrough_paths
            meta["variable_observations"] = variable_observations
            logger.info(
                f"  {col_name}: JSON, {len(card_result.json_path_combos)} path combos, "
                f"{len(all_paths) - len(passthrough_paths)} variables"
            )
        else:
            meta["is_json"] = False
            # Force enumeration for event-name columns regardless of cardinality.
            force_enumerate = col_name in name_columns
            meta["is_low"] = card_result.is_low or force_enumerate
            if not card_result.is_low and not force_enumerate:
                pattern = detect_variables(
                    col_name, card_result.sample_values, cardinality_threshold
                )
                if pattern is None:
                    pattern = DetectedPattern(
                        template=f"${{{col_name}}}",
                        variables=[],
                        coverage_pct=100.0,
                    )
                regular_variable_observations: list[VariableObservation] = []
                for var in pattern.variables:
                    need_variable(var.name, var.inferred_type)
                    observed_count = var.distinct_count or len(var.values)
                    value_kind = (
                        VariableValueKind.low.value
                        if observed_count > 0 and observed_count <= cardinality_threshold
                        else VariableValueKind.high.value
                    )
                    regular_variable_observations.append(
                        VariableObservation(
                            name=var.name,
                            source_column=col_name,
                            value_kind=value_kind,
                            observed_count=observed_count,
                            values=sample_variable_values(var.values, value_kind),
                        )
                    )
                meta["template"] = pattern.template
                meta["variable_observations"] = regular_variable_observations

        col_meta[col_name] = meta

    return col_meta, variables_needed, details, columns_analyzed


def plan_events(
    analysis: BreakdownAnalysis,
    field_ids: Mapping[str, uuid.UUID],
    *,
    cardinality_threshold: int = 100,
    event_type_column: str | None = None,
    time_column: str | None = None,
    event_name_format: str | None = None,
    event_group_rules: Sequence[Mapping[str, object]] | None = None,
    reserved_columns: Collection[str] | None = None,
    max_events: int | None = None,
) -> EventPlan:
    """Resolve breakdown rows into event identities. Writes nothing.

    ``max_events`` defaults to *no cap* on purpose. ``generate_events`` counts
    the events it actually CREATES, which is a different population from the
    distinct names in the plan (a re-scan creates none of them), so capping here
    on the caller's behalf would silently drop rows that would have refreshed an
    existing event's field values. The dry-run, which has no such distinction,
    passes :data:`DEFAULT_MAX_EVENTS` and reads :attr:`EventPlan.truncated`.
    """
    col_meta, variables_needed, details, columns_analyzed = plan_column_meta(
        analysis,
        field_ids,
        cardinality_threshold=cardinality_threshold,
        event_type_column=event_type_column,
        time_column=time_column,
        event_name_format=event_name_format,
        reserved_columns=reserved_columns,
    )
    plan = EventPlan(
        col_meta=col_meta,
        variables_needed=variables_needed,
        details=details,
        columns_analyzed=columns_analyzed,
    )
    if not col_meta:
        plan.details.append("No columns matched field definitions")
        return plan

    reg_index = {name: i for i, name in enumerate(analysis.reg_names)}
    json_index = {name: i for i, name in enumerate(analysis.json_names)}
    n_reg = len(analysis.reg_names)
    json_value_index = {
        name: n_reg + len(analysis.json_names) + idx
        for idx, name in enumerate(analysis.json_value_names)
    }
    row_width = n_reg + len(analysis.json_names) + len(analysis.json_value_names)
    distinct_names: set[str] = set()

    for row in analysis.rows:
        if max_events is not None and len(distinct_names) >= max_events:
            plan.truncated = True
            plan.details.append(f"Reached max_events limit ({max_events})")
            break

        field_values: list[tuple[uuid.UUID, str, str]] = []
        raw_values_by_field = _raw_values_from_row(
            row,
            analysis=analysis,
            event_type_column=event_type_column,
            time_column=time_column,
        )

        for col_name, meta in col_meta.items():
            if meta["is_json"]:
                j = json_index.get(col_name)
                if j is None:
                    continue
                paths = row[n_reg + j]
                if paths:
                    if isinstance(paths, (list, tuple)):
                        sorted_paths = sorted(str(p) for p in paths)
                    else:
                        sorted_paths = [str(paths)]
                    preserved_values = {
                        full_path: decode_json_path_value(row[json_value_index[full_path]])
                        for full_path in meta.get("json_passthrough_paths", [])
                        if full_path in json_value_index and full_path.startswith(f"{col_name}.")
                    }
                    value = build_json_value(
                        col_name,
                        sorted_paths,
                        preserved_values=preserved_values,
                    )
                else:
                    value = "{}"
            elif meta["is_low"]:
                i = reg_index.get(col_name)
                if i is None:
                    continue
                value = _format_value(row[i])
            else:
                value = meta["template"]

            field_values.append((meta["fd_id"], col_name, value))

        # Build event name
        if event_name_format:
            fmt_kwargs: dict[str, str] = {}
            for _, col_name, value in field_values:
                fmt_kwargs[col_name] = value
            for col_name, meta in col_meta.items():
                if not meta["is_json"]:
                    continue
                j = json_index.get(col_name)
                if j is None:
                    continue
                paths = row[n_reg + j]
                if not paths:
                    continue
                if isinstance(paths, (list, tuple)):
                    sorted_paths = sorted(str(path) for path in paths)
                else:
                    sorted_paths = [str(paths)]
                for path in sorted_paths:
                    full_path = f"{col_name}.{path}"
                    if full_path in json_value_index:
                        fmt_kwargs[full_path] = format_json_path_value(
                            row[json_value_index[full_path]]
                        )
                    else:
                        fmt_kwargs[full_path] = f"${{{full_path}}}"
            event_name = _apply_name_format(event_name_format, fmt_kwargs)
        else:
            parts = []
            for _, col_name, value in field_values:
                display = value if len(value) <= 80 else value[:77] + "..."
                parts.append(f"{col_name}={display}")
            event_name = " | ".join(parts)

        # Truncate event_name to respect VARCHAR(500) database limit
        if len(event_name) > _EVENT_NAME_MAX_LEN:
            event_name = event_name[: _EVENT_NAME_MAX_LEN - 3] + "..."

        raw_values_by_field["__event_name"] = event_name
        raw_values_by_field.setdefault("event_name", event_name)
        group_match = apply_event_group_rules(
            event_name,
            raw_values_by_field,
            event_group_rules,
        )
        if group_match.matched_rule_name is not None:
            plan.events_grouped += 1
            event_name = group_match.event_name
            if group_match.field_value_overrides:
                field_values = [
                    (fd_id, col_name, group_match.field_value_overrides.get(col_name, value))
                    for fd_id, col_name, value in field_values
                ]

        distinct_names.add(event_name)
        plan.events.append(
            PlannedEvent(
                name=event_name,
                field_values=tuple(field_values),
                matched_rule_name=group_match.matched_rule_name,
                row_count=_row_count(row, row_width),
            )
        )

    return plan


def breakdown_row_count(analysis: BreakdownAnalysis, row: tuple[object, ...]) -> int | None:
    """The ``_cnt`` every adapter appends last to a GROUP BY ALL row.

    ``None`` when the row carries no count column at all — hand-built analyses in
    tests do that, and guessing ``row[-1]`` there would report a column VALUE as
    a row count. The contract is ``BaseAdapter.get_full_breakdown``: the count is
    appended after the regular, JSON-path and kept-JSON-value columns, and every
    adapter orders by it descending.
    """
    row_width = len(analysis.reg_names) + len(analysis.json_names) + len(analysis.json_value_names)
    return _row_count(row, row_width)


def _row_count(row: tuple[object, ...], row_width: int) -> int | None:
    if len(row) <= row_width:
        return None
    raw = row[-1]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return int(raw)


def _format_value(raw_val: object) -> str:
    """Format a value for display, showing ints without decimal point."""
    if raw_val is None:
        return ""
    if isinstance(raw_val, float) and raw_val.is_integer():
        return str(int(raw_val))
    return str(raw_val)


def _raw_values_from_row(
    row: tuple[object, ...],
    *,
    analysis: BreakdownAnalysis,
    event_type_column: str | None,
    time_column: str | None,
) -> dict[str, str]:
    values: dict[str, str] = {}
    n_reg = len(analysis.reg_names)
    json_value_index = {
        name: n_reg + len(analysis.json_names) + idx
        for idx, name in enumerate(analysis.json_value_names)
    }

    for idx, col_name in enumerate(analysis.reg_names):
        if col_name == time_column:
            continue
        values[col_name] = _format_value(row[idx])

    for idx, col_name in enumerate(analysis.json_names):
        if col_name in (event_type_column, time_column):
            continue
        paths = row[n_reg + idx]
        if isinstance(paths, (list, tuple)):
            values[col_name] = ",".join(sorted(str(path) for path in paths))
        elif paths:
            values[col_name] = str(paths)
        for full_path, value_idx in json_value_index.items():
            if full_path.startswith(f"{col_name}."):
                values[full_path] = format_json_path_value(row[value_idx])

    return values


def _summarize_keys(kwargs: dict[str, str], budget: int) -> str:
    """The available keys, capped so the missing key AND the tail survive truncation.

    Two caps, both load-bearing. ``_AVAILABLE_KEYS_IN_ERROR`` keeps the list
    readable; ``budget`` keeps it inside what ``user_facing_error`` will persist.
    A count alone is not enough — ten long column names still overrun 500 chars,
    and because that truncation cuts from the RIGHT it lands mid-name and takes
    the "… and N more" tail with it, so the operator cannot tell the list was
    summarised (tripl-3mmh).
    """
    names = sorted(kwargs)
    if not names:
        # "Available keys: " with nothing after it reads like a formatting bug.
        return "(none)"

    def rendered(shown: list[str]) -> str:
        remaining = len(names) - len(shown)
        tail = f" … and {remaining} more" if remaining else ""
        return f"{', '.join(shown)}{tail}"

    shown: list[str] = []
    for name in names[:_AVAILABLE_KEYS_IN_ERROR]:
        # A single name wider than the budget is kept anyway: a truncated first
        # name still beats "Available keys: " with nothing after it.
        if shown and len(rendered([*shown, name])) > budget:
            break
        shown.append(name)
    return rendered(shown)


def _apply_name_format(fmt: str, kwargs: dict[str, str]) -> str:
    """Replace {key} placeholders, supporting keys with dots like {event.category}.

    Raises :class:`NameFormatError` when the row cannot supply a placeholder;
    ``worker.tasks._errors.user_facing_error`` surfaces that message verbatim,
    so no caller needs a wrapper (tripl-3mmh).
    """
    missing: list[str] = []

    def _replacer(m: re.Match[str]) -> str:
        key = m.group(1)
        if key in kwargs:
            return kwargs[key]
        missing.append(key)
        return m.group(0)

    result = _FMT_PATTERN.sub(_replacer, fmt)
    if missing:
        # The message MUST start with "Scan failed" — frontend/src/lib/scanError.ts
        # only passes a backend message through verbatim when it does, and without
        # the prefix this self-diagnosing line degrades to a bare "Scan failed."
        # in the UI, which is the outage this fixes (tripl-3mmh). Missing keys come
        # first and the available list is capped because ``user_facing_error``
        # truncates from the right at 500 chars, and a wide warehouse table can
        # supply hundreds of column names.
        #
        # De-duplicated in first-seen order: "{action} / {action}" is one broken
        # column, and naming it twice reads as two separate problems.
        unique_missing = list(dict.fromkeys(missing))
        head = (
            f"Scan failed: the event name format references unknown keys: "
            f"{', '.join(unique_missing)}. Available keys: "
        )
        raise NameFormatError(head + _summarize_keys(kwargs, _NAME_FORMAT_ERROR_BUDGET - len(head)))
    return result

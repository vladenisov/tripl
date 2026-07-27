"""Variable detection, creation, and context recording for event generation."""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tripl.models.event import Event
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind

logger = logging.getLogger(__name__)

VARIABLE_VALUE_SAMPLE_LIMIT = 20

_TOKEN_PATTERN = re.compile(r"\$\{([^}]+)\}")


class VariableIndex:
    """Token → Variable lookup across ``name``, ``source_name`` and ``bindings``.

    Built once per generation run so scans adopt manually-created variables
    (matched through user-editable bindings) instead of creating dotted-path
    duplicates. When two variables claim the same token, the first by ``name``
    ordering wins — adoption stays deterministic across runs.
    """

    def __init__(self, variables: Sequence[Variable] = ()) -> None:
        self._by_token: dict[str, Variable] = {}
        for variable in sorted(variables, key=lambda v: v.name):
            self.add(variable)

    @staticmethod
    def tokens_of(variable: Variable) -> list[str]:
        tokens = [variable.name]
        if variable.source_name:
            tokens.append(variable.source_name)
        tokens.extend(variable.bindings or [])
        seen: set[str] = set()
        unique: list[str] = []
        for token in tokens:
            if token and token not in seen:
                seen.add(token)
                unique.append(token)
        return unique

    def add(self, variable: Variable) -> None:
        for token in self.tokens_of(variable):
            self._by_token.setdefault(token, variable)

    def resolve(self, token: str) -> Variable | None:
        return self._by_token.get(token)


def build_variable_index(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> VariableIndex:
    query = select(Variable).where(Variable.project_id == project_id)
    if branch_id is not None:
        query = query.where(Variable.branch_id == branch_id)
    return VariableIndex(session.execute(query).scalars().all())


def normalize_variable_tokens(value: str, index: VariableIndex) -> str:
    """Rewrite raw ``${path}`` tokens to the bound variable's display name.

    Deterministic and idempotent: a display name resolves back to its own
    variable, so re-running the scan leaves already-normalized values as-is.
    """
    if "${" not in value:
        return value

    def _replace(match: re.Match[str]) -> str:
        token = match.group(1)
        variable = index.resolve(token)
        if variable is None or variable.excluded_from_scans or variable.name == token:
            return match.group(0)
        return f"${{{variable.name}}}"

    return _TOKEN_PATTERN.sub(_replace, value)


@dataclass(frozen=True)
class VariableObservation:
    name: str
    source_column: str
    value_kind: str
    observed_count: int
    values: list[str]


def sample_variable_values(values: Sequence[str], value_kind: str) -> list[str]:
    seen: set[str] = set()
    unique_values: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique_values.append(value)
    if value_kind == VariableValueKind.low.value:
        return unique_values
    return unique_values[:VARIABLE_VALUE_SAMPLE_LIMIT]


def variable_observations(col_meta: dict[str, dict[str, Any]]) -> list[VariableObservation]:
    observations: list[VariableObservation] = []
    for meta in col_meta.values():
        observations.extend(meta.get("variable_observations") or [])
    return observations


def delete_variable_contexts_for_event_type(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    event_type_id: uuid.UUID,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
    rewritten_fields: set[tuple[uuid.UUID, uuid.UUID]],
) -> None:
    """Drop the contexts this run replaces or invalidated — and nothing else.

    Two disjoint reasons to delete a row:

    * its ``(variable, event, field)`` key is in ``contexts``, so
      ``insert_variable_contexts`` is about to re-add it and the old row has to
      go first (``uq_variable_value_context``);
    * this run REWROTE the field value the row describes. A context means "this
      event field's value references ``${variable}``", so it stops being true
      exactly when ``_upsert_field_values`` changes (or newly writes) that
      ``(event, field)`` value — which is what ``rewritten_fields`` carries.

    Everything else is left alone. This used to delete every context for the
    event type unconditionally, which also wiped rows the run had no opinion
    about: values enriched by an earlier replay, and — the case that surfaced it
    — a demo's seeded observed values hanging off authored field values the scan
    is not allowed to touch, so the demo's very first scan emptied its own
    "Variables & value drift" story (bd tripl-jfm3.56). The scheduled metrics
    path already merges into existing rows rather than replacing them
    (``_merge_replay_variable_samples``); this brings the scan path in line.
    """
    event_ids = select(Event.id).where(
        Event.project_id == project_id,
        Event.event_type_id == event_type_id,
    )
    if branch_id is not None:
        event_ids = event_ids.where(Event.branch_id == branch_id)
    query = select(VariableValue).where(
        VariableValue.project_id == project_id,
        VariableValue.event_id.in_(event_ids),
    )
    if branch_id is not None:
        query = query.where(VariableValue.branch_id == branch_id)

    stale_ids = [
        existing.id
        for existing in session.execute(query).scalars().all()
        if (existing.variable_id, existing.event_id, existing.field_definition_id) in contexts
        or (existing.event_id, existing.field_definition_id) in rewritten_fields
    ]
    if not stale_ids:
        return
    session.execute(delete(VariableValue).where(VariableValue.id.in_(stale_ids)))


def preserve_existing_variable_context_values(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
) -> None:
    if not contexts:
        return

    variable_ids = {variable_id for variable_id, _, _ in contexts}
    event_ids = {event_id for _, event_id, _ in contexts}
    field_definition_ids = {field_id for _, _, field_id in contexts}
    query = select(VariableValue).where(
        VariableValue.project_id == project_id,
        VariableValue.variable_id.in_(variable_ids),
        VariableValue.event_id.in_(event_ids),
        VariableValue.field_definition_id.in_(field_definition_ids),
    )
    if branch_id is not None:
        query = query.where(VariableValue.branch_id == branch_id)

    existing_contexts = session.execute(query).scalars().all()
    for existing in existing_contexts:
        key = (existing.variable_id, existing.event_id, existing.field_definition_id)
        context = contexts.get(key)
        if context is None:
            continue

        context_values = list(context.get("values") or [])
        existing_values = list(existing.values or [])
        if not context_values and existing_values:
            context["values"] = sample_variable_values(existing_values, existing.value_kind)

        context["observed_count"] = max(
            int(context.get("observed_count") or 0),
            existing.observed_count,
            len(context.get("values") or []),
        )
        if existing.value_kind == VariableValueKind.high.value:
            context["value_kind"] = VariableValueKind.high.value


def record_variable_contexts(
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
    *,
    event: Event,
    field_values: Sequence[tuple[uuid.UUID, str, str]],
    col_meta: dict[str, dict[str, Any]],
    index: VariableIndex,
) -> None:
    for field_definition_id, col_name, value in field_values:
        observations: list[VariableObservation] = (
            col_meta.get(col_name, {}).get("variable_observations") or []
        )
        if not observations:
            continue
        for observation in observations:
            variable = index.resolve(observation.name)
            if variable is None or variable.excluded_from_scans:
                continue
            # Match the stored value by ANY of the variable's tokens: a
            # hand-authored ${variant} attributes to an observation named
            # page_data.extra.variant through the variable's binding.
            tokens = VariableIndex.tokens_of(variable)
            if not any(f"${{{token}}}" in value for token in tokens):
                continue
            key = (variable.id, event.id, field_definition_id)
            existing = contexts.get(key)
            if existing is None:
                contexts[key] = {
                    "variable_id": variable.id,
                    "event_id": event.id,
                    "field_definition_id": field_definition_id,
                    "source_column": observation.source_column,
                    "value_kind": observation.value_kind,
                    "observed_count": observation.observed_count,
                    "values": list(observation.values),
                }
                continue

            existing["observed_count"] = max(
                int(existing["observed_count"]),
                observation.observed_count,
            )
            if observation.value_kind == VariableValueKind.high.value:
                existing["value_kind"] = VariableValueKind.high.value
            existing["values"] = sample_variable_values(
                [*existing["values"], *observation.values],
                existing["value_kind"],
            )


def insert_variable_contexts(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
) -> None:
    for context in contexts.values():
        payload = {
            "id": uuid.uuid4(),
            "project_id": project_id,
            "variable_id": context["variable_id"],
            "event_id": context["event_id"],
            "field_definition_id": context["field_definition_id"],
            "source_column": context["source_column"],
            "value_kind": context["value_kind"],
            "observed_count": context["observed_count"],
            "values": context["values"],
        }
        if branch_id is not None:
            payload["branch_id"] = branch_id
        session.add(VariableValue(**payload))


def resolve_main_branch_id(session: Session, project_id: uuid.UUID) -> uuid.UUID | None:
    """Return the project's existing main-branch id, or ``None`` if not created yet.

    Scans write plan entities to the main branch (see ``default_branch_id``).
    Variable uniqueness is enforced per branch — ``(project_id, branch_id,
    source_name)`` — so the working copies a project's plan branches hold can
    legitimately share a ``source_name``. Scoping the scan's existence checks to
    the main branch keeps that constraint meaningful and stops a same-name row on
    another branch from making the lookup raise ``MultipleResultsFound``.
    """
    return (
        session.execute(
            select(PlanBranch.id).where(
                PlanBranch.project_id == project_id,
                PlanBranch.kind == BranchKind.main.value,
            )
        )
        .scalars()
        .first()
    )


_NAME_CLEAN_PATTERN = re.compile(r"[^a-z0-9_]+")


def derive_display_name(token: str, index: VariableIndex) -> str:
    """Short human name for a scan-discovered dotted path.

    Candidates grow from the trailing path segments (``variant`` →
    ``extra_variant`` → ``page_data_extra_variant``), normalized to the strict
    variable-name grammar; the first one not already claimed by any token in
    the index wins. Falls back to the raw path (legacy style) when every
    candidate is taken. Non-dotted tokens pass through unchanged.
    """
    if "." not in token:
        return token
    segments = token.split(".")
    for take in range(1, len(segments) + 1):
        candidate = _NAME_CLEAN_PATTERN.sub("_", "_".join(segments[-take:]).lower()).strip("_")
        if not candidate:
            continue
        if not candidate[0].isalpha():
            candidate = f"v_{candidate}"
        if index.resolve(candidate) is None:
            return candidate
    return token


def ensure_variable(
    session: Session,
    project_id: uuid.UUID,
    name: str,
    inferred_type: str,
    branch_id: uuid.UUID | None = None,
    index: VariableIndex | None = None,
) -> int:
    """Create a Variable if it doesn't exist. Returns 1 if created, 0 if already exists.

    Adoption goes through the ``VariableIndex`` (name, source_name and
    user-editable bindings), so a manually-created ``variant`` bound to
    ``page_data.extra.variant`` is adopted instead of duplicated. The index is
    scoped to ``branch_id`` (the scan's main branch) so a same-named variable on
    another plan branch is not treated as an existing match. Callers that loop
    over many columns should build the index once and pass it in; created
    variables are registered on it so later lookups in the same run see them.
    """
    if index is None:
        index = build_variable_index(session, project_id=project_id, branch_id=branch_id)

    existing = index.resolve(name)
    if existing is not None:
        # Backfill source_name for manually-created variables adopted by their
        # display name or binding, so later scans keep matching them.
        if existing.source_name is None:
            existing.source_name = name
            session.flush()
            index.add(existing)
        return 0

    var = Variable(
        id=uuid.uuid4(),
        project_id=project_id,
        # Dotted paths get a short display name; identity stays on
        # source_name/bindings so adoption and attribution are unaffected.
        name=derive_display_name(name, index),
        source_name=name,
        variable_type=inferred_type,
        description="Auto-detected variable from data source scan",
        bindings=[name],
    )
    if branch_id is not None:
        var.branch_id = branch_id
    # Race-safe insert: two concurrent scan workers can discover the same
    # variable in the same bucket and attempt to insert simultaneously.
    # Keep this operation isolated in a SAVEPOINT so an IntegrityError does not
    # poison the outer transaction.
    try:
        with session.begin_nested():
            session.add(var)
            session.flush()
    except IntegrityError:
        logger.info(
            "Variable already inserted concurrently; skipping duplicate",
            # "name" is a reserved LogRecord attribute (the logger name); using it
            # as an extra raises KeyError, so log the variable name as
            # "variable_name".
            extra={
                "project_id": str(project_id),
                "variable_name": name,
                "branch_id": str(branch_id),
            },
        )
        return 0
    index.add(var)
    return 1

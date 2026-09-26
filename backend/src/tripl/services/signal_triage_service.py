"""Triage for open signals that no alert rule routed to an incident (MO-4 / JR-5).

Three verdicts, all undoable:

* **acknowledge** — seen. The signal stays listed, marked acknowledged.
* **mute** — hides every signal on the scope for 24 h, 7 d or until unmuted.
* **mark as expected** — a known cause (a deploy, a campaign). Writes a chart
  annotation on the signal's bucket and hides that one signal.

A signal that WAS routed to an incident is triaged in the alert inbox, never
here: writes refuse it (409), and the read side ignores any verdict on a signal
that has since become an incident, so the two surfaces cannot disagree about
whether it is visible.

"Hidden" (muted or expected) is the one predicate every open-signal count gates
on — the collapsed signal list, the sidebar / Overview badge
(``project_service._populate_monitoring_signals``) and, through the ``hidden``
flag on the expanded list, the Overview headline, the bell and the Anomalies
page default view.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from tripl import cache
from tripl.models.chart_annotation import ChartAnnotation
from tripl.models.domain_enums import MetricScopeType, SignalTriageAction
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.signal_triage import SignalTriage
from tripl.schemas.event_metric import (
    MetricSignalResponse,
    SignalMuteDuration,
    SignalTriageScope,
    SignalTriageState,
)
from tripl.services import alerting_service
from tripl.services.project_lookup import get_project_by_slug

# The scopes the signal lists surface. Drift, schema and release-regression
# scopes never reach them, so a verdict on one could never be seen.
TRIAGE_SCOPE_TYPES = frozenset(
    {
        MetricScopeType.project_total.value,
        MetricScopeType.event_type.value,
        MetricScopeType.event.value,
        MetricScopeType.metric.value,
    }
)

MUTE_DURATIONS: dict[str, timedelta | None] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "until_unmuted": None,
}

# The annotation an "expected" verdict writes. Slate rather than the default
# red: the marker records that the move was explained, not that it is alarming.
EXPECTED_ANNOTATION_LABEL = "Expected"
EXPECTED_ANNOTATION_COLOR = "#64748b"

# (scan_config_id, scope_type, scope_ref); scan_config_id is None for ``metric``.
ScopeKey = tuple[uuid.UUID | None, str, str]
# ScopeKey + the signal's bucket, normalised to UTC.
SignalKey = tuple[uuid.UUID | None, str, str, datetime]


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def scope_key(scan_config_id: uuid.UUID | None, scope_type: str, scope_ref: str) -> ScopeKey:
    scope = str(scope_type)
    # A catalog metric is project-global whatever config a caller names.
    return (None if scope == MetricScopeType.metric.value else scan_config_id, scope, scope_ref)


def signal_key(
    scan_config_id: uuid.UUID | None, scope_type: str, scope_ref: str, bucket: datetime
) -> SignalKey:
    return (*scope_key(scan_config_id, scope_type, scope_ref), _as_utc(bucket))


@dataclass(frozen=True)
class _Expected:
    note: str | None


@dataclass
class TriageIndex:
    """One project's live verdicts, keyed for O(1) lookups per signal."""

    acknowledged: dict[SignalKey, datetime] = field(default_factory=dict)
    expected: dict[SignalKey, _Expected] = field(default_factory=dict)
    # Only mutes still in force; value is ``muted_until`` (None = until unmuted).
    muted: dict[ScopeKey, datetime | None] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.acknowledged or self.expected or self.muted)

    def state_for(self, key: SignalKey) -> SignalTriageState:
        scope = key[:3]
        expected = self.expected.get(key)
        muted = scope in self.muted
        return SignalTriageState(
            acknowledged_at=self.acknowledged.get(key),
            muted=muted,
            muted_until=self.muted.get(scope),
            expected=expected is not None,
            expected_note=expected.note if expected is not None else None,
            hidden=muted or expected is not None,
        )

    def touches(self, key: SignalKey) -> bool:
        return key in self.acknowledged or key in self.expected or key[:3] in self.muted

    def hides(self, key: SignalKey) -> bool:
        return key in self.expected or key[:3] in self.muted


async def load_triage_indexes(
    session: AsyncSession,
    project_ids: Sequence[uuid.UUID],
    *,
    min_bucket: datetime | None = None,
    now: datetime | None = None,
) -> dict[uuid.UUID, TriageIndex]:
    """Every project's live verdicts in one query. Lapsed mutes are left out.

    ``min_bucket`` is the oldest bucket among the signals being looked up:
    per-bucket verdicts (acknowledged, expected) on older buckets can match
    none of them, so they are not loaded. Without it the whole history is.
    """
    if not project_ids:
        return {}
    now = now or datetime.now(UTC)
    conditions: list[ColumnElement[bool]] = [
        SignalTriage.project_id.in_(project_ids),
        or_(
            SignalTriage.action != SignalTriageAction.muted.value,
            SignalTriage.muted_until.is_(None),
            SignalTriage.muted_until > now,
        ),
    ]
    if min_bucket is not None:
        conditions.append(
            or_(SignalTriage.bucket.is_(None), SignalTriage.bucket >= _as_utc(min_bucket))
        )
    rows = (await session.execute(select(SignalTriage).where(*conditions))).scalars()
    indexes: dict[uuid.UUID, TriageIndex] = defaultdict(TriageIndex)
    for row in rows:
        index = indexes[row.project_id]
        action = str(row.action)
        if action == SignalTriageAction.muted.value:
            index.muted[scope_key(row.scan_config_id, row.scope_type, row.scope_ref)] = (
                row.muted_until
            )
            continue
        if row.bucket is None:
            continue
        key = signal_key(row.scan_config_id, row.scope_type, row.scope_ref, row.bucket)
        if action == SignalTriageAction.acknowledged.value:
            index.acknowledged[key] = _as_utc(row.created_at)
        elif action == SignalTriageAction.expected.value:
            index.expected[key] = _Expected(note=row.note)
    return dict(indexes)


async def earliest_mute_expiry(
    session: AsyncSession,
    project_ids: Sequence[uuid.UUID],
    *,
    now: datetime | None = None,
) -> datetime | None:
    """When the first timed mute still in force lapses, across ``project_ids``.

    A cache that counts hidden signals must not outlive this moment: a lapsed
    mute stops hiding at read time, and a count cached before it would keep
    the scope's signals out.
    """
    if not project_ids:
        return None
    now = now or datetime.now(UTC)
    expiry = (
        await session.execute(
            select(func.min(SignalTriage.muted_until)).where(
                SignalTriage.project_id.in_(project_ids),
                SignalTriage.action == SignalTriageAction.muted.value,
                SignalTriage.muted_until > now,
            )
        )
    ).scalar_one_or_none()
    return None if expiry is None else _as_utc(expiry)


def _signal_key_of(signal: MetricSignalResponse) -> SignalKey:
    return signal_key(signal.scan_config_id, signal.scope_type, signal.scope_ref, signal.bucket)


async def apply_triage(
    session: AsyncSession,
    project_id: uuid.UUID,
    signals: list[MetricSignalResponse],
    *,
    drop_hidden: bool,
    incidents_resolved: bool,
) -> list[MetricSignalResponse]:
    """Copies of ``signals`` carrying their triage state.

    ``drop_hidden`` removes muted / expected signals outright (the collapsed
    list); otherwise they stay, flagged ``hidden``, so the Anomalies page can
    offer "Show hidden (n)". ``incidents_resolved`` says ``incident_id`` is
    already filled (the expanded list); when it is not, the incident lookup is
    run here, for the triaged signals only.

    Runs after the signals cache on purpose, like the incident refs: a verdict
    must show on the next fetch, not 30 s later.
    """
    if not signals:
        return signals
    oldest = min(_as_utc(signal.bucket) for signal in signals)
    index = (await load_triage_indexes(session, [project_id], min_bucket=oldest)).get(project_id)
    if not index:
        return signals

    touched = [signal for signal in signals if index.touches(_signal_key_of(signal))]
    if not touched:
        return signals
    routed: set[SignalKey] = set()
    if incidents_resolved:
        routed = {_signal_key_of(signal) for signal in touched if signal.incident_id is not None}
    else:
        refs = await alerting_service.incident_refs_for_signals(
            session,
            project_id,
            (
                (signal.scan_config_id, signal.scope_type, signal.scope_ref, signal.bucket)
                for signal in touched
            ),
        )
        routed = {signal_key(*ref_key) for ref_key in refs}

    out: list[MetricSignalResponse] = []
    for signal in signals:
        key = _signal_key_of(signal)
        if key in routed or not index.touches(key):
            out.append(signal)
            continue
        state = index.state_for(key)
        if drop_hidden and state.hidden:
            continue
        out.append(signal.model_copy(update=state.model_dump()))
    return out


async def hidden_signal_keys(
    session: AsyncSession,
    candidates: Mapping[uuid.UUID, Iterable[SignalKey]],
) -> dict[uuid.UUID, set[SignalKey]]:
    """Per project, which of ``candidates`` a verdict hides from every count.

    For the batched sidebar badge: one query for all projects' verdicts, then an
    incident lookup only for projects that hide something, only for the signals
    they hide — a signal routed to an incident is triaged in the inbox and
    stays counted.
    """
    by_project = {project_id: list(keys) for project_id, keys in candidates.items()}
    buckets = [key[3] for keys in by_project.values() for key in keys]
    if not buckets:
        return {}
    indexes = await load_triage_indexes(session, list(by_project), min_bucket=min(buckets))
    hidden: dict[uuid.UUID, set[SignalKey]] = {}
    for project_id, keys in by_project.items():
        index = indexes.get(project_id)
        if not index:
            continue
        wanted = {key for key in keys if index.hides(key)}
        if not wanted:
            continue
        refs = await alerting_service.incident_refs_for_signals(session, project_id, wanted)
        routed = {signal_key(*ref_key) for ref_key in refs}
        remaining = wanted - routed
        if remaining:
            hidden[project_id] = remaining
    return hidden


# --- writes -----------------------------------------------------------------


@dataclass(frozen=True)
class TriageTarget:
    project: Project
    # Plain copies of ``project.id`` / ``project.slug``. A lost insert race
    # rolls the session back, which expires ``project``; reading an attribute
    # of it then would lazy-load inside the AsyncSession (MissingGreenlet).
    project_id: uuid.UUID
    project_slug: str
    key: SignalKey
    scope_type: str
    scope_ref: str
    scan_config_id: uuid.UUID | None
    bucket: datetime


def _validate_scope_shape(scope_type: str, scan_config_id: uuid.UUID | None) -> None:
    if scope_type not in TRIAGE_SCOPE_TYPES:
        raise HTTPException(422, f"Signals of scope '{scope_type}' cannot be triaged")
    if scope_type == MetricScopeType.metric.value:
        if scan_config_id is not None:
            raise HTTPException(422, "A metric-scope signal carries no scan_config_id")
    elif scan_config_id is None:
        raise HTTPException(422, "scan_config_id is required for this scope")


async def resolve_target(
    session: AsyncSession, slug: str, scope: SignalTriageScope
) -> TriageTarget:
    """The signal a verdict is about — which must exist and not be an incident.

    404 when the project has no anomaly for that scope and bucket (a verdict on
    a signal nobody can see would be invisible and un-undoable from the UI);
    409 when a rule routed it to an incident, whose triage is the inbox's.
    """
    project = await get_project_by_slug(session, slug)
    scope_type = str(scope.scope_type)
    _validate_scope_shape(scope_type, scope.scan_config_id)

    query = select(MetricAnomaly.id).where(
        MetricAnomaly.scope_type == scope_type,
        MetricAnomaly.scope_ref == scope.scope_ref,
        MetricAnomaly.bucket == scope.bucket,
    )
    if scope_type == MetricScopeType.metric.value:
        try:
            metric_id = uuid.UUID(scope.scope_ref)
        except ValueError:
            raise HTTPException(404, "Signal not found") from None
        query = query.join(MetricDefinition, MetricDefinition.id == metric_id).where(
            MetricAnomaly.scan_config_id.is_(None),
            MetricDefinition.project_id == project.id,
        )
    else:
        query = query.join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id).where(
            MetricAnomaly.scan_config_id == scope.scan_config_id,
            ScanConfig.project_id == project.id,
        )
    if (await session.execute(query.limit(1))).scalar_one_or_none() is None:
        raise HTTPException(404, "Signal not found")

    key = signal_key(scope.scan_config_id, scope_type, scope.scope_ref, scope.bucket)
    refs = await alerting_service.incident_refs_for_signals(session, project.id, [key])
    if refs:
        raise HTTPException(
            409,
            "This signal was routed to an incident; triage it in the alert inbox",
        )
    return TriageTarget(
        project=project,
        project_id=project.id,
        project_slug=project.slug,
        key=key,
        scope_type=scope_type,
        scope_ref=scope.scope_ref,
        scan_config_id=key[0],
        bucket=key[3],
    )


def _scope_filter(
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID | None,
    scope_type: str,
    scope_ref: str,
) -> list[ColumnElement[bool]]:
    return [
        SignalTriage.project_id == project_id,
        SignalTriage.scan_config_id.is_(None)
        if scan_config_id is None
        else SignalTriage.scan_config_id == scan_config_id,
        SignalTriage.scope_type == scope_type,
        SignalTriage.scope_ref == scope_ref,
    ]


async def _find(
    session: AsyncSession,
    project_id: uuid.UUID,
    key: ScopeKey,
    action: SignalTriageAction,
    bucket: datetime | None,
) -> SignalTriage | None:
    conditions = [
        *_scope_filter(project_id, *key),
        SignalTriage.action == action.value,
        SignalTriage.bucket.is_(None) if bucket is None else SignalTriage.bucket == bucket,
    ]
    return (
        await session.execute(select(SignalTriage).where(*conditions).limit(1))
    ).scalar_one_or_none()


async def _invalidate(slug: str) -> None:
    # The sidebar badge rides on the cached projects list; the signal lists
    # apply triage after their own cache, so they need nothing.
    await cache.delete_prefix(cache.prefix_projects())


async def _commit_insert(
    session: AsyncSession,
    target: TriageTarget,
    row: SignalTriage,
    *,
    annotation: ChartAnnotation | None = None,
) -> bool:
    """Insert ``row``; False when a concurrent click already wrote the same verdict.

    The insert runs in a SAVEPOINT so a lost race rolls back only that insert.
    A full rollback would expire every instance in the session, including the
    route's current user, and the audit record that follows would then lazy-load
    outside the greenlet (MissingGreenlet). Anything already pending is flushed
    first, outside the savepoint, so its own errors are not mistaken for the race.
    ``annotation`` (the expected verdict's chart marker) is inserted in the same
    savepoint, so a lost race drops it with the verdict.
    """
    await session.flush()
    try:
        async with session.begin_nested():
            if annotation is not None:
                session.add(annotation)
                await session.flush()
                row.annotation_id = annotation.id
            session.add(row)
            await session.flush()
    except IntegrityError:
        return False
    await session.commit()
    return True


async def state_after_write(
    session: AsyncSession, project_id: uuid.UUID, key: SignalKey
) -> SignalTriageState:
    index = (await load_triage_indexes(session, [project_id], min_bucket=key[3])).get(project_id)
    return index.state_for(key) if index else SignalTriageState()


async def acknowledge(
    session: AsyncSession, target: TriageTarget, *, user_id: uuid.UUID | None
) -> tuple[SignalTriage | None, bool]:
    """Acknowledge the signal; returns ``(verdict, created)``.

    ``created`` is False when the verdict already existed (a repeat POST, a
    retry, or a concurrent click that won the insert) so the route audits a
    verdict once, not once per request.
    """
    existing = await _find(
        session, target.project_id, target.key[:3], SignalTriageAction.acknowledged, target.bucket
    )
    if existing is not None:
        return existing, False
    row = SignalTriage(
        project_id=target.project_id,
        scan_config_id=target.scan_config_id,
        scope_type=target.scope_type,
        scope_ref=target.scope_ref,
        action=SignalTriageAction.acknowledged.value,
        bucket=target.bucket,
        created_by_user_id=user_id,
    )
    if not await _commit_insert(session, target, row):
        # A concurrent click won the insert; its verdict is the one on record.
        raced = await _find(
            session,
            target.project_id,
            target.key[:3],
            SignalTriageAction.acknowledged,
            target.bucket,
        )
        return raced, False
    await _invalidate(target.project_slug)
    return row, True


async def mute(
    session: AsyncSession,
    target: TriageTarget,
    duration: SignalMuteDuration,
    *,
    user_id: uuid.UUID | None,
    now: datetime | None = None,
) -> SignalTriage:
    """Mute the target's scope; re-muting replaces the previous duration."""
    span = MUTE_DURATIONS[duration]
    muted_until = None if span is None else (now or datetime.now(UTC)) + span
    existing = await _find(
        session, target.project_id, target.key[:3], SignalTriageAction.muted, None
    )
    if existing is not None:
        existing.muted_until = muted_until
        existing.created_by_user_id = user_id
        await session.commit()
        await _invalidate(target.project_slug)
        return existing
    row = SignalTriage(
        project_id=target.project_id,
        scan_config_id=target.scan_config_id,
        scope_type=target.scope_type,
        scope_ref=target.scope_ref,
        action=SignalTriageAction.muted.value,
        bucket=None,
        muted_until=muted_until,
        created_by_user_id=user_id,
    )
    if not await _commit_insert(session, target, row):
        # A concurrent mute won the insert; apply this duration on top of it.
        raced = await _find(
            session, target.project_id, target.key[:3], SignalTriageAction.muted, None
        )
        if raced is None:  # pragma: no cover - the row that blocked us is gone
            raise HTTPException(409, "The scope's mute changed concurrently; retry")
        raced.muted_until = muted_until
        raced.created_by_user_id = user_id
        await session.commit()
        row = raced
    await _invalidate(target.project_slug)
    return row


async def mark_expected(
    session: AsyncSession,
    target: TriageTarget,
    note: str | None,
    *,
    user_id: uuid.UUID | None,
) -> SignalTriage:
    """Record the signal as expected and put an annotation on its bucket.

    Marking an already-expected signal again updates the note on both the
    verdict and its annotation instead of stacking a second marker.
    """
    clean_note = note.strip() if note and note.strip() else None
    existing = await _find(
        session, target.project_id, target.key[:3], SignalTriageAction.expected, target.bucket
    )
    if existing is not None:
        existing.note = clean_note
        if existing.annotation_id is not None:
            annotation = await session.get(ChartAnnotation, existing.annotation_id)
            if annotation is not None:
                annotation.description = clean_note
        await session.commit()
        await _invalidate(target.project_slug)
        return existing

    annotation = ChartAnnotation(
        project_id=target.project_id,
        scope_type=target.scope_type,
        scope_ref=target.scope_ref,
        bucket=target.bucket,
        label=EXPECTED_ANNOTATION_LABEL,
        description=clean_note,
        color=EXPECTED_ANNOTATION_COLOR,
        created_by_user_id=user_id,
    )
    row = SignalTriage(
        project_id=target.project_id,
        scan_config_id=target.scan_config_id,
        scope_type=target.scope_type,
        scope_ref=target.scope_ref,
        action=SignalTriageAction.expected.value,
        bucket=target.bucket,
        note=clean_note,
        # Set inside the savepoint once the annotation has an id.
        annotation_id=None,
        created_by_user_id=user_id,
    )
    if not await _commit_insert(session, target, row, annotation=annotation):
        # A concurrent click already marked it; the rollback dropped our
        # annotation with the verdict, so the winner's marker is the only one.
        raced = await _find(
            session, target.project_id, target.key[:3], SignalTriageAction.expected, target.bucket
        )
        if raced is None:  # pragma: no cover - the row that blocked us is gone
            raise HTTPException(409, "The signal's verdict changed concurrently; retry")
        row = raced
    await _invalidate(target.project_slug)
    return row


async def _delete_verdict(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID | None,
    scope_type: MetricScopeType,
    scope_ref: str,
    action: SignalTriageAction,
    bucket: datetime | None,
) -> tuple[Project, SignalTriage | None]:
    """Remove one verdict. Idempotent: undoing something already undone is a no-op."""
    project = await get_project_by_slug(session, slug)
    scope = str(scope_type)
    _validate_scope_shape(scope, scan_config_id)
    key = scope_key(scan_config_id, scope, scope_ref)
    row = await _find(session, project.id, key, action, None if bucket is None else _as_utc(bucket))
    if row is None:
        return project, None
    if row.annotation_id is not None:
        await session.execute(
            delete(ChartAnnotation).where(
                ChartAnnotation.id == row.annotation_id,
                ChartAnnotation.project_id == project.id,
            )
        )
    await session.delete(row)
    await session.commit()
    await _invalidate(project.slug)
    return project, row


async def unacknowledge(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID | None,
    scope_type: MetricScopeType,
    scope_ref: str,
    bucket: datetime,
) -> tuple[Project, SignalTriage | None]:
    return await _delete_verdict(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        action=SignalTriageAction.acknowledged,
        bucket=bucket,
    )


async def unmute(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID | None,
    scope_type: MetricScopeType,
    scope_ref: str,
) -> tuple[Project, SignalTriage | None]:
    return await _delete_verdict(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        action=SignalTriageAction.muted,
        bucket=None,
    )


async def unmark_expected(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID | None,
    scope_type: MetricScopeType,
    scope_ref: str,
    bucket: datetime,
) -> tuple[Project, SignalTriage | None]:
    """Undo "expected": the verdict goes, and so does the annotation it wrote."""
    return await _delete_verdict(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        action=SignalTriageAction.expected,
        bucket=bucket,
    )

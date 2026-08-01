"""The vocabulary doctor and status speak: severities, findings, checks.

Pure data plus the handful of total functions over it. No IO, no clock reads,
no import of ``collect`` — everything here can be built in a test without a
network, which is what lets the check rules be tested as arithmetic.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from tripl_cli.errors import EXIT_CHECKS_FAILED, EXIT_OK

JsonDict = dict[str, Any]
JsonList = list[JsonDict]


class Severity(StrEnum):
    """What a check or finding says about the instance.

    Four levels, and ``SKIP`` is a first-class one rather than a silent pass:
    "I could not look" and "I looked and it was fine" are the two answers the
    incident kept confusing. ``PASS`` spells its member name out because ``pass``
    is a keyword.
    """

    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    SKIP = "skip"


# Fixed ids, fixed order, each appearing exactly once per run. Per-project
# results are `findings` INSIDE a check, never repeated checks — a consumer
# selects by id and gets one row.
CHECK_IDS: tuple[str, ...] = (
    "connectivity",
    "auth",
    "projects",
    "data_sources",
    "scans",
    "drifts",
)

SCOPE_INSTANCE = "instance"
SCOPE_PROJECT = "project"
SCOPE_UNKNOWN = "unknown"

# NOT under /api/v1, and unauthenticated: backend/src/tripl/main.py:263 declares
# `@app.get("/health", include_in_schema=False)`, so it is absent from the
# OpenAPI document too. It answers 200 {"status":"ok"} or 503
# {"status":"error","component":"database"}. Lives here rather than in collect so
# the pure check layer can name it in a message without importing the HTTP layer.
HEALTH_PATH = "/health"

# How many scan jobs one history read asks for. Set by collect (it is a query
# parameter) and needed by the checks (a streak that fills the whole window is a
# lower bound, not a measurement), so it belongs to neither of them alone.
JOBS_WINDOW = 200

# The five values of the backend's ScanInterval enum, in seconds. The codes come
# from backend/src/tripl/models/domain_enums.py::ScanInterval; the DURATIONS are
# a second spelling of backend/src/tripl/core/intervals.py::INTERVALS, which is
# the map schedule.py actually feeds to the backoff via get_interval(). Needed
# because every staleness and backoff rule here is expressed in multiples of a
# config's own interval.
INTERVAL_SECONDS: Mapping[str, int] = {
    "15m": 900,
    "1h": 3600,
    "6h": 21600,
    "1d": 86400,
    "1w": 604800,
}


@dataclass(frozen=True)
class Fetched[T]:
    """One read that either produced a payload or produced a reason it did not.

    This type is how TRAP 3 stops being a matter of discipline: a caller cannot
    reach the payload without passing a value that is ``None`` when the call
    failed, so "the endpoint 404'd" can never be silently read as "the list was
    empty". That misreading is what invalidated the 2026-07-30 audit.
    """

    value: T | None = None
    status_code: int | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.value is not None


@dataclass(frozen=True)
class Target:
    """The object a finding - or a watch event - is about, and how to find it.

    The ``kind`` enumeration below is canonical: it is the complete set a
    consumer can switch on, so anything that builds a Target has to appear in it.
    ``scan_job`` and ``alert_delivery`` are watch's, and exist because a follow
    mode points at the individual RUN and the individual DELIVERY, where doctor
    points at the config that owns them.
    """

    kind: str  # "scan_config" | "event_type" | "data_source" | "project"
    #        | "scan_job" | "alert_delivery"
    id: str | None = None
    name: str | None = None


@dataclass(frozen=True)
class Finding:
    """One problem, in the operator's words plus machine-readable evidence.

    ``code`` and ``evidence`` are the contract; ``message`` is prose and may be
    reworded in any release. Severity is only ever WARN or FAIL — a finding is
    by definition something to look at.
    """

    code: str
    severity: Severity
    message: str
    project: str | None = None
    target: Target | None = None
    evidence: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Check:
    id: str
    title: str
    status: Severity
    summary: str
    skip_reason: str | None = None
    findings: tuple[Finding, ...] = ()


@dataclass(frozen=True)
class Instance:
    base_url: str
    base_url_source: str
    api_key_source: str
    api_key_scope: str


@dataclass(frozen=True)
class ProjectSelection:
    """Which projects this run looked at, and how it decided.

    Shared by doctor and status so the two commands cannot drift on *which*
    projects they report about.
    """

    requested_slugs: tuple[str, ...] = ()
    include_demo: bool = False
    # None means the listing was never attempted — either --project was given or
    # the key is project-scoped and the listing 403s by design.
    listing: Fetched[JsonList] | None = None
    by_slug: Mapping[str, Fetched[JsonDict]] = field(default_factory=dict)
    projects: tuple[JsonDict, ...] = ()
    excluded_demo_count: int = 0


@dataclass(frozen=True)
class DriftCoverage:
    """How much of ONE project's event-type list the drift budget reached.

    Per project rather than per run: ``--max-event-types`` is spent round-robin
    across projects (collect), so an instance-wide "40 of 90 examined" cannot say
    WHICH project was only partly looked at — and naming it is the whole value of
    reporting truncation at all (tripl-ey6j.9).
    """

    examined: int = 0
    total: int = 0

    @property
    def truncated(self) -> bool:
        return self.total > self.examined


def _healthy() -> Fetched[JsonDict]:
    return Fetched(value={"status": "ok"}, status_code=200)


@dataclass(frozen=True)
class Snapshot:
    """Everything doctor read, before any of it was judged.

    Defaults describe a reachable instance with nothing in it, so a rule test
    sets only the two or three fields its rule actually reads.
    """

    now: datetime
    base_url: str = "https://tripl.example.com"
    base_url_source: str = "$TRIPL_BASE_URL"
    api_key_source: str = "$TRIPL_API_KEY"
    api_key_scope: str = SCOPE_INSTANCE
    requests: int = 0
    health: Fetched[JsonDict] = field(default_factory=_healthy)
    # None means "not attempted" — the connectivity check short-circuited.
    auth: Fetched[JsonDict] | None = field(
        default_factory=lambda: Fetched(value={}, status_code=200)
    )
    selection: ProjectSelection | None = None
    data_sources: Fetched[JsonList] | None = None
    scans: Mapping[str, Fetched[JsonList]] = field(default_factory=dict)
    jobs: Mapping[tuple[str, str], Fetched[JsonList]] = field(default_factory=dict)
    event_types: Mapping[str, Fetched[JsonList]] = field(default_factory=dict)
    drifts: Mapping[tuple[str, str], Fetched[JsonDict]] = field(default_factory=dict)
    # Keyed by project slug. The instance-wide totals below are DERIVED from it
    # rather than carried alongside it, so the per-project and the whole-run
    # numbers cannot disagree.
    drift_coverage: Mapping[str, DriftCoverage] = field(default_factory=dict)

    @property
    def selected_projects(self) -> tuple[JsonDict, ...]:
        return self.selection.projects if self.selection is not None else ()

    @property
    def event_types_examined(self) -> int:
        return sum(coverage.examined for coverage in self.drift_coverage.values())

    @property
    def event_types_seen(self) -> int:
        return sum(coverage.total for coverage in self.drift_coverage.values())


@dataclass(frozen=True)
class Report:
    command: str
    instance: Instance
    generated_at: datetime
    duration_ms: int
    requests: int
    checks: tuple[Check, ...]

    @property
    def status(self) -> Severity:
        return overall_status(self.checks)

    @property
    def counts(self) -> dict[str, int]:
        # All four keys always present, including the zeroes: a consumer that
        # has to test for key existence before reading a count will eventually
        # forget to.
        tally = {level.value: 0 for level in Severity}
        for check in self.checks:
            tally[check.status.value] += 1
        return tally


@dataclass(frozen=True)
class CoverageStatus:
    days: int
    pct: float
    matched: int
    total: int


@dataclass(frozen=True)
class SectionError:
    section: str
    status_code: int | None
    message: str


@dataclass(frozen=True)
class ProjectStatus:
    slug: str
    name: str
    is_demo: bool
    event_count: int
    active_event_count: int
    event_type_count: int
    scan_count: int
    failing_scan_count: int
    significant_open_signals: int
    firing_monitors: int
    coverage: CoverageStatus | None = None
    errors: tuple[SectionError, ...] = ()


@dataclass(frozen=True)
class StatusSnapshot:
    instance: Instance
    generated_at: datetime
    duration_ms: int
    requests: int
    projects: tuple[ProjectStatus, ...]


def overall_status(checks: Iterable[Check]) -> Severity:
    """Worst verdict across the checks that actually reached one.

    ``SKIP`` does not participate — except that a run where NOTHING reached a
    verdict is a FAIL. "0 failures" out of zero verdicts is the most dangerous
    green in the design, and it is exactly what an unreachable instance would
    otherwise print.
    """
    verdicts = [check.status for check in checks if check.status is not Severity.SKIP]
    if not verdicts:
        return Severity.FAIL
    if Severity.FAIL in verdicts:
        return Severity.FAIL
    if Severity.WARN in verdicts:
        return Severity.WARN
    return Severity.PASS


def exit_code_for(report: Report, *, strict: bool = False) -> int:
    """0, or 3 when the checks found something.

    Warnings exit 0 by default: a cron that goes red over a handful of untriaged
    schema drifts gets muted, and then nobody sees the failing scan either.
    ``--strict`` promotes WARN, and deliberately does NOT promote SKIP — skip
    means "I could not look", and a project-scoped key would otherwise fail every
    strict run forever for a reason the operator cannot fix.
    """
    status = report.status
    if status is Severity.FAIL:
        return EXIT_CHECKS_FAILED
    if strict and status is Severity.WARN:
        return EXIT_CHECKS_FAILED
    return EXIT_OK


def worst(severities: Iterable[Severity]) -> Severity:
    """Severity of a check, given its findings. Empty means nothing to report."""
    levels = list(severities)
    if Severity.FAIL in levels:
        return Severity.FAIL
    if Severity.WARN in levels:
        return Severity.WARN
    return Severity.PASS


def scope_from_auth(auth: Fetched[JsonDict] | None) -> str:
    """Read the key's reach off ``GET /auth/me``.

    ``deps.py::_enforce_project_scope`` rejects any route WITHOUT a ``slug`` path
    param for a project-bound key, so ``/auth/me`` is an unambiguous oracle:
    200 means instance-wide, 403 means fenced to one project. Detecting that
    positively and first is what turns TRAP 5 into a signal instead of an
    inference from some later 403 that could equally mean "your role is too low".

    The 403 body text is deliberately not matched — it is prose and can change;
    the route plus the status code is the whole signal.
    """
    if auth is None:
        return SCOPE_UNKNOWN
    if auth.ok:
        return SCOPE_INSTANCE
    if auth.status_code == 403:
        return SCOPE_PROJECT
    return SCOPE_UNKNOWN


def is_healthy(health: Fetched[JsonDict]) -> bool:
    """200 from /health with the body a tripl instance actually returns."""
    return health.ok and isinstance(health.value, dict) and health.value.get("status") == "ok"


def as_dict(value: Any) -> JsonDict:
    """Coerce an untyped JSON member to a dict; anything else reads as empty."""
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> JsonList:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def text_of(source: Mapping[str, Any], key: str) -> str | None:
    value = source.get(key)
    return value if isinstance(value, str) and value else None


def int_of(source: Mapping[str, Any], key: str, default: int = 0) -> int:
    value = source.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def parse_time(raw: Any) -> datetime | None:
    """Parse an API timestamp, or None. Naive values are read as UTC.

    The API serialises aware datetimes, but ``result_summary`` carries whatever
    the worker wrote, and a naive value read as local time would silently shift
    every staleness verdict by the operator's offset.
    """
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def to_rfc3339(value: datetime) -> str:
    """UTC, second precision, literal Z — one spelling everywhere in the JSON."""
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def format_duration(seconds: float) -> str:
    """A rough human duration. Prose only — never assert on this."""
    value = int(abs(seconds))
    if value < 90:
        return f"{value}s"
    if value < 90 * 60:
        return f"{value // 60}m"
    if value < 72 * 3600:
        return f"{value // 3600}h"
    return f"{value // 86400}d"

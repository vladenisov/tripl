"""The follow loop: one tick at a time, inside one connection pool.

Three properties are load-bearing and each costs almost nothing:

* ONE TICK IS EVER IN FLIGHT, and the sleep happens AFTER the previous tick
  completed - never on a fixed wall clock and never with catch-up. An instance
  that answers slowly is therefore automatically polled less, and a 40-second
  stall can never be followed by a burst of queued ticks.
* A FAILED READ DOES NOT UPDATE ITS STREAM'S SNAPSHOT. Diffing against an empty
  list would print signal.cleared for every open signal and then reprint them all
  as signal.opened on recovery - lying twice during the incident. Holding the
  last GOOD snapshot turns an outage into a reporting DELAY: the next good poll
  fires every transition that happened while watch was blind, late but complete.
* REPEATED FAILURES NEVER END THE RUN. A follow tool that exits when the thing it
  follows goes down is exactly backwards - an operator watching an instance
  through a rolling restart wants watch still there when it comes back, and
  exiting would truncate a `| tee incident.log` capture at the worst moment. Only
  a 401 ends it, because the key is gone and waiting cannot fix that.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from tripl_cli.api.scans import config_names, resolve_selectors
from tripl_cli.diagnostics.collect import Reader, raise_selection_failure, select_projects
from tripl_cli.diagnostics.endpoints import WATCH_ENDPOINTS
from tripl_cli.diagnostics.model import (
    Fetched,
    JsonDict,
    JsonList,
    as_dict,
    format_duration,
    int_of,
    text_of,
)
from tripl_cli.errors import TriplAPIError, TriplConfigError, TriplError
from tripl_cli.watch.collect import (
    TickReads,
    deliveries_of,
    describe,
    read_tick,
)
from tripl_cli.watch.diff import diff_tick
from tripl_cli.watch.model import (
    DELIVERY_STATUS_FAILED,
    REASON_AUTH_FAILED,
    REASON_DURATION,
    REASON_INTERRUPTED,
    REASON_OUTPUT_CLOSED,
    SLOW_STREAM_MIN_SECONDS,
    STATUS_PENDING,
    STATUS_RUNNING,
    WATCH_MAX_CONFIGS,
    DeliveryStream,
    FailureState,
    JobStream,
    JobTarget,
    ProjectRef,
    SignalStream,
    StallEntry,
    StreamSnapshot,
    TickSnapshot,
    WatchEvent,
    WatchOptions,
    WatchOutcome,
    delivery_row_of,
    job_row_of,
    repeat_multiple,
    signal_row_of,
)
from tripl_cli.watch.render import ProjectBaseline, plural

# The path TEMPLATES named in poll.degraded, derived from the declaration the
# contract test enforces rather than spelled a second time here. Every line
# resolves its own through ``_path_of``; the template ships beside it because it
# is the key worth grouping a log query on.
SECTION_PATHS: Mapping[str, str] = {
    section: WATCH_ENDPOINTS[section][0][1]
    for section in ("jobs", "scans", "signals", "deliveries")
}
# Which event tokens a stream's recovery diff can produce, for the "N reported
# from the gap" count.
SECTION_PREFIX: Mapping[str, str] = {
    "jobs": "job.",
    "signals": "signal.",
    "deliveries": "delivery.",
}
# The consequence sentence goes IN THE LINE, not in the docs: the operator
# reading the terminal at 03:00 is not reading the docs.
SECTION_CONSEQUENCE: Mapping[str, str] = {
    "jobs": (
        "Job and progress lines for that scan config are suspended until it recovers - "
        "silence does NOT mean the job is idle."
    ),
    "scans": ("A scan config created during the outage will not be discovered until it recovers."),
    "signals": (
        "Signal lines are suspended until it recovers - no signal lines does NOT mean no signals."
    ),
    "deliveries": (
        "Delivery failure lines are suspended until it recovers - no delivery lines does "
        "NOT mean everyone is being paged."
    ),
}


class Clock(Protocol):
    """Injected so a 20-tick test runs in zero wall-clock time."""

    def now(self) -> datetime: ...
    def monotonic(self) -> float: ...
    async def sleep(self, seconds: float) -> None: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


def default_clock() -> Clock:
    return SystemClock()


@dataclass
class EventSink:
    """Where a line goes, and the tally ``watch.stopped`` reports."""

    write: Callable[[WatchEvent], None]
    counts: dict[str, int] = field(default_factory=dict)
    # True once the destination went away. `tripl watch | head -20` is a pipeline
    # the docs themselves recommend, and an unhandled BrokenPipeError there exits
    # 1 with a traceback instead of the footer - and REPLACES the 130 when the
    # operator Ctrl-Cs such a pipeline. Nothing further is written, and ``follow``
    # ends the run: there is no one left to write to.
    closed: bool = False

    def emit(self, event: WatchEvent) -> None:
        self.counts[event.event] = self.counts.get(event.event, 0) + 1
        if self.closed:
            return
        try:
            self.write(event)
        except BrokenPipeError:
            self.closed = True


@dataclass(frozen=True)
class Preparation:
    """Resolved once, before the loop opens.

    A project created mid-run is NOT picked up; a scan config is, because the
    scan listing is re-read on the slow clock.
    """

    projects: tuple[ProjectRef, ...]
    configs: Mapping[str, Mapping[str, str]]
    targets: tuple[JobTarget, ...]


async def prepare(reader: Reader, options: WatchOptions) -> Preparation:
    """Resolve projects and scan configs, or refuse to start.

    Project selection is ``select_projects`` + ``raise_selection_failure``,
    exactly as ``collect_status`` does it - which is what stops the three
    commands drifting on WHICH projects they look at, and reuses the 403 advice
    ("name the project with --project <slug>") rather than re-wording it.
    """
    selection = await select_projects(
        reader,
        slugs=options.project_slugs,
        include_demo=options.include_demo,
        # watch does not read /auth/me: raise_selection_failure already turns the
        # listing 403 into the right advice, so probing the key's reach would buy
        # one more request and one more thing to keep in sync for nothing.
        scope="unknown",
    )
    raise_selection_failure(selection)

    projects = tuple(
        ProjectRef(
            slug=slug,
            name=text_of(project, "name") or slug,
            significant_open_signals=int_of(
                as_dict(project.get("summary")), "monitoring_signal_count"
            ),
        )
        for project in selection.projects
        for slug in (text_of(project, "slug"),)
        if slug
    )
    slugs = [project.slug for project in projects]
    reads = await read_tick(
        reader,
        job_targets=(),
        scan_slugs=slugs,
        signal_slugs=(),
        delivery_slugs=(),
        jobs_limit=options.jobs_limit,
        deliveries_limit=options.deliveries_limit,
    )

    configs: dict[str, dict[str, str]] = {}
    targets: list[JobTarget] = []
    unmatched: list[str] = []
    for slug in slugs:
        fetched = reads.scans[slug]
        if not fetched.ok or fetched.value is None:
            # The one read whose failure is fatal, and it is fatal BEFORE a line
            # is printed rather than halfway through a feed: without the listing
            # watch does not know what to follow.
            raise _start_failure(fetched, f"could not list the scan configs of {slug!r}")
        named = config_names(fetched.value)
        configs[slug] = named
        matched, missed = resolve_selectors(named, options.scan_selectors)
        unmatched.extend(missed)
        targets.extend((slug, config_id) for config_id in matched)

    if unmatched:
        raise TriplConfigError(_unmatched_message(unmatched, configs))
    if len(targets) > WATCH_MAX_CONFIGS:
        raise TriplConfigError(
            f"{len(targets)} scan configs is more than watch follows at once "
            f"({WATCH_MAX_CONFIGS}). Narrow the run with --project SLUG or --scan NAME. "
            "watch refuses rather than truncating: a command that repeats would have to "
            "reprint the warning every tick or print it once where it scrolls away, and "
            "either way the operator would be reading a feed silently missing a config."
        )
    return Preparation(projects=projects, configs=configs, targets=tuple(targets))


async def follow(
    reader: Reader,
    preparation: Preparation,
    options: WatchOptions,
    *,
    sink: EventSink,
    clock: Clock,
    on_ready: Callable[[Sequence[ProjectBaseline], JsonDict], None],
) -> WatchOutcome:
    """Seed, hand the baseline to the caller, then follow until told to stop."""
    state = _State(reader=reader, preparation=preparation, options=options, clock=clock, sink=sink)
    started = clock.monotonic()

    revoked = state.absorb(await state.read(slow=True), seed=True)
    # The degraded lines go out FIRST, before the screen they qualify. The
    # preamble is the one place an operator reads a number as fact, so "signals
    # unknown - the seeding read failed" has to arrive with its reason already on
    # the terminal rather than three lines later.
    state.flush_diagnostics()
    # The first successful reads SEED every snapshot, so nothing the preamble
    # shows reprints as an event. An operator who attached 30 seconds into an
    # incident sees the running replay at its current chunk immediately (TRAP D).
    on_ready(state.baselines(), state.baseline_counts())

    reason = REASON_AUTH_FAILED if revoked else REASON_DURATION
    try:
        while not revoked:
            if sink.closed:
                # Nobody is reading any more; keeping the poll loop alive against
                # an already-unwell instance would be pure load.
                reason = REASON_OUTPUT_CLOSED
                break
            if options.duration is not None:
                remaining = options.duration - (clock.monotonic() - started)
                if remaining <= 0:
                    break
                await clock.sleep(min(options.interval, remaining))
            else:
                await clock.sleep(options.interval)
            if state.absorb(await state.read(slow=False), seed=False):
                reason = REASON_AUTH_FAILED
                break
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Caught to print the footer, then RE-RAISED so cli.py stays the only
        # place 130 is decided. Swallowing it here and returning normally is the
        # single most plausible way this command silently starts exiting 0.
        _stop(state, REASON_INTERRUPTED, started)
        raise

    outcome = _stop(state, reason, started)
    if state.auth_failure is not None:
        # cli.py already renders a TriplError as `tripl: <message>` and returns
        # EXIT_FAILURE. Reusing that beats inventing a second exit path.
        raise state.auth_failure
    return outcome


# --- loop state -----------------------------------------------------------


@dataclass
class _State:
    reader: Reader
    preparation: Preparation
    options: WatchOptions
    clock: Clock
    sink: EventSink
    snapshot: TickSnapshot = field(default_factory=TickSnapshot)
    stalls: Mapping[str, StallEntry] = field(default_factory=dict)
    # (section, project slug, target ref) -> the run of failures. The slug is in
    # the key rather than parsed back out of the ref, so "which of this project's
    # streams is currently unreadable" is a lookup rather than a guess.
    failures: dict[tuple[str, str, str], FailureState] = field(default_factory=dict)
    last_ok: dict[tuple[str, str], float] = field(default_factory=dict)
    targets: list[JobTarget] = field(default_factory=list)
    configs: dict[str, dict[str, str]] = field(default_factory=dict)
    # A config discovered mid-run that the budget has no room for -> how many
    # ticks it has been dropped, for the same power-of-two throttle everything
    # else here uses.
    dropped: dict[JobTarget, int] = field(default_factory=dict)
    pending: list[WatchEvent] = field(default_factory=list)
    ticks: int = 0
    auth_failure: TriplAPIError | None = None

    def __post_init__(self) -> None:
        self.targets = list(self.preparation.targets)
        self.configs = {slug: dict(named) for slug, named in self.preparation.configs.items()}
        # ``prepare`` just read the scan listing successfully for every project,
        # so the slow clock starts now rather than firing a second identical read
        # on the seeding tick.
        for slug in self.preparation.configs:
            self.last_ok[("scans", slug)] = self.clock.monotonic()

    @property
    def slugs(self) -> list[str]:
        return [project.slug for project in self.preparation.projects]

    async def read(self, *, slow: bool) -> TickReads:
        return await read_tick(
            self.reader,
            job_targets=tuple(self.targets),
            # scans is never forced - ``prepare`` already read it, and the slow
            # clock is what discovers a config created mid-incident.
            scan_slugs=self.due("scans"),
            signal_slugs=self.slugs if slow else self.due("signals"),
            delivery_slugs=self.slugs if slow else self.due("deliveries"),
            jobs_limit=self.options.jobs_limit,
            deliveries_limit=self.options.deliveries_limit,
        )

    def due(self, section: str) -> list[str]:
        """Slow streams: at most once every SLOW_STREAM_MIN_SECONDS, per project.

        30s is not invented - ``get_active_signals`` caches its unfiltered
        variants at ttl_seconds=30, so polling faster is provably wasted work
        when Redis is on and pure extra load when it is off.
        """
        moment = self.clock.monotonic()
        return [
            slug
            for slug in self.slugs
            if moment - self.last_ok.get((section, slug), moment - SLOW_STREAM_MIN_SECONDS)
            >= SLOW_STREAM_MIN_SECONDS
        ]

    # --- one tick ---------------------------------------------------------
    def absorb(self, reads: TickReads, *, seed: bool) -> bool:
        """Fold one tick's answers in. Returns True if the key was revoked."""
        self.ticks += 1
        moment = self.clock.now()
        if self._auth_revoked(reads, moment):
            return True

        recovered: list[tuple[str, str, str, FailureState]] = []
        jobs = dict(self.snapshot.jobs)
        signals = dict(self.snapshot.signals)
        deliveries = dict(self.snapshot.deliveries)
        # Which scan configs this tick actually SAW. The merged snapshot below
        # carries an entry for every config ever read, including the ones whose
        # read just failed, so the diff has to be told which rows are fresh.
        refreshed: set[JobTarget] = set()

        for slug, fetched in reads.scans.items():
            if self._judge("scans", slug, slug, fetched, moment, recovered):
                self._adopt_configs(slug, fetched.value or [], moment)

        for target, jobs_read in reads.jobs.items():
            slug = target[0]
            if not self._judge("jobs", _ref(target), slug, jobs_read, moment, recovered):
                continue
            refreshed.add(target)
            rows = jobs_read.value or []
            stream: JobStream = StreamSnapshot(
                rows={row.id: row for row in (job_row_of(raw) for raw in rows) if row is not None},
                window_full=len(rows) >= self.options.jobs_limit,
            )
            self._window_line(
                "jobs",
                _ref(target),
                slug,
                stream,
                jobs.get(target),
                self.options.jobs_limit,
                moment,
            )
            jobs[target] = stream

        for slug, signals_read in reads.signals.items():
            if not self._judge("signals", slug, slug, signals_read, moment, recovered):
                continue
            signal_stream: SignalStream = StreamSnapshot(
                rows={
                    row.key: row
                    for row in (signal_row_of(raw) for raw in signals_read.value or [])
                    if row is not None
                }
            )
            signals[slug] = signal_stream

        for slug, deliveries_read in reads.deliveries.items():
            if not self._judge("deliveries", slug, slug, deliveries_read, moment, recovered):
                continue
            items = deliveries_of(deliveries_read.value or {})
            delivery_stream: DeliveryStream = StreamSnapshot(
                rows={
                    row.id: row
                    for row in (delivery_row_of(raw) for raw in items)
                    if row is not None
                },
                window_full=len(items) >= self.options.deliveries_limit,
            )
            self._window_line(
                "deliveries",
                slug,
                slug,
                delivery_stream,
                deliveries.get(slug),
                self.options.deliveries_limit,
                moment,
            )
            deliveries[slug] = delivery_stream

        current = TickSnapshot(
            jobs=jobs, signals=signals, deliveries=deliveries, configs=dict(self.configs)
        )
        now = self.clock.monotonic()
        result = diff_tick(
            self.snapshot,
            current,
            observed_at=moment,
            monotonic=now,
            stalls=self.stalls,
            stall_after=self.options.stall_after,
            refreshed_jobs=refreshed,
        )
        self.snapshot = current
        self.stalls = result.stalls

        if seed:
            # The seeding tick's diff is empty by construction (previous holds no
            # entry for any stream). Its diagnostics are real, and ``follow``
            # flushes them just before the preamble they qualify.
            return False

        self.flush_diagnostics()
        for section, slug, ref, failure in recovered:
            self.sink.emit(
                _recovered_event(section, slug, ref, failure, moment, now, result.events)
            )
        for event in result.events:
            self.sink.emit(event)
        return False

    def flush_diagnostics(self) -> None:
        for event in self.pending:
            self.sink.emit(event)
        self.pending.clear()

    # --- per-read judgement ----------------------------------------------
    def _judge(
        self,
        section: str,
        ref: str,
        slug: str,
        fetched: Fetched[Any],
        moment: datetime,
        recovered: list[tuple[str, str, str, FailureState]],
    ) -> bool:
        """True when this read may update its stream. TRAP B lives here."""
        key = (section, slug, ref)
        moment_monotonic = self.clock.monotonic()
        if fetched.ok:
            previous = self.failures.pop(key, None)
            self.last_ok[(section, slug)] = moment_monotonic
            if previous is not None and previous.consecutive:
                recovered.append((section, slug, ref, previous))
            return True
        before = self.failures.get(key, FailureState())
        state = FailureState(
            consecutive=before.consecutive + 1,
            since=before.since or moment,
            since_monotonic=(
                before.since_monotonic if before.since_monotonic is not None else moment_monotonic
            ),
            last_status_code=fetched.status_code,
            last_error=describe(fetched),
        )
        self.failures[key] = state
        # A 403 is ALWAYS just a line and never ends the run: it is legitimately
        # per-project and per-role, and in every one of those cases the OTHER
        # projects are still reporting usefully. If all of them 403 the operator
        # gets a wall of lines naming the 403 and can Ctrl-C.
        if _should_report(state.consecutive):
            self.pending.append(_degraded_event(section, ref, slug, state, moment))
        return False

    def _window_line(
        self,
        section: str,
        ref: str,
        slug: str,
        stream: StreamSnapshot[Any, Any],
        before: StreamSnapshot[Any, Any] | None,
        limit: int,
        moment: datetime,
    ) -> None:
        """Say so when a full window may have hidden rows watch never saw.

        Not merely "the response was at its limit" - a healthy config with ten
        jobs of history hits that on every poll and it means nothing. The real
        condition is a FULL window in which EVERY row is new, because that is the
        only shape from which older unseen rows could have been pushed out.
        """
        if before is None or not stream.window_full:
            return
        if any(key in before.rows for key in stream.rows):
            return
        self.pending.append(
            _degraded(
                section=section,
                slug=slug,
                ref=ref,
                moment=moment,
                message=(
                    f"{section} read came back full at {limit} rows and every row was new, "
                    f"so older rows may have been pushed out of {_path_of(section, slug, ref)} "
                    "between polls. Lower --interval, or narrow the run."
                ),
                window_full=True,
                window=limit,
            )
        )

    def _adopt_configs(self, slug: str, scans: JsonList, moment: datetime) -> None:
        """Pick up a config created mid-incident. It seeds silently.

        Names are MERGED rather than replaced: a config deleted from the listing
        keeps its name in the prose of the lines still describing its last job.

        A config the budget has no room for is NOT dropped quietly. Startup
        refuses to truncate rather than leave the operator reading a feed that is
        silently missing a config; the same fact discovered mid-run cannot refuse,
        so it says so instead - on the power-of-two schedule, because it is a
        condition that persists rather than an event.
        """
        named = config_names(scans)
        matched = (
            resolve_selectors(named, self.options.scan_selectors)[0]
            if self.options.scan_selectors
            else tuple(named)
        )
        known = self.configs.setdefault(slug, {})
        for config_id in matched:
            known[config_id] = named[config_id]
            target = (slug, config_id)
            if target in self.targets:
                continue
            if len(self.targets) < WATCH_MAX_CONFIGS:
                self.targets.append(target)
                self.dropped.pop(target, None)
                continue
            seen = self.dropped.get(target, 0) + 1
            self.dropped[target] = seen
            if _should_report(seen):
                self.pending.append(_capped_event(slug, config_id, named[config_id], moment))

    def _auth_revoked(self, reads: TickReads, moment: datetime) -> bool:
        for section, slug, ref, fetched in _every_read(reads):
            if fetched.status_code != 401:
                continue
            self.auth_failure = TriplAPIError(401, None, describe(fetched))
            self.pending.append(
                _degraded(
                    section=section,
                    slug=slug,
                    ref=ref,
                    moment=moment,
                    message=(
                        f"{section} read of {_path_of(section, slug, ref)} was refused with "
                        "HTTP 401. The API key is no longer valid; watch is stopping because "
                        "waiting cannot fix that, and continuing would hammer an auth path "
                        "that is logged and rate-limited."
                    ),
                    status_code=401,
                    error=describe(fetched),
                    consecutive_failures=1,
                )
            )
            return True
        return False

    # --- the first screen -------------------------------------------------
    def unread(self, slug: str) -> dict[str, str]:
        """Which of this project's streams the seeding read did NOT get.

        Read off ``failures``, which holds an entry for exactly the reads that
        failed - a successful read pops its key. This is what stops a 500 on the
        seeding poll from reaching the first screen as a zero.
        """
        found: dict[str, str] = {}
        for (section, failed_slug, _ref), state in self.failures.items():
            if failed_slug == slug and section != "scans":
                found.setdefault(section, _status_phrase(state.last_status_code))
        return found

    def baselines(self) -> tuple[ProjectBaseline, ...]:
        rows: list[ProjectBaseline] = []
        for project in self.preparation.projects:
            jobs = [
                job
                for (slug, _scan_id), stream in self.snapshot.jobs.items()
                if slug == project.slug
                for job in stream.rows.values()
            ]
            signals = self.snapshot.signals.get(project.slug)
            deliveries = self.snapshot.deliveries.get(project.slug)
            unread = self.unread(project.slug)
            rows.append(
                ProjectBaseline(
                    slug=project.slug,
                    name=project.name,
                    running=tuple(job for job in jobs if job.status == STATUS_RUNNING),
                    pending=tuple(job for job in jobs if job.status == STATUS_PENDING),
                    # None, never 0, when the read failed: "no signals" and "I
                    # could not look" are the two answers this tool exists to
                    # keep apart, and the preamble is where a number reads as
                    # fact.
                    open_signals=(
                        len(signals.rows)
                        if signals is not None and "signals" not in unread
                        else None
                    ),
                    significant_open_signals=project.significant_open_signals,
                    failed_deliveries=(
                        sum(
                            1
                            for row in deliveries.rows.values()
                            if row.status == DELIVERY_STATUS_FAILED
                        )
                        if deliveries is not None and "deliveries" not in unread
                        else None
                    ),
                    configs=self.configs.get(project.slug, {}),
                    unread=unread,
                )
            )
        return tuple(rows)

    def baseline_counts(self) -> JsonDict:
        """The ``watch.started.data.baseline`` block. A null is a real answer here.

        A total is null when ANY project contributing to it could not be read:
        summing the ones that answered would ship a number that looks complete
        and is not.
        """
        rows = self.baselines()
        jobs_unread = any("jobs" in row.unread for row in rows)
        return {
            "running_jobs": None if jobs_unread else sum(len(row.running) for row in rows),
            "pending_jobs": None if jobs_unread else sum(len(row.pending) for row in rows),
            "open_signals": _total(row.open_signals for row in rows),
            "significant_open_signals": sum(row.significant_open_signals for row in rows),
            "failed_deliveries": _total(row.failed_deliveries for row in rows),
        }


# --- diagnostics ----------------------------------------------------------


def _should_report(consecutive: int) -> bool:
    """The 1st, 2nd, 4th, 8th... failure in a row gets a line. The rest are quiet.

    The same power-of-two rule ``job.stalled`` uses, applied to a different
    quantity - one rule in the codebase, used twice.
    """
    return repeat_multiple(float(consecutive), 1.0) > repeat_multiple(float(consecutive - 1), 1.0)


def _status_phrase(status_code: int | None) -> str:
    return f"HTTP {status_code}" if status_code else "no response"


def _path_of(section: str, slug: str | None, ref: str | None) -> str:
    """The CONCRETE path a read used, not the template it came from.

    doctor's ``endpoint_unexpected_status`` reports the resolved path under this
    key name, and an operator following six projects cannot act on
    "/projects/{slug}/anomalies/signals" - it does not say which project, or
    which scan config, just failed. The template still ships beside it as
    ``path_template``, which is the key worth grouping a log query on.
    """
    path = SECTION_PATHS[section]
    if slug:
        path = path.replace("{slug}", slug)
    if ref and "/" in ref:
        # A jobs ref is "<slug>/<scan_config_id>" - the only two-part target.
        path = path.replace("{scan_id}", ref.split("/", 1)[1])
    return path


def _degraded(
    *,
    section: str,
    slug: str | None,
    ref: str | None,
    moment: datetime,
    message: str,
    status_code: int | None = None,
    error: str | None = None,
    consecutive_failures: int = 0,
    window_full: bool = False,
    window: int | None = None,
) -> WatchEvent:
    """The ONE poll.degraded builder: same keys on every line, nulls included.

    Four call sites used to ship three different ``data`` shapes, and the 401 one
    omitted ``target`` and ``project`` altogether - so a consumer had to test for
    a key before reading it, which report.py states as the rule for the doctor
    document and which holds here for exactly the same reason.
    """
    return WatchEvent(
        event="poll.degraded",
        time=moment,
        project=slug,
        message=message,
        # doctor's own key names, so a consumer's endpoint_unexpected_status
        # extractor works on these lines unchanged - which is only true now that
        # `path` carries what doctor's does: the resolved path.
        data={
            "section": section,
            "path": _path_of(section, slug, ref),
            "path_template": SECTION_PATHS[section],
            "status_code": status_code,
            "error": error,
            "consecutive_failures": consecutive_failures,
            "target": ref,
            "window_full": window_full,
            "window": window,
        },
    )


def _degraded_event(
    section: str, ref: str, slug: str, state: FailureState, moment: datetime
) -> WatchEvent:
    return _degraded(
        section=section,
        slug=slug,
        ref=ref,
        moment=moment,
        message=(
            f"{section} read failed: {_status_phrase(state.last_status_code)} on "
            f"{_path_of(section, slug, ref)}. {SECTION_CONSEQUENCE[section]}"
        ),
        status_code=state.last_status_code,
        error=state.last_error,
        consecutive_failures=state.consecutive,
    )


def _capped_event(slug: str, config_id: str, name: str, moment: datetime) -> WatchEvent:
    """A config discovered mid-run that the request budget has no room for."""
    ref = f"{slug}/{config_id}"
    return _degraded(
        section="scans",
        slug=slug,
        ref=ref,
        moment=moment,
        message=(
            f"scan config {name!r} ({config_id}) appeared in {_path_of('scans', slug, None)} "
            f"but watch is already following {WATCH_MAX_CONFIGS} configs and cannot add it "
            "without exceeding its request budget. No job line will ever appear for it. "
            "Restart with --project SLUG or --scan NAME to narrow the run."
        ),
    )


def _recovered_event(
    section: str,
    slug: str,
    ref: str,
    previous: FailureState,
    moment: datetime,
    monotonic: float,
    produced: Sequence[WatchEvent],
) -> WatchEvent:
    """Immediate and unthrottled, and it carries the number that matters.

    "N reported from the gap" is how an operator learns the quiet stretch was
    watch being blind rather than the instance being calm. The gap is measured on
    the MONOTONIC clock, like every other duration watch reports: an NTP step
    during a long outage must not turn it negative.
    """
    gap = monotonic - previous.since_monotonic if previous.since_monotonic is not None else 0.0
    prefix = SECTION_PREFIX.get(section)
    during = (
        sum(1 for item in produced if item.project == slug and item.event.startswith(prefix))
        if prefix
        else 0
    )
    return WatchEvent(
        event="poll.recovered",
        time=moment,
        project=slug,
        message=(
            f"{section} read of {_path_of(section, slug, ref)} recovered after "
            f"{format_duration(gap)} ({plural(previous.consecutive, 'failed poll')}); "
            f"{plural(during, 'event')} reported from the gap."
        ),
        data={
            "section": section,
            "path": _path_of(section, slug, ref),
            "path_template": SECTION_PATHS[section],
            "target": ref,
            "failed_polls": previous.consecutive,
            "gap_seconds": int(gap),
            "events_during_gap": during,
        },
    )


def _total(counts: Iterable[int | None]) -> int | None:
    """A sum that stays honest: null when any contributor could not be read."""
    found = list(counts)
    if any(count is None for count in found):
        return None
    return sum(count for count in found if count is not None)


def _stop(state: _State, reason: str, started: float) -> WatchOutcome:
    state.flush_diagnostics()
    elapsed = state.clock.monotonic() - started
    outcome = WatchOutcome(
        reason=reason,
        elapsed_seconds=round(elapsed, 3),
        ticks=state.ticks,
        requests=state.reader.requests,
        # The tally as of the line before this one; watch.stopped never counts
        # itself.
        counts=dict(state.sink.counts),
    )
    state.sink.emit(
        WatchEvent(
            event="watch.stopped",
            time=state.clock.now(),
            message=(
                f"stopped ({reason}) after {format_duration(elapsed)}, "
                f"{plural(outcome.ticks, 'tick')}, {plural(outcome.requests, 'request')}."
            ),
            data={
                "reason": reason,
                "elapsed_seconds": outcome.elapsed_seconds,
                "ticks": outcome.ticks,
                "requests": outcome.requests,
                "counts": dict(outcome.counts),
            },
        )
    )
    return outcome


def _every_read(reads: TickReads) -> list[tuple[str, str, str, Fetched[Any]]]:
    """(section, project slug, target ref, answer) for every read of one tick.

    The keys travel with the answers so a line about one of them can name the
    concrete path, the project and the target rather than a bare section word.
    """
    found: list[tuple[str, str, str, Fetched[Any]]] = []
    found.extend(("jobs", target[0], _ref(target), value) for target, value in reads.jobs.items())
    found.extend(("scans", slug, slug, value) for slug, value in reads.scans.items())
    found.extend(("signals", slug, slug, value) for slug, value in reads.signals.items())
    found.extend(("deliveries", slug, slug, value) for slug, value in reads.deliveries.items())
    return found


def _ref(target: JobTarget) -> str:
    return f"{target[0]}/{target[1]}"


def _start_failure(fetched: Fetched[Any], context: str) -> TriplError:
    message = f"{context}: {describe(fetched)}"
    if fetched.status_code is not None:
        return TriplAPIError(fetched.status_code, None, message)
    return TriplError(message)


def _unmatched_message(unmatched: Sequence[str], configs: Mapping[str, Mapping[str, str]]) -> str:
    candidates = [
        f"  {name} ({config_id})" for named in configs.values() for config_id, name in named.items()
    ]
    listing = "\n".join(candidates) if candidates else "  (this instance has no scan configs)"
    return (
        f"--scan matched nothing: {', '.join(repr(value) for value in unmatched)}. "
        f"The match is exact, on the name first and then the id. Candidates:\n{listing}"
    )

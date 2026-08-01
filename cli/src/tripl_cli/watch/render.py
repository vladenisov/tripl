"""Human output for watch. ASCII only, and never redrawn.

No colour, no cursor control, no spinner, no progress bar, no unicode glyph - the
same rule as ``diagnostics/render.py`` and for the same reason, sharpened: a
follow mode is the command whose output actually gets piped. `tripl watch | tee
incident.log` has to produce the artifact the operator saw, and a redrawn
dashboard would need cursor control and produce neither.

The layout is one fixed-width line per event:

    {rfc3339:20}  {event:<15}  [{project}] {message}

20 + 2 + 15 + 2 = 39, so content always starts at column 39. Lines are never
wrapped and never truncated - the part that would be cut is always the error
text, which is the part worth having.

The preamble obeys a machine-checkable invariant: NO preamble line begins with a
timestamp and EVERY stream line does, so `tripl watch | grep -E '^[0-9]{4}-'` is
the stream alone.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from tripl_cli.diagnostics.model import format_duration, parse_time, to_rfc3339
from tripl_cli.diagnostics.render import plural as _plural
from tripl_cli.watch.model import (
    EVENT_COLUMN_WIDTH,
    JobRow,
    WatchEvent,
)

_LABEL = 10

# How many running (and pending) jobs the first screen lists before it stops
# naming them and states the remainder. The already-open signals are counted
# rather than listed for exactly this reason - 24 configs x 10 jobs is a first
# screen that scrolls the header off before a single event line - and jobs get
# the same treatment, just with a higher bar because each row carries the chunk
# progress that is the whole point of attaching.
PREAMBLE_JOB_ROWS = 5


def render_line(event: WatchEvent) -> str:
    where = f"[{event.project}] " if event.project else ""
    return f"{to_rfc3339(event.time)}  {event.event:<{EVENT_COLUMN_WIDTH}}  {where}{event.message}"


# --- prose primitives, shared with diff.py --------------------------------


def named(name: str | None) -> str:
    """The ``'prod events' `` prefix, copied from ``render_check`` verbatim.

    One convention, so an operator moving between doctor findings and watch lines
    reads the same shape for "which config is this about".
    """
    return f"{name!r} " if name else ""


def stamp(raw: Any) -> str | None:
    """One spelling for every timestamp in the prose. ``data`` keeps the original."""
    parsed = parse_time(raw)
    return to_rfc3339(parsed) if parsed is not None else None


def number(value: Any, *, digits: int = 0) -> str:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return "?"
    return f"{float(value):.{digits}f}"


def progress_phrase(job: JobRow) -> str:
    """'chunk 5 of 18 (27.8%) collecting', or the status for a non-replay job.

    The phase word is printed verbatim and branched on nowhere: a job sitting at
    `preparing` with 0 of 18 is the wedged-before-starting case, and the phase
    word is the only thing that says so.
    """
    if not job.is_replay:
        return f"in status {job.status}"
    index = job.chunk_index if job.chunk_index is not None else job.chunks_completed
    percent = f" ({job.percent:.1f}%)" if job.percent is not None else ""
    phase = f" {job.phase}" if job.phase else ""
    return f"chunk {index} of {job.chunks_total}{percent}{phase}"


# --- the first screen (TRAP D) --------------------------------------------


@dataclass(frozen=True)
class ProjectBaseline:
    """What the seeding reads found, before a single transition was observed.

    Every count here is ``int | None``, and the None is the whole point: a
    seeding read that FAILED must not arrive as a zero. "0 open across all
    scopes" and "the signals endpoint 500'd" are the two answers this tool exists
    to keep apart, and the first screen is the one place an operator takes a
    number as fact.
    """

    slug: str
    name: str
    running: tuple[JobRow, ...] = ()
    pending: tuple[JobRow, ...] = ()
    open_signals: int | None = 0
    # ProjectResponse.summary.monitoring_signal_count. Printed BESIDE the
    # all-scopes count and labelled: the two are different populations (one is
    # significance-filtered and collapsed, the other is every scope) and a
    # labelled mismatch is honest where an unexplained one becomes a bug report.
    # It comes off the project listing, which `prepare` refuses to start without,
    # so it is never unknown.
    significant_open_signals: int = 0
    failed_deliveries: int | None = 0
    configs: Mapping[str, str] = field(default_factory=dict)
    # section -> why it could not be read ("HTTP 500"), for the streams whose
    # SEEDING read failed. A section named here has a matching poll.degraded line
    # printed immediately above this screen.
    unread: Mapping[str, str] = field(default_factory=dict)


def render_preamble(
    baselines: Sequence[ProjectBaseline],
    *,
    observed_at: datetime,
    interval: float,
    slow_interval: float,
    fast_requests: int,
    slow_requests: int,
    config_count: int,
    jobs_limit: int,
    deliveries_limit: int,
) -> str:
    """The screen an operator who attached 30 seconds late has to be able to read.

    A follow mode that only reported transitions it personally observed would
    tell them nothing is happening. Every count here is marked `(baseline)` so
    subsequent silence reads as "no new ones" rather than "nothing wrong".

    The already-open signals are counted, never listed: a 200-signal incident
    would bury the stream before it started. `tripl status` is the command for
    the list.
    """
    projects = plural(len(baselines), "project")
    configs = plural(config_count, "scan config")
    lines = [
        f"Following {projects}, {configs}. Polling every {_secs(interval)}; signals,",
        f"deliveries and the scan listing at most every {_secs(slow_interval)}. "
        f"{plural(fast_requests, 'request')} per tick,",
        f"{slow_requests} per slow tick. Ctrl-C to stop.",
        "",
    ]
    for baseline in baselines:
        lines.append(f"{baseline.slug} ({baseline.name})")
        lines.extend(_job_rows("running", baseline.running, baseline, observed_at))
        lines.extend(_job_rows("pending", baseline.pending, baseline, observed_at))
        signals = (
            f"{baseline.open_signals} open across all scopes (baseline)"
            if baseline.open_signals is not None
            else _unread_phrase("signals", baseline.unread)
        )
        lines.append(
            f"  {'signals':<{_LABEL}} {signals}; the project summary counts "
            f"{baseline.significant_open_signals} as significant"
        )
        deliveries = (
            f"{baseline.failed_deliveries} failed in the newest {deliveries_limit} (baseline)"
            if baseline.failed_deliveries is not None
            else _unread_phrase("deliveries", baseline.unread)
        )
        lines.append(f"  {'deliveries':<{_LABEL}} {deliveries}")
        lines.append("")
    if not baselines:
        lines.append("No projects selected.")
    return "\n".join(lines).rstrip()


def _unread_phrase(section: str, unread: Mapping[str, str]) -> str:
    """What a stream watch could not read says instead of a number.

    Never a zero, and never a bare "unknown": the operator needs to know that the
    blank is watch's, not the instance's, and where the detail is.
    """
    return (
        f"unknown - the seeding {section} read failed ({unread.get(section, 'no response')}), "
        "see the poll.degraded line above"
    )


def _job_rows(
    label: str, jobs: Sequence[JobRow], baseline: ProjectBaseline, observed_at: datetime
) -> list[str]:
    rows: list[str] = []
    for job in jobs[:PREAMBLE_JOB_ROWS]:
        name = baseline.configs.get(job.scan_config_id or "")
        mode = f" ({job.mode})" if job.mode else ""
        rows.append(
            f"  {label:<{_LABEL}} {named(name)}job {job.id}{mode} {progress_phrase(job)}"
            f"{_age(job, observed_at)}"
        )
    hidden = len(jobs) - len(rows)
    if hidden > 0:
        rows.append(f"  {label:<{_LABEL}} ... and {plural(hidden, 'more job')}")
    if "jobs" in baseline.unread:
        # Partial or empty, either way the list above is NOT the whole answer.
        rows.append(f"  {label:<{_LABEL}} {_unread_phrase('jobs', baseline.unread)}")
    elif not rows:
        rows.append(f"  {label:<{_LABEL}} none")
    return rows


def _age(job: JobRow, observed_at: datetime) -> str:
    """', started 2m ago' - or the clock skew that makes that unanswerable.

    ``elapsed_seconds`` clamps at zero, so without this branch a job whose
    ``started_at`` is in the future would read as "started 0s ago" and the
    operator would never learn that the two machines disagree about the time -
    which quietly distorts every duration on the screen.
    """
    skew = job.clock_skew_seconds(observed_at)
    if skew > 0:
        return f", started_at is {format_duration(skew)} in the FUTURE (clock skew)"
    elapsed = job.elapsed_seconds(observed_at)
    return f", started {format_duration(elapsed)} ago" if elapsed is not None else ""


def _secs(value: float) -> str:
    return f"{value:g}s"


def plural(count: int, noun: str) -> str:
    """Re-exported from ``diagnostics.render``, which is where it lives now.

    Kept importable from here because half of ``watch`` reads it from this
    module; the definition moved when the ``scans``/``drifts`` footers needed the
    same rule and a second copy would have been the third of something.
    """
    return _plural(count, noun)

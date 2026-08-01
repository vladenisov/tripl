"""Human output. ASCII only, and byte-identical whether stdout is a TTY or a pipe.

No colour, no spinners, no cursor control, no emoji, no unicode glyphs. That is
not minimalism for its own sake: `tripl doctor | tee incident.log` and the
terminal view have to be the same artifact, and the logfile an operator pastes
into a ticket must not carry escape codes. A NO_COLOR/isatty branch is pure
polish and can be added later without changing anything here.
"""

from __future__ import annotations

from collections.abc import Sequence

from tripl_cli.diagnostics.model import (
    Check,
    DriftsSnapshot,
    MutationOutcome,
    Report,
    ScanJobsSnapshot,
    ScansSnapshot,
    Severity,
    StatusSnapshot,
    text_of,
)

_INDENT = " " * 6
# Two spaces between columns, which is the narrowest gap that still reads as a
# gap once a value is one character shorter than its neighbour.
_GAP = "  "


def plural(count: int, noun: str) -> str:
    """``1 project`` / ``2 projects``. Lives here so watch and the group commands
    cannot disagree about a footer; ``watch.render`` re-exports it."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def render_header(command: str, base_url: str, source: str) -> str:
    return f"tripl {command} - {base_url} (from {source})"


def _columns(rows: Sequence[Sequence[str]]) -> list[str]:
    """Pad every column to its widest cell; never pad the last one.

    Deterministic from the input alone — no terminal width read, no isatty
    branch — so the piped bytes and the terminal bytes are the same artifact.
    """
    if not rows:
        return []
    width = max(len(row) for row in rows)
    sizes = [max(len(row[index]) for row in rows if index < len(row)) for index in range(width)]
    lines: list[str] = []
    for row in rows:
        cells = [
            cell.ljust(sizes[index]) if index < len(row) - 1 else cell
            for index, cell in enumerate(row)
        ]
        lines.append(_GAP.join(cells).rstrip())
    return lines


def render_check(check: Check) -> str:
    """One check as a fixed-width status token, a summary, and its findings."""
    lines = [f"{check.status.value.upper():<4}  {check.id:<13} {check.summary}"]
    if check.skip_reason is not None and check.skip_reason != check.summary:
        lines.append(f"{_INDENT}skipped: {check.skip_reason}")
    for finding in check.findings:
        where = f" [{finding.project}]" if finding.project else ""
        if finding.target is not None and finding.target.name:
            where += f" {finding.target.name!r}"
        lines.append(f"{_INDENT}- {finding.severity.value}: {finding.code}{where}")
        lines.append(f"{_INDENT}  {finding.message}")
    return "\n".join(lines)


def render_footer(report: Report, exit_code: int) -> str:
    counts = report.counts
    total = len(report.checks)
    if counts[Severity.PASS.value] == total:
        return f"{total} checks: {total} pass. No problems found."
    parts = [
        f"{counts[level.value]} {level.value}"
        for level in (Severity.PASS, Severity.WARN, Severity.FAIL, Severity.SKIP)
        if counts[level.value]
    ]
    line = f"{total} checks: {', '.join(parts)}. Exit {exit_code}."
    if exit_code != 0:
        line += "\nRe-run with --json for the machine-readable form of every finding."
    return line


def render_status(snapshot: StatusSnapshot) -> str:
    lines: list[str] = []
    if not snapshot.projects:
        lines.append("No projects selected.")
    for project in snapshot.projects:
        demo = " [demo]" if project.is_demo else ""
        lines.append(f"{project.slug} ({project.name}){demo}")
        lines.append(
            f"  events     {project.event_count} total, {project.active_event_count} active, "
            f"{project.event_type_count} event types"
        )
        lines.append(
            f"  scans      {project.scan_count} configured, {project.failing_scan_count} failing"
        )
        lines.append(f"  signals    {project.significant_open_signals} significant open")
        lines.append(f"  monitors   {project.firing_monitors} firing")
        if project.coverage is not None:
            coverage = project.coverage
            lines.append(
                f"  coverage   {coverage.pct:.1f}% over {coverage.days} days "
                f"({coverage.matched}/{coverage.total} matched)"
            )
        for error in project.errors:
            lines.append(f"  {error.section}: unavailable ({error.message})")
        lines.append("")
    return "\n".join(lines).rstrip()


def _unavailable(label: str, message: str) -> str:
    """The one spelling of "this read did not arrive", so it is greppable.

    Never an omission and never a zero: a 404 rendered as a shorter list is the
    misreading that invalidated the 2026-07-30 audit (TRAP 3).
    """
    return f"  {label}: unavailable ({message})"


def _schedule_of(scan: dict[str, object]) -> str:
    """Why the dispatcher would or would not select this config."""
    if scan.get("dispatchable"):
        return "scheduled"
    if not scan.get("interval"):
        return "not scheduled (no interval)"
    return "not scheduled (no time column)"


def render_scan_configs(snapshot: ScansSnapshot) -> str:
    lines: list[str] = []
    if not snapshot.projects:
        lines.append("No projects selected.")
    for project in snapshot.projects:
        demo = " [demo]" if project.is_demo else ""
        lines.append(f"{project.slug} ({project.name}){demo}")
        rows = [
            [
                text_of(scan, "id") or "(no id)",
                text_of(scan, "name") or "(unnamed)",
                text_of(scan, "interval") or "-",
                text_of(scan, "time_column") or "-",
                _schedule_of(scan),
            ]
            for scan in project.scans
        ]
        lines.extend(f"  {line}" for line in _columns(rows))
        if not project.scans and not project.errors:
            lines.append("  (no scan configs)")
        for error in project.errors:
            lines.append(_unavailable(error.endpoint or error.section, error.message))
        lines.append("")
    lines.append(
        f"{plural(snapshot.scan_count, 'scan config')} in "
        f"{plural(len(snapshot.projects), 'project')}."
    )
    if snapshot.failed:
        lines.append("Some scan listings could not be read; the list above is incomplete.")
    return "\n".join(lines).rstrip()


def render_scan_jobs(snapshot: ScanJobsSnapshot) -> str:
    lines = [
        f"{snapshot.project} {snapshot.scan_name!r} ({snapshot.scan_id}), "
        f"newest {plural(snapshot.limit, 'job')} requested:"
    ]
    rows = [
        [
            text_of(job, "id") or "(no id)",
            text_of(job, "status") or "unknown",
            f"created {text_of(job, 'created_at') or '-'}",
            f"finished {text_of(job, 'completed_at') or '-'}",
            text_of(job, "error_message") or "",
        ]
        for job in snapshot.jobs
    ]
    lines.extend(f"  {line}" for line in _columns(rows))
    if not snapshot.jobs:
        lines.append("  (no jobs)")
    lines.append("")
    lines.append(f"{plural(len(snapshot.jobs), 'job')}.")
    return "\n".join(lines).rstrip()


def _drift_when(drift: dict[str, object]) -> str:
    """The timestamp that matters for this drift's state.

    For a snooze that is when it LAPSES, because that is the date the operator
    acts on; for everything else it is when the drift was detected. Kept out of
    the status column deliberately: an expiry there would pad every ``open`` row
    to the width of a timestamp.
    """
    if text_of(drift, "status") == "snoozed":
        until = text_of(drift, "snoozed_until")
        return f"until {until}" if until else "snooze has no expiry"
    return f"detected {text_of(drift, 'detected_at') or '-'}"


def render_drifts(snapshot: DriftsSnapshot) -> str:
    lines: list[str] = []
    if not snapshot.projects:
        lines.append("No projects selected.")
    for project in snapshot.projects:
        demo = " [demo]" if project.is_demo else ""
        lines.append(f"{project.slug} ({project.name}){demo}")
        rows = [
            [
                text_of(row.drift, "id") or "(no id)",
                f"{row.event_type_name}.{text_of(row.drift, 'field_name') or '(unnamed)'}",
                text_of(row.drift, "drift_type") or "unknown",
                text_of(row.drift, "status") or "unknown",
                _drift_when(row.drift),
            ]
            for row in project.drifts
        ]
        lines.extend(f"  {line}" for line in _columns(rows))
        if not project.drifts and not project.errors:
            lines.append("  (no drifts)")
        for error in project.errors:
            lines.append(_unavailable(error.endpoint or error.section, error.message))
        if project.truncated:
            lines.append(
                f"  {project.event_types_examined} of "
                f"{plural(project.event_types_total, 'event type')} examined; raise "
                "--max-event-types to look at the rest."
            )
        lines.append("")
    lines.append(
        f"{plural(snapshot.drift_count, 'drift')} in "
        f"{plural(len(snapshot.projects), 'project')}, "
        f"{snapshot.untriaged_count} untriaged."
    )
    if snapshot.failed:
        # Counted and named, because a shorter list at exit 0 is exactly the
        # failure this command was written to stop reproducing.
        lines.append(
            f"{plural(snapshot.error_count, 'read')} failed; the list above is incomplete."
        )
    return "\n".join(lines).rstrip()


def render_mutation(outcome: MutationOutcome) -> str:
    """One line for what happened, plus the next command worth typing."""
    where = f"{outcome.project} {outcome.scan_name!r} ({outcome.scan_id})"
    if outcome.dry_run:
        request = outcome.request
        return (
            f"dry run: would send {request['method']} {request['path']}"
            f" with body {request['body']!r}\nNothing was sent."
        )
    result = outcome.result or {}
    if outcome.command == "scans run":
        job_id = text_of(result, "id") or "(no id)"
        status = text_of(result, "status") or "unknown"
        return (
            f"{where}: started job {job_id} ({status}).\n"
            f"Follow it with: tripl watch --project {outcome.project} "
            f"--scan {outcome.scan_name!r}"
        )
    if outcome.command == "scans cancel":
        status = text_of(result, "status") or "unknown"
        return f"{where}: job {outcome.job_id} is now {status}."
    field = text_of(result, "field_name") or "(unnamed)"
    drift_type = text_of(result, "drift_type") or "unknown"
    status = text_of(result, "status") or "unknown"
    return f"{outcome.project}: drift {outcome.drift_id} ({field}, {drift_type}) is now {status}."

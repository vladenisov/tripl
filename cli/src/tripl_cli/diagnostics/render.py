"""Human output. ASCII only, and byte-identical whether stdout is a TTY or a pipe.

No colour, no spinners, no cursor control, no emoji, no unicode glyphs. That is
not minimalism for its own sake: `tripl doctor | tee incident.log` and the
terminal view have to be the same artifact, and the logfile an operator pastes
into a ticket must not carry escape codes. A NO_COLOR/isatty branch is pure
polish and can be added later without changing anything here.
"""

from __future__ import annotations

from tripl_cli.diagnostics.model import Check, Report, Severity, StatusSnapshot

_INDENT = " " * 6


def render_header(command: str, base_url: str, source: str) -> str:
    return f"tripl {command} - {base_url} (from {source})"


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

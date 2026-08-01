"""The ``--json`` documents. This module IS the machine-readable contract.

Kept small and greppable on purpose: if a key is not built here it does not
exist, so "what does tripl emit" is answerable by reading one file. That promise
is why the ``scans``/``drifts`` documents live here too rather than beside their
command modules, even though this package is called ``diagnostics`` and they
reach no verdict (tripl-ey6j.5 filed the rename as a follow-up).

STABILITY, within one ``schema_version``:

    Key names are never removed or retyped; ``status`` and ``severity`` values,
    check ``id``s and finding ``code``s are never renamed or repurposed. New
    keys, new check ids and new finding codes may appear in any release without
    a version bump — select by id, never by array index. ``title``, ``summary``
    and ``message`` are prose and may change in any release. ``generated_at``,
    ``duration_ms``, ``requests`` and ``tool_version`` vary per run. Assert on
    ``code`` and ``evidence``. Never assert on prose.

``tripl watch --json`` is JSON LINES rather than one document: one object per
line, flushed as it is produced, because a follow mode that block-buffers into
`jq` shows nothing for minutes and reads as a hang. Every line repeats the whole
envelope. The same stability rule applies to it: within one ``schema_version``
key names are never removed or retyped and event tokens are never renamed or
repurposed; new keys and new tokens may appear in any release. Select by
``event``, never by position. ``message`` is prose — assert on ``event`` and
``data``. ``schema_version`` is SHARED with the doctor and status documents; a
consumer branches on ``command``, never on a per-command version.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from tripl_cli import __version__
from tripl_cli.diagnostics.model import (
    Check,
    DriftsSnapshot,
    Finding,
    Instance,
    JsonDict,
    MutationOutcome,
    Report,
    Run,
    ScanJobsSnapshot,
    ScansSnapshot,
    SectionError,
    StatusSnapshot,
    Target,
    to_rfc3339,
)

if TYPE_CHECKING:
    # Type-only, so the runtime import graph keeps its one direction: watch
    # imports diagnostics, never the reverse. The JSONL builder still lives here
    # because this module is the answer to "what does tripl emit" — a second
    # place to build a document is a second place for it to drift.
    from tripl_cli.watch.model import WatchEvent

SCHEMA_VERSION = 1
TOOL_NAME = "tripl"

# The three JSONL line classes. Load-bearing: a consumer counting incidents must
# not count the CLI's own transport trouble, and a consumer measuring how much of
# the window watch was blind for needs `diagnostic` isolated and countable.
WATCH_STREAM_META = "meta"
WATCH_STREAM_EVENT = "event"
WATCH_STREAM_DIAGNOSTIC = "diagnostic"


def _instance_document(instance: Instance) -> JsonDict:
    return {
        "base_url": instance.base_url,
        # Verbatim from Config.sources — "$TRIPL_BASE_URL", "--url", or the path
        # of the config file. "Why is it talking to THAT instance" was a week of
        # the 2026-07-28..31 incident.
        "base_url_source": instance.base_url_source,
        "api_key_source": instance.api_key_source,
        "api_key_scope": instance.api_key_scope,
    }


def _envelope(
    command: str,
    instance: Instance,
    generated_at: str,
    duration_ms: int,
    requests: int,
) -> JsonDict:
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_NAME,
        "tool_version": __version__,
        "command": command,
        "generated_at": generated_at,
        "duration_ms": duration_ms,
        "requests": requests,
        "instance": _instance_document(instance),
    }


def _run_envelope(command: str, run: Run) -> JsonDict:
    return _envelope(
        command, run.instance, to_rfc3339(run.generated_at), run.duration_ms, run.requests
    )


def _error_document(error: SectionError) -> JsonDict:
    return {
        "section": error.section,
        # The CONCRETE path that failed, not its template: an operator following
        # six projects cannot act on a message that does not say which one.
        "endpoint": error.endpoint,
        "status_code": error.status_code,
        "message": error.message,
    }


def _target_document(target: Target | None) -> JsonDict | None:
    if target is None:
        return None
    return {"kind": target.kind, "id": target.id, "name": target.name}


def _finding_document(finding: Finding) -> JsonDict:
    return {
        "code": finding.code,
        "severity": finding.severity.value,
        "project": finding.project,
        "target": _target_document(finding.target),
        "message": finding.message,
        "evidence": dict(finding.evidence),
    }


def _check_document(check: Check) -> JsonDict:
    return {
        "id": check.id,
        "title": check.title,
        "status": check.status.value,
        "summary": check.summary,
        # Non-null if and only if status == "skip".
        "skip_reason": check.skip_reason,
        "findings": [_finding_document(finding) for finding in check.findings],
    }


def doctor_document(report: Report, *, exit_code: int) -> JsonDict:
    document = _envelope(
        report.command,
        report.instance,
        to_rfc3339(report.generated_at),
        report.duration_ms,
        report.requests,
    )
    document["status"] = report.status.value
    # Echoes the process exit code so a consumer reading only the document knows
    # what the shell saw.
    document["exit_code"] = exit_code
    document["summary"] = report.counts
    document["checks"] = [_check_document(check) for check in report.checks]
    return document


def watch_line(event: WatchEvent, *, seq: int) -> JsonDict:
    """One JSON Lines record. Every key present on every line, without exception.

    ``seq`` is monotonic from 1 within a run and never reused, so a consumer can
    detect truncation and undo a log shipper's reordering. ``time`` is when watch
    OBSERVED the change, not when it happened — every domain timestamp is a
    separately named field inside ``data``.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_NAME,
        "tool_version": __version__,
        "command": "watch",
        "stream": event.stream,
        "seq": seq,
        "time": to_rfc3339(event.time),
        "event": event.event,
        "project": event.project,
        "target": _target_document(event.target),
        "message": event.message,
        "data": dict(event.data),
    }


def status_document(snapshot: StatusSnapshot) -> JsonDict:
    document = _envelope(
        "status",
        snapshot.instance,
        to_rfc3339(snapshot.generated_at),
        snapshot.duration_ms,
        snapshot.requests,
    )
    projects: list[JsonDict] = []
    for project in snapshot.projects:
        coverage: dict[str, Any] | None = None
        if project.coverage is not None:
            coverage = {
                "days": project.coverage.days,
                "pct": project.coverage.pct,
                "matched": project.coverage.matched,
                "total": project.coverage.total,
            }
        projects.append(
            {
                "slug": project.slug,
                "name": project.name,
                "is_demo": project.is_demo,
                "events": {
                    "total": project.event_count,
                    "active": project.active_event_count,
                    "event_types": project.event_type_count,
                },
                "scans": {"total": project.scan_count, "failing": project.failing_scan_count},
                # ProjectResponse.summary.monitoring_signal_count — the backend's
                # own significant open-signal count, so this number equals the
                # app's sidebar badge by construction rather than by a second
                # copy of SIGNIFICANT_MIN_REL_EFFECT (TRAP 2).
                "signals": {"significant_open": project.significant_open_signals},
                "monitors": {"firing": project.firing_monitors},
                "coverage": coverage,
                "errors": [
                    {
                        "section": error.section,
                        "status_code": error.status_code,
                        "message": error.message,
                    }
                    for error in project.errors
                ],
            }
        )
    document["projects"] = projects
    return document


def scans_document(snapshot: ScansSnapshot) -> JsonDict:
    """``tripl scans list``. One document, never JSON Lines — it terminates."""
    document = _run_envelope("scans list", snapshot.run)
    document["projects"] = [
        {
            "slug": project.slug,
            "name": project.name,
            "is_demo": project.is_demo,
            # api.scans.scan_config_summary output: the listed fields plus the
            # derived `dispatchable`. base_query and the tuning knobs are gone.
            "scans": [dict(scan) for scan in project.scans],
            "errors": [_error_document(error) for error in project.errors],
        }
        for project in snapshot.projects
    ]
    return document


def scan_jobs_document(snapshot: ScanJobsSnapshot) -> JsonDict:
    """``tripl scans jobs``. ScanJobResponse rows verbatim, newest first.

    Not trimmed: ``result_summary`` carries the replay chunk progress and
    ``error_message`` is the whole answer to "why did it fail".
    """
    document = _run_envelope("scans jobs", snapshot.run)
    document["project"] = snapshot.project
    document["scan"] = {"id": snapshot.scan_id, "name": snapshot.scan_name}
    document["limit"] = snapshot.limit
    document["jobs"] = [dict(job) for job in snapshot.jobs]
    return document


def drifts_document(snapshot: DriftsSnapshot) -> JsonDict:
    """``tripl drifts list``.

    ``event_types_examined`` versus ``event_types_total`` is per project on
    purpose: the budget is spent round-robin, so one instance-wide ratio would
    name no project — and "we did not look there" is only useful when it says
    where (tripl-ey6j.9).
    """
    document = _run_envelope("drifts list", snapshot.run)
    document["status_filter"] = snapshot.status_filter
    document["projects"] = [
        {
            "slug": project.slug,
            "name": project.name,
            "is_demo": project.is_demo,
            "event_types_total": project.event_types_total,
            "event_types_examined": project.event_types_examined,
            "truncated": project.truncated,
            "drifts": [
                {
                    # SchemaDriftResponse verbatim — all fourteen fields are
                    # triage material — plus the two facts it cannot carry.
                    **dict(row.drift),
                    "event_type_name": row.event_type_name,
                    "untriaged": row.untriaged,
                }
                for row in project.drifts
            ],
            "errors": [_error_document(error) for error in project.errors],
        }
        for project in snapshot.projects
    ]
    return document


def mutation_document(outcome: MutationOutcome) -> JsonDict:
    """``tripl scans run|cancel`` and ``tripl drifts dismiss``.

    ``request`` is what WOULD be or WAS sent, method/path/params/body only. Every
    per-command key is present on every mutation, null where it does not apply.
    """
    document = _run_envelope(outcome.command, outcome.run)
    document["dry_run"] = outcome.dry_run
    document["request"] = dict(outcome.request)
    document["project"] = outcome.project
    document["scan"] = (
        None if outcome.scan_id is None else {"id": outcome.scan_id, "name": outcome.scan_name}
    )
    document["job_id"] = outcome.job_id
    document["drift_id"] = outcome.drift_id
    document["action"] = outcome.action
    # Null under --dry-run, always: nothing was sent, so there is no result and
    # a consumer must not be able to read one.
    document["result"] = None if outcome.result is None else dict(outcome.result)
    return document

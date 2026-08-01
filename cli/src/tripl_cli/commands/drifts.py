"""``tripl drifts`` — list schema drifts, and dismiss one.

Two facts shape this whole module:

* THERE IS NO PROJECT-LEVEL DRIFT ROUTE. A project's drifts are a fan-out over
  its event types, spent under a budget, and probing an invented
  ``/projects/{slug}/schema-drifts`` returns 404 — which a naive harness reads as
  "no drifts". So a failed target here is a printed ``unavailable`` line, an
  ``errors[]`` entry and exit 1, never a shorter list at exit 0 (TRAP 3).
* ``accept`` IS NOT EXPOSED, in any form. On a ``missing_field`` drift it reaches
  ``schema_drift_service._apply_acceptance_to_plan``, which DELETES the
  FieldDefinition — the exact damage ``doctor``'s ``schema_field_deleted_by_accept``
  finding exists to report. The tool that reports it must not be the easiest way
  to cause it. ``dismiss`` sends ``false_positive`` or ``snooze``; accepting and
  reopening stay in the tripl UI (tripl-ey6j.5).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime

import httpx

from tripl_cli.api import event_types as event_types_api
from tripl_cli.api.request import ApiRequest
from tripl_cli.commands import bounded_datetime, bounded_float, bounded_int, group_help
from tripl_cli.commands._write import (
    add_write_flags,
    confirm,
    request_document,
    require_single_project,
)
from tripl_cli.config import Config, require_base_url
from tripl_cli.diagnostics.collect import (
    DEFAULT_MAX_EVENT_TYPES,
    Reader,
    instance_of,
    raise_selection_failure,
)
from tripl_cli.diagnostics.collect import select_projects as select
from tripl_cli.diagnostics.model import (
    DriftRow,
    DriftsSnapshot,
    Fetched,
    JsonDict,
    JsonList,
    MutationOutcome,
    ProjectDrifts,
    Run,
    SectionError,
    as_dict,
    text_of,
)
from tripl_cli.diagnostics.render import render_drifts, render_header, render_mutation
from tripl_cli.diagnostics.report import drifts_document, mutation_document
from tripl_cli.errors import EXIT_FAILURE, EXIT_OK
from tripl_cli.runner import REQUEST_TIMEOUT_SECONDS, gather_bounded, run_async

# The default, and the reason the flag exists: a drift is interesting when
# nobody has looked at it. `all` is one flag away for an audit.
STATUS_UNTRIAGED = "untriaged"
STATUS_ALL = "all"
STATUS_CHOICES: tuple[str, ...] = (
    *event_types_api.DRIFT_STATUSES,
    STATUS_UNTRIAGED,
    STATUS_ALL,
)


def register(
    subparsers: argparse._SubParsersAction[argparse.ArgumentParser],
    parent: argparse.ArgumentParser,
) -> None:
    parser = subparsers.add_parser(
        "drifts",
        parents=[parent],
        help="list and dismiss schema drifts",
        description=(
            "Schema drift between a tracking plan and what the warehouse actually carries. "
            "Listing needs a tk_r_ key; dismissing needs a tk_w_ key backed by an editor or "
            "owner. Accepting a drift is NOT available here - on a missing_field drift it "
            "deletes the field definition, so that decision stays in the tripl UI."
        ),
    )
    verbs = parser.add_subparsers(dest="drifts_command", metavar="<verb>")
    _register_list(verbs, parent)
    _register_dismiss(verbs, parent)
    parser.set_defaults(handler=group_help(parser))


def _add_json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="print one JSON document on stdout and every human line on stderr",
    )


def _add_timeout(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--timeout",
        dest="timeout",
        metavar="SECONDS",
        type=bounded_float("--timeout", 0.1, 600.0),
        default=REQUEST_TIMEOUT_SECONDS,
        help=f"per-request timeout in seconds (default: {REQUEST_TIMEOUT_SECONDS})",
    )


def _register_list(
    verbs: argparse._SubParsersAction[argparse.ArgumentParser],
    parent: argparse.ArgumentParser,
) -> None:
    parser = verbs.add_parser(
        "list",
        parents=[parent],
        help="list schema drifts across projects",
        description=(
            "List schema drifts, one request per event type under --max-event-types, spent "
            "round-robin across projects so no project is starved of the budget. An event "
            "type whose drifts could not be read is REPORTED and exits 1 - it is never "
            "rendered as having none."
        ),
    )
    parser.add_argument(
        "--project",
        dest="project",
        metavar="SLUG",
        action="append",
        help="list only this project (repeatable)",
    )
    parser.add_argument(
        "--include-demo",
        dest="include_demo",
        action="store_true",
        help="also list demo projects, which are excluded by default",
    )
    parser.add_argument(
        "--status",
        dest="status",
        metavar="STATUS",
        choices=STATUS_CHOICES,
        default=STATUS_UNTRIAGED,
        help=(
            f"which drifts to keep: {'|'.join(STATUS_CHOICES)} "
            f"(default: {STATUS_UNTRIAGED} = open, or snoozed past its snooze). "
            "Filtered client-side; the API has no such parameter."
        ),
    )
    parser.add_argument(
        "--max-event-types",
        dest="max_event_types",
        metavar="N",
        type=bounded_int("--max-event-types", 1, 10_000),
        default=DEFAULT_MAX_EVENT_TYPES,
        help=(
            "how many event types to read drifts for, across the whole run "
            f"(default: {DEFAULT_MAX_EVENT_TYPES}); the rest are reported as unexamined"
        ),
    )
    _add_json(parser)
    _add_timeout(parser)
    parser.set_defaults(handler=run_list)


def _register_dismiss(
    verbs: argparse._SubParsersAction[argparse.ArgumentParser],
    parent: argparse.ArgumentParser,
) -> None:
    parser = verbs.add_parser(
        "dismiss",
        parents=[parent],
        help="mark a drift false_positive, or snooze it (needs a tk_w_ key)",
        description=(
            "Take a drift out of the untriaged pile. Sends false_positive by default, or "
            "snooze with --snooze-until. Needs a tk_w_ key backed by an editor or owner. "
            "Prompts, because it hides a finding from `tripl doctor`; --yes skips the prompt "
            "and is REQUIRED when stdin is not a terminal. Accepting a drift is not offered "
            "here - do it in the tripl UI."
        ),
    )
    parser.add_argument("drift_id", metavar="<drift-id>", help="the drift to dismiss")
    parser.add_argument(
        "--project", dest="project", metavar="SLUG", action="append", help="project slug (required)"
    )
    parser.add_argument(
        "--snooze-until",
        dest="snooze_until",
        metavar="TS",
        type=bounded_datetime("--snooze-until"),
        help=(
            "snooze until this RFC-3339 moment instead of marking it a false positive; "
            "a drift snoozed past its snooze counts as untriaged again"
        ),
    )
    parser.add_argument(
        "--note",
        dest="note",
        metavar="TEXT",
        help="resolution note stored with the drift (max 2000 characters)",
    )
    add_write_flags(parser, prompts=True)
    _add_json(parser)
    _add_timeout(parser)
    parser.set_defaults(handler=run_dismiss)


def _keep(drift: JsonDict, *, status_filter: str, untriaged: bool) -> bool:
    if status_filter == STATUS_ALL:
        return True
    if status_filter == STATUS_UNTRIAGED:
        return untriaged
    return text_of(drift, "status") == status_filter


def _project_drifts(
    project: JsonDict,
    slug: str,
    *,
    types: Fetched[JsonList],
    drifts: dict[tuple[str, str], Fetched[JsonDict]],
    examined: int,
    total: int,
    status_filter: str,
    now: datetime,
) -> ProjectDrifts:
    """Assemble one project's rows. Every failed read becomes an error, not a gap."""
    errors: list[SectionError] = []
    rows: list[DriftRow] = []
    if not types.ok or types.value is None:
        errors.append(
            SectionError(
                section="event_types",
                endpoint=event_types_api.LIST.format(slug=slug),
                status_code=types.status_code,
                message=types.error or "the tripl API did not answer",
            )
        )
        return ProjectDrifts(
            slug=slug,
            name=text_of(project, "name") or slug,
            is_demo=bool(project.get("is_demo")),
            errors=tuple(errors),
        )
    for event_type in types.value:
        type_id = text_of(event_type, "id")
        if type_id is None:
            continue
        fetched = drifts.get((slug, type_id))
        if fetched is None:
            continue  # outside the budget; reported as truncation, not as an error
        if not fetched.ok or fetched.value is None:
            errors.append(
                SectionError(
                    section="drifts",
                    endpoint=event_types_api.DRIFTS.format(slug=slug, event_type_id=type_id),
                    status_code=fetched.status_code,
                    message=fetched.error or "the tripl API did not answer",
                )
            )
            continue
        type_name = text_of(event_type, "name") or type_id
        for drift in event_types_api.drift_items(fetched.value):
            untriaged = event_types_api.is_untriaged(drift, now)
            if _keep(drift, status_filter=status_filter, untriaged=untriaged):
                rows.append(DriftRow(drift=drift, event_type_name=type_name, untriaged=untriaged))
    return ProjectDrifts(
        slug=slug,
        name=text_of(project, "name") or slug,
        is_demo=bool(project.get("is_demo")),
        event_types_total=total,
        event_types_examined=examined,
        drifts=tuple(rows),
        errors=tuple(errors),
    )


def run_list(args: argparse.Namespace, config: Config) -> int:
    slugs: tuple[str, ...] = tuple(args.project or ())
    as_json: bool = bool(args.as_json)
    include_demo: bool = bool(args.include_demo)
    status_filter: str = str(args.status)
    budget: int = int(args.max_event_types)
    base_url = require_base_url(config)
    human = sys.stderr if as_json else sys.stdout
    started = time.monotonic()
    generated_at = datetime.now(UTC)

    async def body(client: httpx.AsyncClient) -> tuple[Reader, tuple[ProjectDrifts, ...]]:
        reader = Reader(client, base_url)
        selection = await select(reader, slugs=slugs, include_demo=include_demo, scope="unknown")
        raise_selection_failure(selection)
        projects = selection.projects
        found = [text_of(project, "slug") or "" for project in projects]
        type_reads = await gather_bounded(
            [reader.try_read_list(event_types_api.list_event_types(slug)) for slug in found]
        )
        types_by_slug = dict(zip(found, type_reads, strict=True))
        # The SAME plan doctor uses, from the same function: two implementations
        # of a budgeted fan-out is how "we did not look there" starts printing as
        # "nothing there" (tripl-ey6j.5).
        targets, examined, totals = event_types_api.plan_drift_targets(
            {slug: types_by_slug[slug].value or [] for slug in found}, budget=budget
        )
        drift_reads = await gather_bounded(
            [
                reader.try_read_dict(event_types_api.list_drifts(slug, type_id))
                for slug, type_id in targets
            ]
        )
        drifts = dict(zip(targets, drift_reads, strict=True))
        now = datetime.now(UTC)
        return reader, tuple(
            _project_drifts(
                project,
                slug,
                types=types_by_slug[slug],
                drifts=drifts,
                examined=examined.get(slug, 0),
                total=totals.get(slug, 0),
                status_filter=status_filter,
                now=now,
            )
            for project, slug in zip(projects, found, strict=True)
        )

    reader, projects = run_async(config, body, timeout=float(args.timeout))
    snapshot = DriftsSnapshot(
        run=Run(
            instance=instance_of(config, base_url, "unknown"),
            generated_at=generated_at,
            duration_ms=int((time.monotonic() - started) * 1000),
            requests=reader.requests,
        ),
        status_filter=status_filter,
        projects=projects,
    )

    print(
        render_header("drifts list", base_url, config.sources.get("base_url", "unknown")),
        file=human,
    )
    print(file=human)
    print(render_drifts(snapshot), file=human)
    if as_json:
        json.dump(drifts_document(snapshot), sys.stdout)
        sys.stdout.write("\n")
    # A partial list that exits 0 is the trap. One unreadable event type means
    # the answer is "I do not know", not "there are none".
    return EXIT_FAILURE if snapshot.failed else EXIT_OK


def run_dismiss(args: argparse.Namespace, config: Config) -> int:
    slug = require_single_project(args)
    drift_id: str = str(args.drift_id)
    snooze_until: datetime | None = args.snooze_until
    note: str | None = args.note
    as_json: bool = bool(args.as_json)
    dry_run: bool = bool(args.dry_run)
    assume_yes: bool = bool(args.assume_yes)
    base_url = require_base_url(config)
    started = time.monotonic()
    generated_at = datetime.now(UTC)

    # `snooze` or `false_positive`, and NEVER `accept` - there is no flag that
    # reaches it, which is the point (see the module docstring).
    action = "snooze" if snooze_until is not None else "false_positive"
    request: ApiRequest = event_types_api.apply_drift_action(
        slug, drift_id, action=action, note=note, snoozed_until=snooze_until
    )

    async def body(client: httpx.AsyncClient) -> tuple[Reader, JsonDict | None]:
        reader = Reader(client, base_url)
        if dry_run:
            return reader, None
        # Prompting inside the async body rather than before it: the alternative
        # is a second run_async, which would open a second connection pool.
        confirm(
            f"Mark drift {drift_id} of {slug} as {action}? "
            "It stops appearing in `tripl doctor`'s untriaged count.",
            assume_yes=assume_yes,
        )
        return reader, as_dict(await reader.send(request))

    reader, result = run_async(config, body, timeout=float(args.timeout))
    outcome = MutationOutcome(
        command="drifts dismiss",
        run=Run(
            instance=instance_of(config, base_url, "unknown"),
            generated_at=generated_at,
            duration_ms=int((time.monotonic() - started) * 1000),
            requests=reader.requests,
        ),
        request=request_document(request),
        project=slug,
        dry_run=dry_run,
        drift_id=drift_id,
        action=action,
        result=result,
    )
    human = sys.stderr if as_json else sys.stdout
    print(
        render_header("drifts dismiss", base_url, config.sources.get("base_url", "unknown")),
        file=human,
    )
    print(file=human)
    print(render_mutation(outcome), file=human)
    if as_json:
        json.dump(mutation_document(outcome), sys.stdout)
        sys.stdout.write("\n")
    return EXIT_OK

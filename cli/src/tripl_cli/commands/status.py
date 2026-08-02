"""``tripl status`` — the quick view: projects, events, scans, signals, coverage.

Deliberately not a verdict. status always exits 0 when it completed, however bad
the numbers are: a daily digest that returns non-zero is a cron job somebody
disables. ``tripl doctor`` is the command with an exit contract.

Every count comes from ``ProjectResponse.summary``, computed server-side — see
``collect.collect_status`` for why that is load-bearing rather than lazy.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from datetime import UTC, datetime

import httpx

from tripl_cli.commands import add_json, add_project, add_timeout, bounded_int
from tripl_cli.config import Config, require_base_url
from tripl_cli.diagnostics.collect import DEFAULT_COVERAGE_DAYS, StatusOptions, collect_status
from tripl_cli.errors import EXIT_OK
from tripl_cli.model import StatusSnapshot
from tripl_cli.render import render_header, render_status
from tripl_cli.report import status_document
from tripl_cli.runner import run_async

# The API's own default is 14 with a cap of 180. A week is the window an
# operator actually reasons about on a morning check, and --days covers the rest.
MAX_COVERAGE_DAYS = 180


def register(
    subparsers: argparse._SubParsersAction[argparse.ArgumentParser],
    parent: argparse.ArgumentParser,
) -> None:
    parser = subparsers.add_parser(
        "status",
        parents=[parent],
        help="print a short live view of an instance's projects",
        description=(
            "A read-only snapshot of every project: event counts, scan configs, open "
            "significant signals, firing monitors and reconciliation coverage. Always exits 0 "
            "when it completed - use `tripl doctor` when you want a verdict."
        ),
    )
    add_project(parser, single=False, verb="report")
    parser.add_argument(
        "--include-demo",
        dest="include_demo",
        action="store_true",
        help="also report demo projects, which are excluded by default",
    )
    add_json(parser)
    parser.add_argument(
        "--days",
        dest="days",
        metavar="N",
        type=bounded_int("--days", 1, MAX_COVERAGE_DAYS),
        default=DEFAULT_COVERAGE_DAYS,
        help=f"reconciliation coverage window in days (default: {DEFAULT_COVERAGE_DAYS})",
    )
    add_timeout(parser)
    parser.set_defaults(handler=run)


def run(args: argparse.Namespace, config: Config) -> int:
    slugs: tuple[str, ...] = tuple(args.project or ())
    as_json: bool = bool(args.as_json)
    options = StatusOptions(
        project_slugs=slugs,
        include_demo=bool(args.include_demo),
        days=int(args.days),
    )
    base_url = require_base_url(config)
    human = sys.stderr if as_json else sys.stdout
    started = time.monotonic()
    generated_at = datetime.now(UTC)

    async def body(client: httpx.AsyncClient) -> StatusSnapshot:
        return await collect_status(
            client, config, options, base_url=base_url, generated_at=generated_at
        )

    # No Fetched wrapping around the project read: a TriplError propagates to
    # main() and exits 1. status has no verdict contract, so "the instance is
    # unreachable" is an ordinary command failure here rather than a finding.
    snapshot = dataclasses.replace(
        run_async(config, body, timeout=float(args.timeout)),
        duration_ms=int((time.monotonic() - started) * 1000),
    )

    print(render_header("status", base_url, config.sources.get("base_url", "unknown")), file=human)
    print(file=human)
    print(render_status(snapshot), file=human)

    if as_json:
        json.dump(status_document(snapshot), sys.stdout)
        sys.stdout.write("\n")
    return EXIT_OK

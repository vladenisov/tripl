"""Contract test: every endpoint the diagnostics read must exist in the API.

The sibling package that shares this very client already has one
(``mcp-server/tests/test_contract.py``), so before this a backend route rename
broke tripl-mcp's CI loudly and ``tripl doctor`` silently - the CLI would simply
start reporting 404s as instance faults, which is the one failure mode a
diagnostic tool must not have.

Reads the committed snapshot rather than importing the backend: the cli package
has no backend dependency, and CI runs its job from ``cli/`` with the whole
repository checked out.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

import tripl_cli
from tripl_cli.api.endpoints import ALL_TEMPLATES, SHARED_ENDPOINTS
from tripl_cli.client import API_PREFIX
from tripl_cli.diagnostics import checks, collect, scan_checks
from tripl_cli.diagnostics.endpoints import (
    DOCTOR_ENDPOINTS,
    DRIFTS_ENDPOINTS,
    SCANS_ENDPOINTS,
    STATUS_ENDPOINTS,
    WATCH_ENDPOINTS,
)
from tripl_cli.watch import collect as watch_collect

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENAPI_PATH = REPO_ROOT / "backend" / "openapi.json"
DOCS_PATH = REPO_ROOT / "website" / "docs" / "run" / "cli.md"
COLLECT_SOURCES = (Path(collect.__file__), Path(watch_collect.__file__))
RULE_SOURCES = (Path(checks.__file__), Path(scan_checks.__file__))

# Both packages, because the request layer is shared and a rule that applied to
# only one of them could not be checked mechanically (tripl-ey6j.5). mcp-server
# keeps its own half of this test too, so its job fails on its own.
CLI_PACKAGE = Path(tripl_cli.__file__).parent
MCP_PACKAGE = REPO_ROOT / "mcp-server" / "src" / "tripl_mcp"
SHARED_LAYER = CLI_PACKAGE / "api"

DECLARED = {
    **DOCTOR_ENDPOINTS,
    **STATUS_ENDPOINTS,
    **WATCH_ENDPOINTS,
    **SCANS_ENDPOINTS,
    **DRIFTS_ENDPOINTS,
}

# Path literals as they appear in the calls: "/x" or f"/x/{slug}/y".
PATH_LITERAL = re.compile(r'f?"(/(?:projects|auth|data-sources)[^"]*)"')
# The f-string placeholder names some call sites use, mapped to the backend's
# own, which is what the declaration and the OpenAPI document both use.
PLACEHOLDER_RENAMES = {"{type_id}": "{event_type_id}", "{config_id}": "{scan_id}"}


def _path_literals(root: Path) -> dict[str, list[str]]:
    """Every REST path literal under ``root``, normalised, keyed by path."""
    found: dict[str, list[str]] = {}
    for source in sorted(root.rglob("*.py")):
        for raw in PATH_LITERAL.findall(source.read_text(encoding="utf-8")):
            path = raw
            for actual, declared in PLACEHOLDER_RENAMES.items():
                path = path.replace(actual, declared)
            found.setdefault(path, []).append(str(source.relative_to(root)))
    return found


def _raised_finding_codes() -> set[str]:
    """Every literal ``code=`` on a ``Finding(...)`` in the rule modules."""
    found: set[str] = set()
    for path in RULE_SOURCES:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "Finding"):
                continue
            for keyword in node.keywords:
                if keyword.arg == "code" and isinstance(keyword.value, ast.Constant):
                    found.add(keyword.value.value)
    return found


@pytest.fixture(scope="module")
def openapi_paths() -> dict[str, Any]:
    assert OPENAPI_PATH.exists(), (
        f"Committed OpenAPI snapshot missing at {OPENAPI_PATH}; the contract test cannot run."
    )
    return dict(json.loads(OPENAPI_PATH.read_text())["paths"])


def test_every_endpoint_read_exists_in_openapi(openapi_paths: dict[str, Any]) -> None:
    missing: list[str] = []
    for section, endpoints in DECLARED.items():
        for method, path in endpoints:
            operations = openapi_paths.get(f"{API_PREFIX}{path}")
            if operations is None or method not in operations:
                missing.append(f"{section}: {method.upper()} {API_PREFIX}{path}")
    assert not missing, (
        "tripl doctor/status/watch read endpoints that are no longer in backend/openapi.json "
        "(REST contract drift!):\n  " + "\n  ".join(missing)
    )


def test_every_path_in_collect_is_declared() -> None:
    """The declaration cannot go stale behind a newly added read.

    Scans the source for request-path literals, because the alternative - trusting
    that whoever adds a call also adds it here - is exactly the discipline this
    file exists to replace. Both collectors are scanned: watch has its own,
    deliberately, so a change to the follow loop cannot escape the contract.
    """
    source = "\n".join(path.read_text(encoding="utf-8") for path in COLLECT_SOURCES)
    found = set(PATH_LITERAL.findall(source))
    normalised = set()
    for path in found:
        for actual, declared in PLACEHOLDER_RENAMES.items():
            path = path.replace(actual, declared)
        normalised.add(path)
    declared_paths = {path for endpoints in DECLARED.values() for _, path in endpoints}
    undeclared = normalised - declared_paths
    assert not undeclared, (
        "a collect module reads paths that endpoints.py does not declare, so the contract "
        f"test cannot see them: {sorted(undeclared)}"
    )


def test_every_shared_endpoint_exists_in_openapi(openapi_paths: dict[str, Any]) -> None:
    """The shared request layer, checked whole - including the builders no CLI
    command calls, because tripl-mcp calls them and both packages read this map."""
    missing: list[str] = []
    for resource, endpoints in SHARED_ENDPOINTS.items():
        for method, path in endpoints:
            operations = openapi_paths.get(f"{API_PREFIX}{path}")
            if operations is None or method not in operations:
                missing.append(f"{resource}: {method.upper()} {API_PREFIX}{path}")
    assert not missing, (
        "tripl_cli.api declares endpoints that are no longer in backend/openapi.json "
        "(REST contract drift!):\n  " + "\n  ".join(missing)
    )


def test_no_rest_path_literal_lives_outside_the_shared_layer() -> None:
    """A module cannot spell a path the shared layer does not declare.

    Scans BOTH packages: this is one half of the acceptance criterion of
    tripl-ey6j.5 ("no request-building logic is duplicated between the CLI and
    the MCP tools") turned into something CI can check. Literals in finding
    messages and evidence keys pass, because they are the same templates - what
    fails is inventing a second spelling anywhere.
    """
    offenders: list[str] = []
    for package, root in (("tripl_cli", CLI_PACKAGE), ("tripl_mcp", MCP_PACKAGE)):
        for path, sources in _path_literals(root).items():
            if path not in ALL_TEMPLATES:
                offenders.append(f"{package}: {path} (in {', '.join(sorted(set(sources)))})")
    assert not offenders, (
        "REST path literals that tripl_cli.api does not declare - add a builder there "
        "rather than a second spelling here:\n  " + "\n  ".join(sorted(offenders))
    )


def test_api_request_is_constructed_only_in_the_shared_layer() -> None:
    """The other half of the acceptance criterion, and the load-bearing one.

    A module that can build an ``ApiRequest`` can build a request; if only
    ``tripl_cli/api`` can, then every request in either distribution came from
    the one place, by construction rather than by review. Do not relax this.
    """
    offenders: list[str] = []
    for package, root in (("tripl_cli", CLI_PACKAGE), ("tripl_mcp", MCP_PACKAGE)):
        for source in sorted(root.rglob("*.py")):
            if source.parent == SHARED_LAYER:
                continue
            tree = ast.parse(source.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "ApiRequest":
                    offenders.append(f"{package}: {source.name}:{node.lineno}")
    assert not offenders, (
        "ApiRequest is constructed outside tripl_cli/api, so a request can be built "
        f"without going through the shared layer: {sorted(offenders)}"
    )


def test_the_shared_layer_is_the_only_thing_both_packages_import_for_requests() -> None:
    """tripl_mcp reaches the API through tripl_cli.api and nothing else.

    A direct ``client.get(...)`` in a tool would slip past both tests above (no
    literal if the path came from a variable, no ApiRequest either), so the
    remaining door is closed here.
    """
    offenders: list[str] = []
    for source in sorted(MCP_PACKAGE.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr in ("get", "post", "patch") and (
                getattr(node.func.value, "id", "") == "client"
            ):
                offenders.append(f"{source.name}:{node.lineno} client.{node.func.attr}(...)")
    assert not offenders, (
        f"an MCP tool calls the client directly instead of sending a shared ApiRequest: {offenders}"
    )


def test_the_sse_stream_is_deliberately_absent_from_the_spec(
    openapi_paths: dict[str, Any],
) -> None:
    """Pins the reason `tripl watch` polls instead of subscribing.

    events_stream.py declares the route `include_in_schema=False`, so this test
    would be unable to protect a watch that used it. If the route ever appears in
    the document, the transport decision recorded in watch/__init__.py should be
    revisited rather than left as folklore - but the decisive fact is the other
    one: replay chunk progress is committed to ScanJob.result_summary with no
    publish_project_event call, so it is invisible on that bus either way.
    """
    assert f"{API_PREFIX}/projects/{{slug}}/events/stream" not in openapi_paths
    assert not any("events/stream" in path for path in openapi_paths)


def test_health_is_deliberately_absent_from_the_spec(openapi_paths: dict[str, Any]) -> None:
    """Pins the reason /health is checked differently from everything else.

    main.py declares it `include_in_schema=False` and outside /api/v1. If it ever
    appears in the document, the special-cased unauthenticated probe in collect.py
    should be reconsidered rather than left as folklore.
    """
    assert "/health" not in openapi_paths
    assert f"{API_PREFIX}/health" not in openapi_paths


def test_every_finding_code_is_documented() -> None:
    """The finding codes are published as a stability contract; hold the docs to it.

    website/docs/run/cli.md carries a table of every code with its evidence keys,
    and an operator writing a cron check selects on those codes. A code that
    ships undocumented is a contract the user cannot rely on, and this is the
    repo's most-repeated review finding (AGENTS.md:467) - so it is a test rather
    than a habit.
    """
    assert DOCS_PATH.exists(), f"the CLI docs page is missing at {DOCS_PATH}"
    documented = set(re.findall(r"`([a-z_]+)`", DOCS_PATH.read_text(encoding="utf-8")))
    raised = _raised_finding_codes()
    assert raised, "the AST scan found no Finding(code=...) at all; the scan itself is broken"
    undocumented = raised - documented
    assert not undocumented, (
        "tripl doctor raises finding codes that website/docs/run/cli.md never mentions: "
        f"{sorted(undocumented)}"
    )


def test_the_documented_job_window_is_the_one_actually_requested() -> None:
    """The docs stated 40 while the code asked for 200, for exactly one review cycle.

    That number is not decoration: it is how far back "how long has this been
    broken" can see, and an operator reading 40 would misjudge every long streak.
    """
    from tripl_cli.diagnostics.model import JOBS_WINDOW

    text = DOCS_PATH.read_text(encoding="utf-8")
    assert f"**{JOBS_WINDOW}** jobs" in text, (
        f"cli.md does not state the real job window of {JOBS_WINDOW}"
    )


def test_every_watch_event_token_is_documented() -> None:
    """The event tokens ARE the watch contract; hold the docs to all of them.

    Same rule as the finding codes, and the same reason: an operator writing a
    `jq` selector picks an `event` value, so a token that ships undocumented is a
    promise the user cannot rely on. The finding-code regex cannot be reused -
    `[a-z_]+` does not match a dotted token - so each one is checked directly.
    """
    from tripl_cli.watch.model import EVENT_TOKENS

    assert DOCS_PATH.exists(), f"the CLI docs page is missing at {DOCS_PATH}"
    text = DOCS_PATH.read_text(encoding="utf-8")
    undocumented = [token for token in EVENT_TOKENS if f"`{token}`" not in text]
    assert not undocumented, (
        f"tripl watch emits event tokens website/docs/run/cli.md never mentions: {undocumented}"
    )


def test_the_documented_watch_job_window_is_the_one_actually_requested() -> None:
    """The 40-vs-200 trap again, on the number that bounds watch's load.

    watch asks for a deliberately SMALLER window than doctor because it repeats;
    a docs page that stated doctor's 200 would misrepresent both the load and how
    many jobs a single poll can notice.
    """
    from tripl_cli.watch.model import WATCH_JOBS_LIMIT

    text = DOCS_PATH.read_text(encoding="utf-8")
    assert f"**{WATCH_JOBS_LIMIT}** jobs" in text, (
        f"cli.md does not state the real watch job window of {WATCH_JOBS_LIMIT}"
    )

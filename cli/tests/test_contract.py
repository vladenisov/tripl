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
DEPLOYMENT_DOCS_PATH = REPO_ROOT / "website" / "docs" / "run" / "deployment.md"

# The only difference between the repository's compose.yaml and the copy
# `tripl install` ships. A literal, so editing compose.yaml fails this test
# loudly instead of silently changing what a fresh install gets. See
# test_the_packaged_compose_matches_the_repo_compose for why it is removed.
MCP_BUILD_BLOCK = """    # Context is the repo root, not ./mcp-server: tripl-mcp builds against the
    # sibling `tripl` package in ./cli, which a mcp-server/ context cannot see
    # (tripl-ey6j.1).
    build:
      context: .
      dockerfile: mcp-server/Dockerfile
"""
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

# Every method that puts bytes on the wire, on an httpx client or on the shared
# TriplClient. Not a hand-picked three: `request` is what `api.request.send`
# itself calls, and `put`/`delete` exist on the API this CLI writes to.
CLIENT_METHODS = frozenset(
    {"request", "send", "stream", "get", "post", "put", "patch", "delete", "head", "options"}
)

# The only places allowed to touch a client outside tripl_cli/api, as
# (package-relative path, enclosing function). ``None`` means the whole module.
# Both are deliberate and both are documented at the call site; adding a third
# entry here is a design decision, not a fix for a failing test.
TRANSPORT_EXEMPTIONS: frozenset[tuple[str, str | None]] = frozenset(
    {
        # It IS the transport: the one TriplClient both distributions share.
        ("client.py", None),
        # The unauthenticated /health probe, which is outside /api/v1 and
        # deliberately carries no Authorization header (see its docstring).
        ("diagnostics/collect.py", "probe_health"),
        # The unauthenticated /auth/status probe. Same regime, and unauthenticated
        # by NECESSITY rather than by choice: `tripl install` reads it on an
        # instance that has no accounts yet, so no API key can exist to send
        # (tripl-ey6j.3). Its path still comes from api.auth.
        ("diagnostics/collect.py", "probe_auth_status"),
    }
)
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


def _is_client_receiver(node: ast.expr) -> bool:
    """Is ``x`` in ``x.get(...)`` a client? Name or attribute, either package.

    Anything spelled ``*client`` (``client``, ``http_client``,
    ``self._http_client``) plus ``api`` / ``_api``, which is what ``Reader``
    calls the ``TriplClient`` it holds.
    """
    if isinstance(node, ast.Name):
        name = node.id
    elif isinstance(node, ast.Attribute):
        name = node.attr
    else:
        return False
    return name.lower().endswith("client") or name.lstrip("_") == "api"


def _enclosing_function(tree: ast.AST, lineno: int) -> str | None:
    """The innermost function containing ``lineno``, so an exemption can be
    scoped to one function rather than to a whole module."""
    best: ast.FunctionDef | ast.AsyncFunctionDef | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        if node.lineno <= lineno <= (node.end_lineno or node.lineno) and (
            best is None or node.lineno > best.lineno
        ):
            best = node
    return best.name if best is not None else None


def _matching_exemption(relative: str, function: str | None) -> tuple[str, str | None] | None:
    for exemption in ((relative, None), (relative, function)):
        if exemption in TRANSPORT_EXEMPTIONS:
            return exemption
    return None


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


def test_nothing_outside_the_shared_layer_calls_a_client_directly() -> None:
    """The remaining door, closed on every method rather than three of them.

    A direct client call slips past both tests above - no path literal if the
    path came from a variable, and no ``ApiRequest`` either - so it has to be
    caught by the call itself. The predecessor of this test checked only
    ``get``/``post``/``patch`` on a receiver literally named ``client``, which
    missed ``request``: the very method ``api.request.send`` calls, and the one
    a copy-paste of it would use. ``delete`` and ``put`` were missing too, and
    the CLI reaches an editor-gated API where both exist.

    Scanned in BOTH packages, because the request layer is shared and a rule
    enforced on only one of them is not a rule.
    """
    offenders: list[str] = []
    honoured: set[tuple[str, str | None]] = set()
    for package, root in (("tripl_cli", CLI_PACKAGE), ("tripl_mcp", MCP_PACKAGE)):
        for source in sorted(root.rglob("*.py")):
            if source.parent == SHARED_LAYER:
                continue  # the shared layer is the one thing allowed to send
            relative = source.relative_to(root).as_posix()
            tree = ast.parse(source.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                    continue
                if node.func.attr not in CLIENT_METHODS:
                    continue
                if not _is_client_receiver(node.func.value):
                    continue
                exemption = _matching_exemption(relative, _enclosing_function(tree, node.lineno))
                if exemption is not None:
                    honoured.add(exemption)
                    continue
                offenders.append(f"{package}: {relative}:{node.lineno} .{node.func.attr}(...)")
    assert not offenders, (
        "a module outside tripl_cli/api calls a client directly instead of sending a shared "
        f"ApiRequest: {sorted(offenders)}"
    )
    # An exemption nobody needs is a hole nobody is watching.
    assert honoured == TRANSPORT_EXEMPTIONS, (
        "a transport exemption in this test no longer matches any call; delete it: "
        f"{sorted(TRANSPORT_EXEMPTIONS - honoured)}"
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


def test_the_documented_scans_and_drifts_numbers_are_the_ones_in_the_code() -> None:
    """The 40-vs-200 trap, applied to the four numbers the new verbs publish.

    Each is a promise an operator plans around: how much history ``scans jobs``
    can show, how far ``--limit`` may be raised, how much of a drift fan-out one
    run covers, and how long any of them waits. The repo already holds the docs
    to the doctor and watch windows for exactly this reason; the same rule now
    covers the command surface that shipped with tripl-ey6j.5.
    """
    from tripl_cli.api.scans import JOBS_LIMIT_MAX
    from tripl_cli.commands.scans import DEFAULT_JOBS_LIMIT
    from tripl_cli.diagnostics.collect import DEFAULT_MAX_EVENT_TYPES
    from tripl_cli.runner import REQUEST_TIMEOUT_SECONDS

    text = DOCS_PATH.read_text(encoding="utf-8")
    missing = [
        phrase
        for phrase in (
            f"How many jobs to ask for, `1`–`{JOBS_LIMIT_MAX}`, default `{DEFAULT_JOBS_LIMIT}`.",
            f"The default of **{DEFAULT_JOBS_LIMIT}** is the API's own default",
            f"Read budget for the fan-out, default `{DEFAULT_MAX_EVENT_TYPES}`",
        )
        if phrase not in text
    ]
    assert not missing, f"cli.md states numbers the code does not: {missing}"

    # Every --timeout row, not just one: six verbs carry it, and a row that
    # drifted would be the one the reader happened to open.
    timeout_rows = [line for line in text.splitlines() if line.startswith("| `--timeout SECONDS`")]
    assert timeout_rows, "cli.md documents no --timeout row at all"
    stale = [row for row in timeout_rows if f"default `{REQUEST_TIMEOUT_SECONDS}`" not in row]
    assert not stale, (
        f"cli.md rows state a --timeout default that is not {REQUEST_TIMEOUT_SECONDS}: {stale}"
    )


def test_the_documented_status_choices_are_exactly_the_ones_the_parser_accepts() -> None:
    """Both directions, because either drift misleads.

    A choice the parser accepts and the page omits is a capability nobody finds;
    a choice the page lists and the parser rejects is an exit 2 in somebody's
    cron. ``untriaged`` and ``all`` are this CLI's own additions to the API's
    four statuses, which is precisely the kind of thing that gets added to a
    parser and not to a page.
    """
    from tripl_cli.commands.drifts import STATUS_CHOICES

    rows = [
        line
        for line in DOCS_PATH.read_text(encoding="utf-8").splitlines()
        if line.startswith("| `--status STATUS`")
    ]
    assert len(rows) == 1, f"expected exactly one --status row in cli.md, found {len(rows)}"
    documented = set(re.findall(r"`([a-z_]+)`", rows[0]))
    assert documented == set(STATUS_CHOICES), (
        "cli.md's --status row and drifts.STATUS_CHOICES disagree: "
        f"only documented {sorted(documented - set(STATUS_CHOICES))}, "
        f"only in the code {sorted(set(STATUS_CHOICES) - documented)}"
    )


def test_the_packaged_compose_matches_the_repo_compose() -> None:
    """The generated stack IS the production stack, minus one documented block.

    `tripl install` copies a packaged asset rather than templating YAML, so the
    only way that asset can drift from the stack this repository actually
    deploys is if somebody edits one and not the other. This is that check, and
    the fix when it fails is to re-copy - which is exactly the review
    conversation we want (tripl-ey6j.3).

    The one transform: the `mcp` service's `build:` block is removed. A fresh
    machine has no source tree, so `context: .` would point at the install
    directory, and modern compose BUILDS when an image is absent locally - an
    operator enabling `--profile mcp` would get an incomprehensible build
    failure instead of a pull.
    """
    from tripl_cli.install.files import packaged

    expected = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
    assert MCP_BUILD_BLOCK in expected, (
        "the mcp build block this test strips is no longer in compose.yaml verbatim; "
        "update MCP_BUILD_BLOCK and re-copy the packaged asset"
    )
    assert packaged("compose.yaml") == expected.replace(MCP_BUILD_BLOCK, "")


def test_the_packaged_rabbitmq_conf_matches_the_repo_one() -> None:
    """No transform at all here - and it is not optional.

    compose.yaml bind-mounts `./infra/rabbitmq/rabbitmq.conf`. Docker's response
    to a missing bind-mount source is to create a DIRECTORY at that path, after
    which RabbitMQ fails to start with an error naming neither tripl nor the
    mount. Its `consumer_timeout` is also what stops a long metrics replay from
    being force-requeued mid-run.
    """
    from tripl_cli.install.files import packaged

    source = REPO_ROOT / "infra" / "rabbitmq" / "rabbitmq.conf"
    assert packaged("rabbitmq.conf") == source.read_text(encoding="utf-8")


def test_every_generated_variable_name_is_documented() -> None:
    """The .env `tripl install` writes is a published interface; pin the NAMES.

    A test cannot parse a shell snippet, so anti-drift for the secret RECIPES
    comes from having one executable definition (install/secrets.py) plus the
    property tests in test_install_files.py. What a test CAN pin is that every
    name that definition emits is documented in both places an operator looks -
    the CLI reference and the deployment guide - and that the deployment guide
    points at the command rather than republishing a third `openssl` recipe
    (tripl-ey6j.3).
    """
    from tripl_cli.install.secrets import REQUIRED_SECRETS, REQUIRED_SETTINGS

    pages = {
        "run/cli.md": DOCS_PATH.read_text(encoding="utf-8"),
        "run/deployment.md": DEPLOYMENT_DOCS_PATH.read_text(encoding="utf-8"),
    }
    undocumented = [
        f"{page}: {name}"
        for page, text in pages.items()
        for name in (*REQUIRED_SECRETS, *REQUIRED_SETTINGS)
        if name not in text
    ]
    assert not undocumented, (
        "`tripl install` generates variables the docs never name (the docs half of "
        "tripl-ey6j.3 lands the `## tripl install` / `## tripl upgrade` sections in "
        "run/cli.md and rewrites run/deployment.md's three hand-run procedures into a "
        "pointer): " + ", ".join(undocumented)
    )
    assert "tripl install" in pages["run/deployment.md"], (
        "website/docs/run/deployment.md never mentions `tripl install`, so an operator "
        "reading it will still hand-generate secrets from a recipe nothing tests"
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

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

from tripl_cli.client import API_PREFIX
from tripl_cli.diagnostics import checks, collect, scan_checks
from tripl_cli.diagnostics.endpoints import DOCTOR_ENDPOINTS, STATUS_ENDPOINTS

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENAPI_PATH = REPO_ROOT / "backend" / "openapi.json"
DOCS_PATH = REPO_ROOT / "website" / "docs" / "run" / "cli.md"
COLLECT_SOURCE = Path(collect.__file__)
RULE_SOURCES = (Path(checks.__file__), Path(scan_checks.__file__))

DECLARED = {**DOCTOR_ENDPOINTS, **STATUS_ENDPOINTS}


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
        "tripl doctor/status read endpoints that are no longer in backend/openapi.json "
        "(REST contract drift!):\n  " + "\n  ".join(missing)
    )


def test_every_path_in_collect_is_declared() -> None:
    """The declaration cannot go stale behind a newly added read.

    Scans the source for request-path literals, because the alternative - trusting
    that whoever adds a call also adds it here - is exactly the discipline this
    file exists to replace.
    """
    source = COLLECT_SOURCE.read_text(encoding="utf-8")
    # Path literals as they appear in the calls: "/x" or f"/x/{slug}/y".
    found = set(re.findall(r'f?"(/(?:projects|auth|data-sources)[^"]*)"', source))
    # Normalise the f-string placeholder names to the backend's own, which is what
    # the declaration and the OpenAPI document both use.
    renames = {"{type_id}": "{event_type_id}", "{config_id}": "{scan_id}"}
    normalised = set()
    for path in found:
        for actual, declared in renames.items():
            path = path.replace(actual, declared)
        normalised.add(path)
    declared_paths = {path for endpoints in DECLARED.values() for _, path in endpoints}
    undeclared = normalised - declared_paths
    assert not undeclared, (
        "collect.py reads paths that endpoints.py does not declare, so the contract "
        f"test cannot see them: {sorted(undeclared)}"
    )


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

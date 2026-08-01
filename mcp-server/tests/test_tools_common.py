"""Agent-payload shapers: mutation-warning hoisting.

Rehomed from tests/test_client.py when the HTTP client moved into the shared
`tripl` distribution — ``with_mutation_warnings`` stayed behind because it is an
MCP prompt concern, not a transport one (tripl-ey6j.1).
"""

from __future__ import annotations

from tripl_mcp.tools._common import with_mutation_warnings


def test_mutation_warnings_are_hoisted() -> None:
    data = {"id": "e1", "name": "purchase:success", "warnings": ["name was derived"]}

    result = with_mutation_warnings(data)

    assert result["IMPORTANT_warnings"] == ["name was derived"]
    assert result["result"]["name"] == "purchase:success"
    assert "warnings" not in result["result"]


def test_no_warnings_passes_through_unchanged() -> None:
    data = {"id": "e1", "warnings": []}

    assert with_mutation_warnings(data) is data

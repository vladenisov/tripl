"""The one home for REST request construction (tripl-ey6j.5).

Shared by the ``tripl`` CLI commands and by ``tripl-mcp``'s tools. A path
template appears here and nowhere else; ``ApiRequest`` is constructed here and
nowhere else; ``cli/tests/test_contract.py`` and ``mcp-server/tests/test_contract.py``
enforce both, which is what turns "the two surfaces share their request layer"
from a claim into a fact.

Nothing consumer-specific belongs here. No ``mcp`` import — that would invert the
dependency (tripl-mcp depends on tripl, never the reverse) and drag the whole MCP
SDK into every ``uvx tripl`` install, which is the mistake ``errors.py``'s
docstring records being avoided once already. No argparse, no printing, no
rendering, no agent-facing prose.

What lives here is what the API itself IS: paths, parameters, bodies, envelope
shapes, and the compound reads no single endpoint answers (a project's drifts are
a budgeted fan-out over its event types). Response ASSEMBLY stays with the
consumer — the MCP's context-budget projections and its ``ToolAnnotations`` stay
in ``tripl_mcp.tools._common``, and the CLI's tables and JSON documents stay in
``tripl_cli.diagnostics``.

A builder with no CLI caller is normal and expected: the rule is that EVERY path
lives here, so the MCP-only resources have builders too. A partial rule could not
be checked mechanically, and one that cannot be checked is one a contributor can
half-follow.

The one import out of this package is ``diagnostics.model``, for its untyped-JSON
helpers and ``JOBS_WINDOW``. Those are facts about the wire rather than about
doctor's verdict machinery; a follow-up bead covers moving them somewhere with a
less misleading name.
"""

from __future__ import annotations

from tripl_cli.api import (
    auth,
    branches,
    data_sources,
    event_types,
    events,
    monitoring,
    projects,
    scans,
    search,
    variables,
)
from tripl_cli.api.endpoints import ALL_TEMPLATES, SHARED_ENDPOINTS
from tripl_cli.api.request import ApiRequest, send

__all__ = [
    "ALL_TEMPLATES",
    "SHARED_ENDPOINTS",
    "ApiRequest",
    "auth",
    "branches",
    "data_sources",
    "event_types",
    "events",
    "monitoring",
    "projects",
    "scans",
    "search",
    "send",
    "variables",
]

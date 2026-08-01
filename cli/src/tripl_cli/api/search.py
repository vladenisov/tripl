"""Plan search."""

from __future__ import annotations

from typing import Any

from tripl_cli.api.request import ApiRequest
from tripl_cli.model import as_dict

SEARCH = "/projects/{slug}/search"

ENDPOINTS: tuple[tuple[str, str], ...] = (("get", SEARCH),)

# SearchResult.entity_type, verbatim from the OpenAPI document — the same list
# the route validates `types` against. One spelling, pinned by the contract test.
ENTITY_TYPES: tuple[str, ...] = (
    "event",
    "event_type",
    "field",
    "meta_field",
    "variable",
    "relation",
    "tag",
    "metric",
    "fact_table",
)

# The route's own bounds: `q` is Query(min_length=1, max_length=500) and `limit`
# is Query(ge=1, le=100) with a server default of 20. Checked locally so a
# too-long phrase fails at parse time rather than as a 422 (tripl-3ixs).
QUERY_MAX_LENGTH = 500
LIMIT_DEFAULT = 20
LIMIT_MAX = 100


def search_plan(
    slug: str,
    query: str,
    *,
    types: list[str] | None = None,
    limit: int | None = None,
    branch: str | None = None,
) -> ApiRequest:
    """Answers ``{items, total, semantic_used}``. NOT offset-paged: raise ``limit``."""
    return ApiRequest(
        "GET",
        SEARCH.format(slug=slug),
        params={"q": query, "types": types, "limit": limit, "branch": branch},
    )


def semantic_used(payload: Any) -> bool:
    """Did the semantic index answer, or did the route fall back to substring?

    The one envelope key this route adds, and load-bearing on BOTH surfaces for
    the same reason: under a substring fallback a low ``confidence`` means
    something different, so a consumer that cannot tell the two regimes apart
    misreads every score. ``tripl plan search`` publishes it in the document's
    ``meta`` and ``tripl-mcp``'s ``search_plan`` in its envelope — one route, one
    reader, rather than a ``.get`` per surface (tripl-i1dt).

    Absent reads as False rather than as unknown: the backend declares
    ``SearchResponse.semantic_used: bool = False``, so a body without the key IS
    the route saying the index did not answer.
    """
    return bool(as_dict(payload).get("semantic_used"))

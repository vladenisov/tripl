"""The search-relevance harness: one test per measured ranking case (tripl-338u).

This is the first test in the repository that executes the production ranking
SQL. Everything else about search is asserted either against generated SQL
strings or against ``sqlite_search``, the Python fallback that exists only
because the suite runs on SQLite — so ``postgres_lexical_search``'s
``ts_rank_cd``/trigram/boost arithmetic and ``merge_results`` had no coverage at
all, and any weight in them could be changed without a single test noticing.

Read :mod:`tripl.tests.relevance.cases` for the case table and what each case was
measured to do on production, and :mod:`tripl.tests.relevance.corpus` for the
fixed corpus every case is ranked against.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.search_document import SearchDocument
from tripl.schemas.search import SearchResult
from tripl.services import search_service
from tripl.services._search_query import _is_postgres
from tripl.tests.relevance.cases import CASES, RelevanceCase
from tripl.tests.relevance.corpus import Corpus

#: Every case queries with the SAME limit, and that limit is >= 50 on purpose.
#: ``search_service.search_project`` widens the candidate window by 24 only when
#: the requested limit is under 50, which makes the top result of a query depend
#: on how many results were asked for (measured: ``q='экран спота'`` returns a
#: different top-1 at limit=5 than at limit=50). That instability is filed
#: separately and is NOT this harness's subject; pinning the limit above the
#: threshold keeps every assertion here independent of it. The corpus is also
#: smaller than this limit, so nothing is ever truncated and the ranking under
#: test is total.
SEARCH_LIMIT = 50


def _rank_of(items: list[SearchResult], title: str) -> int | None:
    for index, item in enumerate(items):
        if item.title == title:
            return index
    return None


def _describe(items: list[SearchResult]) -> str:
    if not items:
        return "<no results>"
    return ", ".join(f"{item.title}={item.score:.3f}" for item in items[:8])


async def _search(session: AsyncSession, corpus: Corpus, query: str) -> list[SearchResult]:
    response = await search_service.search_project(
        session,
        corpus.slug,
        query,
        limit=SEARCH_LIMIT,
    )
    return list(response.items)


async def test_the_harness_executes_the_postgres_ranking_path(
    relevance_session: AsyncSession,
    seeded_corpus: Corpus,
) -> None:
    """Prove the harness is testing what it claims to test.

    Without this, a misconfigured fixture could silently fall back to the SQLite
    scorer and the whole case table would be asserting the wrong implementation —
    the exact failure mode that let the ranking SQL go untested for its entire
    life. Three things are checked: the session really speaks PostgreSQL, the
    corpus really got indexed, and the semantic leg really is off (so the case
    table measures lexical ranking and nothing else).
    """
    assert _is_postgres(relevance_session), "the harness is not connected to PostgreSQL"

    indexed = await relevance_session.scalar(
        select(func.count())
        .select_from(SearchDocument)
        .where(
            SearchDocument.project_id == seeded_corpus.project_id,
            SearchDocument.branch_id == seeded_corpus.branch_id,
        )
    )
    assert indexed is not None and indexed >= 20, f"corpus indexed only {indexed} documents"

    vectorized = await relevance_session.scalar(
        select(func.count())
        .select_from(SearchDocument)
        .where(
            SearchDocument.project_id == seeded_corpus.project_id,
            SearchDocument.branch_id == seeded_corpus.branch_id,
            SearchDocument.text_vector.is_(None),
        )
    )
    assert vectorized == 0, f"{vectorized} documents have no text_vector; ts_rank_cd sees nothing"

    response = await search_service.search_project(
        relevance_session,
        seeded_corpus.slug,
        "purchase_completed",
        limit=SEARCH_LIMIT,
    )
    assert response.items, "an exact event name returned nothing; the index is not queryable"
    assert response.semantic_used is False, (
        "the semantic leg ran; rankings in this harness would not be reproducible"
    )


@pytest.mark.parametrize(
    "case",
    [
        pytest.param(
            case,
            id=case.id,
            marks=pytest.mark.xfail(strict=True, reason=case.xfail) if case.xfail else (),
        )
        for case in CASES
    ],
)
async def test_relevance_case(
    case: RelevanceCase,
    relevance_session: AsyncSession,
    seeded_corpus: Corpus,
) -> None:
    items = await _search(relevance_session, seeded_corpus, case.query)
    ranking = _describe(items)

    if case.expect_top is not None:
        assert items, (
            f"q={case.query!r} returned nothing at all, so {case.expect_top!r} "
            f"cannot rank first. Measured {case.measured}."
        )
        rank = _rank_of(items, case.expect_top)
        assert rank is not None, (
            f"q={case.query!r} did not return {case.expect_top!r} anywhere in "
            f"{len(items)} results. Got: {ranking}. Measured {case.measured}."
        )
        for competitor in case.must_not_outrank:
            competitor_rank = _rank_of(items, competitor)
            assert competitor_rank is None or competitor_rank > rank, (
                f"q={case.query!r}: {competitor!r} outranks {case.expect_top!r} "
                f"(#{competitor_rank} vs #{rank}). Got: {ranking}. "
                f"Measured {case.measured}."
            )
        assert rank == 0, (
            f"q={case.query!r}: {case.expect_top!r} ranked #{rank}, not first. "
            f"Got: {ranking}. Measured {case.measured}."
        )

    if case.max_top_confidence is not None:
        assert items, (
            f"q={case.query!r} returned nothing, so the confidence claim cannot be "
            f"observed. The corpus is supposed to contain a weak match for it "
            f"(see corpus._SESSION_KEYS). Measured {case.measured}."
        )
        assert items[0].confidence <= case.max_top_confidence, (
            f"q={case.query!r} is served at confidence {items[0].confidence} on an "
            f"absolute score of {items[0].score:.3f}; nothing this weak may be "
            f"presented as a certain answer. Got: {ranking}. Measured {case.measured}."
        )

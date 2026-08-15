"""Search querying, ranking, and result shaping.

Contains the Postgres (lexical + semantic) and SQLite search paths, result
merging/boosting, event-hit enrichment, and response-shaping helpers.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from collections.abc import Mapping
from difflib import SequenceMatcher
from typing import cast

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event import Event
from tripl.models.field_definition import FieldDefinition
from tripl.models.search_document import SearchDocument
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.search import (
    SearchEntityType,
    SearchEventVariableValue,
    SearchResult,
)
from tripl.schemas.text_filters import strip_nul_bytes
from tripl.services import app_settings_service
from tripl.services.demo.search_embeddings import demo_query_embedding
from tripl.services.embedding_service import embed_query

# How strongly a matching event type lifts the events that belong to it.
_TYPE_BOOST_WEIGHT = 0.75

# Cosine similarity a semantic hit must clear to be merged into the result set
# (tripl-txcz). Below this the vector leg is not "a weaker answer", it is noise:
# it is a plain nearest-neighbour scan, so it returns `limit` rows for ANY query
# a branch's embedded documents can be ranked against — there is no such thing
# as "no match" in it — and `merge_results` then pays each of those rows
# `cosine * 2.5`, which is enough to displace a real lexical hit.
#
# 0.35 is deliberately at the LOW end of the useful band. The semantic leg is
# what rescues the measured misspellings ('пейволл', 'forcast', 'screan_spot',
# 'onboarding quiz'), which land around 0.45-0.65 with the shipped embedding
# model, while unrelated text sits under 0.25. A higher floor would start
# cutting into the rescues this leg exists for, so the floor removes the flat
# tail and nothing else.
_SEMANTIC_MIN_COSINE = 0.35

# The score at which a result is presented as a certain answer (tripl-txcz).
# 5.0 (the boost for "the title IS what you typed") + 2.0 (a perfect trigram
# similarity on that same title) = the score of a document that is exactly the
# thing the user asked for. Confidence is that fraction, capped at 1.0 — an
# ABSOLUTE scale, so a query that matched nothing well cannot be dressed up as
# a perfect match just by being the best of a bad set.
#
# ONLY IDENTITY TIERS MAY REACH THIS LINE, ON EITHER DIALECT
# ----------------------------------------------------------
# An earlier version of this comment claimed the SQLite fallback's top three
# tiers "sit at or above the same line, so the two dialects agree on what
# 'certain' means". They did not: ``fallback_score`` paid a BARE
# ``title.startswith(query)`` exactly 7.0, so a prefix match — the weakest kind
# of evidence there is, ``s`` matching ``screen_spot`` — was served at
# confidence 1.0. That is the "asdkjhasd at 100%" defect this issue exists to
# remove, reintroduced on the dialect the entire backend suite runs on.
#
# The rule the two dialects now actually share: a result reaches 1.0 only when
# the document IS what was typed. On Postgres that is the 5.0 exact-title (or
# 4.0 exact-keywords) boost plus a near-perfect trigram similarity on the same
# short field; on SQLite it is the two identity tiers, ``title == query`` and
# ``keywords == query``. Every partial-evidence tier in ``fallback_score`` sits
# strictly below this constant — see its docstring for the ladder.
_FULL_CONFIDENCE_SCORE = 7.0

# How much a semantic hit's cosine similarity is worth to the RANKING, i.e. how
# a vector-only hit is placed among lexical ones (tripl-txcz). It is not, and
# cannot be, the scale confidence is read on: it caps a perfect cosine at 2.5,
# which is a deliberate ranking statement ("a pure vector match ranks around a
# literal body-token match") and a nonsense certainty statement ("a perfect
# semantic match is 36% sure"). :func:`finalize_results` therefore scores the
# two legs on one scale and reports certainty on another; see both docstrings.
_SEMANTIC_SCORE_WEIGHT = 2.5


def sanitize_query(query: str) -> str:
    """Trim the incoming query and drop codepoints no backend can carry.

    Postgres ``text`` cannot represent U+0000, so a query containing one aborts
    inside the driver (``asyncpg.exceptions.CharacterNotInRepertoireError``)
    before any SQL runs — ``?q=%00``, the first thing a routine security scan
    sends, used to surface as a 500 for any authenticated caller (tripl-q4q7).

    We strip rather than reject with 422 because stripping is *lossless here*:
    an indexed document cannot contain a NUL either (same column type, same
    restriction), so removing it cannot change which rows match or how they
    rank. The user who pasted text with a stray NUL gets the results they meant
    and no API client loses behaviour it could have relied on — the surprise
    argument against silently rewriting a query has no bite when the rewrite is
    provably a no-op on the result set. That reasoning does NOT generalise:
    anything with search meaning must survive, which is why this removes
    exactly U+0000 and leaves every other character alone.

    A query made only of NULs collapses to ``""`` and then takes the same
    empty-result path a whitespace-only query already took.

    The NUL removal itself now lives in ``schemas.text_filters``, where a route
    parameter type applies the identical rule to every other free-text filter
    (tripl-8wez). One rule, one implementation; this function adds only the
    whitespace trim, which is a search concern rather than a driver one.
    """
    cleaned: str = strip_nul_bytes(query)
    return cleaned.strip()


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold()).strip()


def _tokens(query: str) -> list[str]:
    return [token for token in re.split(r"\s+", _normalize(query)) if token]


def _safe_limit(limit: int) -> int:
    return max(1, min(limit, 10000))


def _is_postgres(session: AsyncSession) -> bool:
    return session.bind.dialect.name == "postgresql"


async def postgres_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
    project_is_demo: bool = False,
) -> tuple[list[SearchResult], bool]:
    lexical_results = await postgres_lexical_search(
        session,
        project_id=project_id,
        branch_id=branch_id,
        query=query,
        entity_types=entity_types,
        include_archived=include_archived,
        limit=limit,
    )
    semantic_used = False
    semantic_results: list[SearchResult] = []
    ai_config = await app_settings_service.get_ai_config(session)
    if ai_config.search_embeddings_enabled and len(query) >= 3:
        query_embedding = await asyncio.to_thread(embed_query, query, config=ai_config)
        if query_embedding:
            semantic_used = True
            semantic_results = await postgres_semantic_search(
                session,
                project_id=project_id,
                branch_id=branch_id,
                embedding=query_embedding,
                entity_types=entity_types,
                include_archived=include_archived,
                limit=limit,
            )

    # Keyless demo fallback: when the live semantic leg is unavailable
    # (embeddings disabled, or the embed call failed/returned empty), a demo
    # project can still run the semantic leg with a canned query vector from
    # the precomputed fixture. Non-demo projects are unaffected.
    if not semantic_used and project_is_demo and len(query) >= 3:
        demo_embedding = demo_query_embedding(query)
        if demo_embedding:
            semantic_used = True
            semantic_results = await postgres_semantic_search(
                session,
                project_id=project_id,
                branch_id=branch_id,
                embedding=demo_embedding,
                entity_types=entity_types,
                include_archived=include_archived,
                limit=limit,
            )

    merged = merge_results(lexical_results, semantic_results, limit)
    return merged, semantic_used


#: The tsquery every lexical search runs with: the STEMMED reading of what was
#: typed, OR-ed with its SURFACE reading (tripl-uojz). ``||`` on ``tsquery`` is
#: OR, not concatenation.
#:
#: WHY THIS IS A MODULE CONSTANT AND NOT JUST A LINE OF SQL
#: --------------------------------------------------------
#: It is the QUERY half of an identity the whole fix rests on: a document
#: indexes ``{stem(w), surface(w)}`` (``search_service.TEXT_VECTOR_EXPRESSION``)
#: and a query asks for ``{stem(q), surface(q)}``, so two forms of one word meet
#: iff those sets intersect. Half of that identity being right is worth nothing —
#: a surface-indexed document under a stem-only query is unreachable in exactly
#: the way the bug was.
#:
#: ``tests/relevance/test_stemming_invariants.py`` asserts the identity directly,
#: over production-harvested word forms, with no corpus and no ranking involved.
#: It IMPORTS this constant and ``TEXT_VECTOR_EXPRESSION`` rather than copying
#: the SQL, so the thing it proves is the thing that ships. A copied literal
#: would have gone on passing after either side was edited — which is precisely
#: how the previous harness certified a repair that was wrong on production.
TEXT_QUERY_EXPRESSION = """
    websearch_to_tsquery('tripl_search', :query)
    || websearch_to_tsquery('tripl_search_surface', :query)
"""


async def postgres_lexical_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    """Rank one branch's documents: ts_rank_cd + trigram similarity + boost ladder.

    The three legs are meant to be on comparable scales: the boost ladder is a
    set of fixed constants (5.0 for "the title IS the query" down to 1.5), the
    trigram leg is a similarity in [0, 1] weighted x2.0, and the lexical leg is
    a ``ts_rank_cd`` weighted x4.0. That only holds if ``ts_rank_cd`` is
    bounded, and until tripl-gbxj it was called with NO normalization flag —
    i.e. as a raw sum over occurrences, which grows without limit as a document
    repeats a term.

    WHAT THAT COST (measured, 26 queries over three real projects)
    -------------------------------------------------------------
    ``q='spot'`` returned ``${property.spot_id}`` at 73.69 and ``${property.cube}``
    at 55.68 — the latter only because one harvested value is ``spot:reload:bento``
    — while the events actually NAMED ``spot`` and ``screen_spot`` did not appear
    at all. A harvested-value variable that repeats a token ~180 times reached a
    lexical leg of ~68: an order of magnitude more than the entire boost ladder,
    so no exact-title constant could ever catch up. ``q='screen_spot'`` fired the
    5.0 exact-title boost and the event still ranked 3rd.

    WHY FLAG 32 AND NOT 2
    ---------------------
    ``32`` is ``rank / (rank + 1)``: a monotone squash of [0, inf) onto [0, 1),
    so the lexical leg can never exceed 4.0 — below the 5.0 an exact title
    scores — while the NORMAL range is left almost untouched. A single ordinary
    match has a raw ``ts_rank_cd`` around 0.1 and still scores 0.09; the 18.4
    outlier above collapses to 0.95. It bends the outliers and nothing else,
    which is exactly the shape of the measured fault.

    ``2`` (divide by document length) was considered and rejected. It turns the
    score into a term DENSITY, but length in this index is an artifact of how
    many contexts an entity happens to be bound to rather than a property of the
    text, so an ordinary match lands near 0.0007 — three orders of magnitude
    below the boost ladder. That does not stop the lexical leg from dominating,
    it stops it from discriminating at all, and every ranking decision would
    fall to the ladder and the trigram leg.

    Normalization is only half of tripl-gbxj: harvested values are no longer
    joined into a variable's ``keywords`` either (see
    ``_search_documents._variable_document``), which removes the duplication
    that made those documents long in the first place. The measured 73.69 vs
    4.55 gap was the two compounding, so both landed together.

    ``token_boundary_regex`` below carries the query-time half of tripl-h9x2: a
    spaced query is folded into its underscored form, so the 3.5/3.0
    word-boundary tiers are reachable for ``q='screen spot'`` instead of being
    dead for every multi-word query.

    THE 3.25 TIER: THE BOOST LADDER HAD TO LEARN THE STEMMER TOO (tripl-nh5s)
    ------------------------------------------------------------------------
    Migration ``a7c3e1b9d5f2`` gives ``tripl_search`` an English and a Russian
    stemmer, which fixes RETRIEVAL: ``q='purchases'`` matches the
    ``purchase_completed`` event's tsvector at all, for the first time. It does
    NOT by itself fix the RANKING, because every tier of the ladder is a literal
    comparison
    (``=``, ``LIKE``, a regex), and the ladder is worth up to 5.0 against a
    lexical leg capped at 4.0. So a plural query kept losing to the same
    documents it lost to before:

        ``q='purchases'``: the ``purchase_completed`` event spells the SINGULAR
        everywhere, so no literal tier can fire for it and its boost is 0. The
        harvested-value variable ``${property.screen_name}`` literally contains
        the string ``purchases`` in its body, so ``body ~* '\\mpurchases\\M'``
        fires and pays it 3.0 — more than the entire stemming gain. Same shape
        for ``q='уловы'`` and ``q='spots'``.

    The 3.25 tier is the missing half: it asks whether the query, AFTER
    stemming, matches this document's own identity text. Three properties are
    load-bearing:

    * **title and keywords only, never body.** ``keywords`` is the curated field
      — a name, its spaced alias, the event type, the bindings — and tripl-gbxj
      already removed harvested values from a variable's keywords for exactly
      this reason. ``body`` is where the harvested text lives, and paying a
      stemmed body match would hand the noise documents the tier a second time.
    * **3.25, between the 3.5 literal-keyword-token tier and the 3.0 literal
      body-token tier.** A stemmed match on the entity's name is weaker evidence
      than the literal token appearing in its keywords, and stronger than the
      literal token appearing somewhere in its body. Ordered that way, the
      measured pairs invert: ``purchase_completed`` reaches 3.25 + rank + trigram
      while the harvested variable stays at its 3.0.
    * **No document's own boost can FALL because of it.** ``CASE`` returns the
      first branch that matches, so a document that already qualified for 5.0,
      4.0 or 3.5 never reaches this tier, and any document that does reach it
      was going to score 3.0 or less. The tier therefore adds evidence and never
      removes it: a result changes position only by being overtaken by a
      document whose name genuinely stems to what was typed, which is the whole
      point of the change.

    The cost is one ``to_tsvector`` per candidate row over two short columns.
    It is computed in the projection of the ``ranked`` CTE, i.e. only for rows
    that already passed the WHERE, and never over ``body`` — the column that can
    be megabytes on a harvested-value variable.

    THE QUERY IS NOW TWO TSQUERIES OR-ED (tripl-uojz)
    -------------------------------------------------
    Snowball over-stems the bare nominative — ``улов`` -> ``ул``, ``экран`` ->
    ``экра`` — onto a lexeme no inflected form of the same word reaches, so a
    stem-only index splits a word into two disjoint classes. The repair is
    symmetric: every document indexes ``stem(w) || surface(w)`` (see
    ``search_service.TEXT_VECTOR_EXPRESSION``) and every query is
    ``websearch_to_tsquery('tripl_search', q) || websearch_to_tsquery(
    'tripl_search_surface', q)``. There is exactly ONE place the tsquery is
    built — the ``q`` CTE — and exactly one place that derives from it and needs
    the same treatment on the DOCUMENT side, the 3.25 tier above; the WHERE and
    ``ts_rank_cd`` consume ``q.tsq`` unchanged.

    WHAT THIS DOES TO RANKING, INCLUDING WHAT IS NOT CERTIFIED
    ----------------------------------------------------------
    A document now holds roughly twice the lexeme occurrences, so a raw
    ``ts_rank_cd`` roughly doubles — but not uniformly, and the difference is
    where the risk lives.

    * **The tripl-gbxj guarantees survive by construction.** Normalization flag
      32 is ``rank / (rank + 1)``, so the lexical leg is bounded by 4.0 no matter
      how large the raw rank grows. ``spot-event-beats-harvested-variables`` and
      ``screen_spot-exact-title-beats-harvested-variables`` are won by a 5.0
      exact-title boost against a leg that CANNOT reach 5.0, and doubling the raw
      rank cannot change that. For ``q='spot'`` and ``q='screen_spot'`` the two
      legs of the tsquery are identical anyway (``stem('spot') == 'spot'``), so
      the query is literally unchanged.
    * **``repetition-outlier-does-not-outrank-the-screen-it-names`` survives with
      room.** ``q='screen_settings'``: the outlier's raw rank of 18.0 can at most
      approach 4.0 after normalization (it is 3.79 today), so its total moves
      from ~6.24 to at most ~6.45 against an event at 8.33 that also gains. A
      tsvector additionally caps a lexeme at 256 positions, so the 180
      occurrences of ``screen`` merge to 256 rather than 360 — the outlier gains
      less than double, not more.
    * **``spaced-query-finds-underscored-event`` is untouched.** Both legs of
      ``q='screen spot'`` are the same lexemes; ``token_boundary_regex`` and the
      3.5/3.0 tiers are literal and see no tsquery at all.
    * **The plural cases are NOT certified, and this says so instead of
      asserting.** ``purchase-plural`` / ``spots-plural`` / ``ulov-plural`` are
      won by 0.25 — the gap between the 3.25 stemmed tier the entity earns and
      the 3.0 literal body tier the harvested value earns. The harvested value
      spells the queried form LITERALLY, so after this change it matches BOTH
      legs of the tsquery while the correctly-named entity still matches only the
      stem leg. Its lexical leg therefore grows and the entity's does not. On a
      small raw rank the normalized leg is nearly linear, so a raw 0.1 -> 0.2
      moves the leg by ~0.30 — more than the 0.25 the case is won by. Whether it
      actually flips depends on occurrence counts this docstring cannot know.
      Run the relevance harness; do not read a green suite as a prediction, and
      do not read this paragraph as one either.

    A second, smaller semantic change: ``websearch_to_tsquery`` ANDs the terms
    WITHIN each leg, so the result is ``(a1 & b1) | (a2 & b2)`` and not the
    per-term ``(a1|a2) & (b1|b2)``. A multi-word query whose terms need DIFFERENT
    legs (one word matched by its stem, another only by its surface) still
    misses. That is strictly less broken than today, where only the stem leg
    exists, but it is not zero. Building the per-term form would mean parsing
    websearch syntax — quotes, ``or``, ``-`` negation — in Python, and a
    hand-rolled parser of that grammar is a larger risk than the residue.

    The same OR also weakens ``-`` exclusion: excluding ``-спота`` no longer
    excludes a document spelling ``спот``, because that document fails the stem
    leg's ``!спот`` but satisfies the surface leg's ``!спота``. Detecting
    negation in Python to skip the surface leg was rejected — a bare ``-`` scan
    misfires on the hyphenated identifiers this catalog is full of, and a
    heuristic that is wrong on identifiers is worse than a narrower NOT.
    """
    token_regex = token_boundary_regex(query)
    has_token_regex = bool(token_regex)
    statement = text(
        f"""
        WITH q AS (
            -- THE ONE TSQUERY CONSTRUCTION SITE (tripl-uojz). The expression
            -- itself lives in TEXT_QUERY_EXPRESSION above so the invariant test
            -- can assert the SHIPPED string instead of a copy of it; the stem
            -- leg is what a7c3e1b9d5f2 built, and the surface leg is what lets a
            -- query reach a document stranded on an over-stem (`экран` -> `экра`,
            -- a lexeme no inflected form produces). Both legs are also indexed
            -- into every document's text_vector, so the two sides meet.
            SELECT ({TEXT_QUERY_EXPRESSION}) AS tsq
        ),
        ranked AS (
            SELECT
                d.id,
                d.entity_type,
                d.entity_id,
                d.parent_event_id,
                d.title,
                d.subtitle,
                d.description,
                d.body,
                d.keywords,
                d.route_path,
                -- Normalization 32 == rank/(rank+1): bounded, so raw term
                -- frequency can no longer outweigh the boost ladder (tripl-gbxj,
                -- see the docstring for why not 2).
                COALESCE(ts_rank_cd(d.text_vector, q.tsq, 32), 0.0) AS lexical_score,
                GREATEST(
                    similarity(d.title, :query),
                    similarity(d.subtitle, :query),
                    similarity(d.keywords, :query),
                    similarity(d.body, :query) * 0.5
                ) AS fuzzy_score,
                CASE
                    WHEN lower(d.title) = lower(:query) THEN 5.0
                    WHEN lower(d.keywords) = lower(:query) THEN 4.0
                    WHEN :has_token_regex AND d.keywords ~* :token_regex THEN 3.5
                    -- The stemmed tier (tripl-nh5s). Every other tier compares
                    -- literal characters, so a plural query can only ever reach
                    -- the ladder through a document that spells the plural --
                    -- which is the harvested value, not the entity. See the
                    -- docstring: this fires only on title/keywords, never body.
                    -- DERIVED FROM THE `q` CTE ABOVE, NOT A SECOND CONSTRUCTION
                    -- SITE: it consumes `q.tsq` and only builds the DOCUMENT
                    -- side. That document side has to carry the same two legs
                    -- as the stored text_vector (tripl-uojz) or the tier would
                    -- answer a two-leg query with a one-leg document and fire
                    -- for a strictly narrower set than it retrieves.
                    WHEN (
                        to_tsvector('tripl_search', concat_ws(' ', d.title, d.keywords))
                        || to_tsvector(
                            'tripl_search_surface', concat_ws(' ', d.title, d.keywords)
                        )
                    ) @@ q.tsq THEN 3.25
                    WHEN :has_token_regex AND d.body ~* :token_regex THEN 3.0
                    WHEN lower(d.title) LIKE lower(:prefix) THEN 3.0
                    WHEN lower(d.body) LIKE lower(:contains) THEN 2.25
                    WHEN lower(d.keywords) LIKE lower(:contains) THEN 1.5
                    ELSE 0.0
                END AS boost
            FROM search_documents d
            CROSS JOIN q
            WHERE d.project_id = :project_id
              AND d.branch_id = :branch_id
              AND (:include_archived OR d.archived IS FALSE)
              AND (:filter_entity_types IS FALSE OR d.entity_type IN :entity_types)
              AND (
                d.text_vector @@ q.tsq
                OR d.title % :query
                OR d.subtitle % :query
                OR d.keywords % :query
                OR lower(concat_ws(' ', d.title, d.subtitle, d.body, d.keywords))
                   LIKE lower(:contains)
              )
        )
        SELECT
            id,
            entity_type,
            entity_id,
            parent_event_id,
            title,
            subtitle,
            description,
            body,
            keywords,
            route_path,
            ((lexical_score * 4.0) + (fuzzy_score * 2.0) + boost) AS score
        FROM ranked
        ORDER BY score DESC, title ASC
        LIMIT :limit
        """  # noqa: S608 - no user input is interpolated; the operand is a module constant
    )
    filter_entity_types = bool(entity_types)
    statement = statement.bindparams(bindparam("entity_types", expanding=True))
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "query": query,
        "prefix": f"{query}%",
        "contains": f"%{query}%",
        "token_regex": token_regex,
        "has_token_regex": has_token_regex,
        "include_archived": include_archived,
        "filter_entity_types": filter_entity_types,
        # An expanding bindparam cannot expand an empty list, so feed a single
        # placeholder when no type filter is active — the boolean flag above
        # short-circuits the IN clause, so the placeholder is never compared.
        "entity_types": list(entity_types) if entity_types else [""],
        "limit": limit,
    }
    rows = (await session.execute(statement, params)).mappings().all()
    return [row_to_result(row, query, semantic_used=False) for row in rows]


async def postgres_semantic_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    embedding: list[float],
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    """Nearest documents by cosine similarity, above a floor (tripl-txcz).

    This leg is a pure ``ORDER BY <=> LIMIT``: it has no notion of "no good
    answer". Every indexed document carries an embedding, so it always returned
    exactly ``limit`` rows for ANY query, and ``merge_results`` then paid each
    of them ``cosine * 2.5`` — enough for the nearest junk row to be served as a
    result, and (before the same issue's confidence fix) as a CERTAIN one.

    ``_SEMANTIC_MIN_COSINE`` is applied in SQL rather than after the fetch so
    the floor cannot be defeated by the ``LIMIT``: filtering in Python would
    still have had the k nearest rows chosen first and then thrown most of them
    away, returning fewer results than requested for no reason.

    This deliberately does NOT de-weight or disable the semantic leg. Measured,
    it is what rescues 'пейволл', 'forcast', 'screan_spot' and 'onboarding
    quiz', none of which the lexical leg can reach; the floor only removes the
    tail below the point where cosine stops carrying meaning.

    The ``* _SEMANTIC_SCORE_WEIGHT`` this leg's cosine is multiplied by in
    :func:`merge_results` is likewise untouched — but that number is a RANKING
    weight and nothing else. Reporting confidence as ``score / 7.0`` would have
    de-weighted this leg where the user can see it (a perfect cosine served at
    0.357), which is why :func:`finalize_results` reads a semantic hit's
    certainty off its cosine instead. The score says where the row goes; the
    cosine says how sure we are about it.
    """
    vector = "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"
    statement = text(
        """
        SELECT
            d.id,
            d.entity_type,
            d.entity_id,
            d.parent_event_id,
            d.title,
            d.subtitle,
            d.description,
            d.body,
            d.keywords,
            d.route_path,
            (1.0 - (d.embedding <=> CAST(:embedding AS vector))) AS score
        FROM search_documents d
        WHERE d.project_id = :project_id
          AND d.branch_id = :branch_id
          AND (:include_archived OR d.archived IS FALSE)
          AND d.embedding IS NOT NULL
          AND d.embedding_status = 'ready'
          AND (:filter_entity_types IS FALSE OR d.entity_type IN :entity_types)
          -- A nearest neighbour is not automatically a match (tripl-txcz).
          AND (1.0 - (d.embedding <=> CAST(:embedding AS vector))) >= :min_cosine
        ORDER BY d.embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """
    )
    filter_entity_types = bool(entity_types)
    statement = statement.bindparams(bindparam("entity_types", expanding=True))
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "embedding": vector,
        "min_cosine": _SEMANTIC_MIN_COSINE,
        "include_archived": include_archived,
        "filter_entity_types": filter_entity_types,
        # See postgres_lexical_search: a placeholder list keeps the expanding
        # bindparam valid; the boolean flag short-circuits the IN clause.
        "entity_types": list(entity_types) if entity_types else [""],
        "limit": limit,
    }
    rows = (await session.execute(statement, params)).mappings().all()
    return [row_to_result(row, "", semantic_used=True) for row in rows]


async def sqlite_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    statement = select(SearchDocument).where(
        SearchDocument.project_id == project_id,
        SearchDocument.branch_id == branch_id,
    )
    if entity_types:
        statement = statement.where(SearchDocument.entity_type.in_(entity_types))
    if not include_archived:
        statement = statement.where(SearchDocument.archived.is_(False))
    rows = list((await session.execute(statement)).scalars().all())
    scored: list[tuple[float, SearchDocument]] = []
    query_norm = _normalize(query)
    query_tokens = _tokens(query)
    for row in rows:
        haystack = _normalize(_join_str([row.title, row.subtitle, row.body, row.keywords]))
        score = fallback_score(query_norm, query_tokens, haystack, row)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], item[1].title))
    return [
        document_to_result(row, score, query, semantic_used=False) for score, row in scored[:limit]
    ]


def _join_str(parts: list[str | None]) -> str:
    return " ".join(p for p in parts if p)


# The SQLite fallback's tier ladder. Values are on the same absolute scale as
# the Postgres score, so ``finalize_results`` can divide both by
# _FULL_CONFIDENCE_SCORE and mean the same thing. See :func:`fallback_score` for
# why every tier is the old value x 0.8, and for what that does and does not
# make the two dialects agree about.
_SQLITE_EXACT_TITLE = 8.0
_SQLITE_EXACT_KEYWORDS = 7.2
_SQLITE_TITLE_PREFIX = 5.6
_SQLITE_KEYWORD_TOKEN = 5.44
_SQLITE_BODY_TOKEN = 5.2
_SQLITE_TITLE_OR_KEYWORD_SUBSTRING = 4.8
_SQLITE_HAYSTACK_SUBSTRING = 3.2
_SQLITE_ALL_TOKENS = 2.4
_SQLITE_FUZZY_WEIGHT = 1.6
_SQLITE_FUZZY_MIN_RATIO = 0.55


def fallback_score(
    query_norm: str,
    query_tokens: list[str],
    haystack: str,
    document: SearchDocument,
) -> float:
    """Score one document for the SQLite path. READ THE GUARANTEES BELOW.

    This is not a port of ``postgres_lexical_search`` and cannot be one. It is a
    tier ladder over Python string operations, and the backend test suite runs
    on SQLite — so it is what almost every search assertion in the repo actually
    executes. Being explicit about the gap is the point of this docstring:
    silence here is how the next person concludes the suite covers ranking.

    WHAT HOLDS ON BOTH DIALECTS
    ---------------------------
    * **The identity tiers.** ``title == query`` and ``keywords == query`` are
      the only tiers that reach ``_FULL_CONFIDENCE_SCORE``, matching Postgres's
      5.0/4.0 exact boosts. See below for what that cost.
    * **Half of tripl-gbxj.** Harvested values are no longer joined into a
      variable's ``keywords`` (``_search_documents._variable_document``), which
      is an INDEXING change and therefore applies to every dialect. Its other
      half — bounding ``ts_rank_cd`` with normalization flag 32 — has no analogue
      here and needs none: this scorer returns one tier value per document and
      has no term-frequency term to run away with in the first place.
    * **tripl-h9x2, both halves.** The spaced alias of every identifier is in
      the index (again a document-building change), and the word-boundary tiers
      below additionally fold the QUERY into its identifier form through the
      same :func:`identifier_form` the Postgres regex tiers use. So
      ``q='screen spot'`` reaches the ``screen_spot`` event from either side
      here too.

    WHAT IS POSTGRESQL-ONLY — NOT APPROXIMATED, NOT TESTED HERE
    -----------------------------------------------------------
    * **All of tripl-nh5s: stemming, and the 3.25 boost tier that depends on
      it.** Both are ``tripl_search`` — a text-search configuration and a
      ``to_tsvector`` comparison. Python's standard library has no stemmer and
      this project has no dependency that provides one, so ``q='purchases'``
      does NOT reach ``purchase_completed`` on SQLite, and ``q='уловы'`` does not
      reach ``улов``. Every stemming case in the relevance table
      (``tests/relevance/cases.py``: purchase-plural, ulov-plural, spots-plural,
      russian-phrase) is a Postgres-only guarantee. tripl-uojz — indexing and
      querying the SURFACE form beside the stem, so an over-stemmed nominative
      (``улов`` -> ``ул``) is still reachable from its own inflections — is the
      same story for the same reason: no stemmer here means no over-stemmer
      either, so this dialect never had the fault and cannot demonstrate the fix.
    * **``ts_rank_cd`` and trigram similarity.** There is no lexical rank and no
      fuzzy-match leg beyond the crude ``SequenceMatcher`` tail below, so the
      x4.0/x2.0 weighting the whole boost ladder is calibrated against does not
      exist here. Two documents that Postgres separates by rank are separated
      here only if they land on different tiers.

    The consequence, stated plainly: **the SQLite suite does not cover ranking.**
    A green ``uv run pytest`` says the search endpoint returns the right rows and
    the right shapes; only the relevance harness (``tests/relevance/``, a real
    PostgreSQL, its own CI job) says they come back in the right ORDER. See
    CONTRIBUTING.md, "Search relevance harness".

    WHY THE PARTIAL TIERS MOVED (tripl-txcz)
    ----------------------------------------
    The ladder used to run 10.0 / 9.0 / 7.0 / 6.8 / 6.5 / 6.0 / 4.0 / 3.0, with
    ``_FULL_CONFIDENCE_SCORE`` at 7.0 — so a bare ``title.startswith(query)``
    was served at confidence 1.0. A one-character query is a prefix of a great
    many titles; that is the weakest evidence in the ladder being presented as
    the strongest possible answer, i.e. exactly the "asdkjhasd at 100%" defect
    on the other dialect.

    The whole ladder — every tier AND the fuzzy tail's weight — is therefore
    multiplied by one uniform factor of 0.8. Uniform is the load-bearing word:
    the two identity tiers land on 8.0 and 7.2, still above the certainty line,
    while the strongest partial tier lands on 5.6 (confidence 0.80), and because
    every value moved by the same factor, EVERY ratio in the ladder is
    preserved. Ranking on this dialect is provably unchanged — all comparisons
    are between scaled values, and :func:`_apply_event_type_boost` is
    multiplicative, so it cannot reorder them either. Only the number painted on
    a result moves, which is the whole of tripl-txcz.
    """
    if not query_norm:
        return 0.0
    title = _normalize(document.title)
    keywords = _normalize(document.keywords)
    if title == query_norm:
        return _SQLITE_EXACT_TITLE
    if keywords == query_norm:
        return _SQLITE_EXACT_KEYWORDS
    # The identifier fold is applied ONLY to the word-boundary tiers, never to
    # the identity tiers above (tripl-h9x2). That mirrors Postgres exactly:
    # there ``token_boundary_regex`` feeds the 3.5/3.0 tiers while
    # ``lower(title) = lower(:query)`` compares the raw query, so ``q='screen
    # spot'`` is a strong token match on ``screen_spot`` and not an exact-title
    # match. Folding it into the identity tiers here would make SQLite MORE
    # certain than Postgres about the same query.
    identifier_query = identifier_form(query_norm)
    if title.startswith(query_norm):
        return _SQLITE_TITLE_PREFIX
    if _matches_token(document.keywords, query_norm, identifier_query):
        return _SQLITE_KEYWORD_TOKEN
    if _matches_token(document.body, query_norm, identifier_query):
        return _SQLITE_BODY_TOKEN
    if query_norm in title or query_norm in keywords:
        return _SQLITE_TITLE_OR_KEYWORD_SUBSTRING
    if query_norm in haystack:
        return _SQLITE_HAYSTACK_SUBSTRING
    if query_tokens and all(token in haystack for token in query_tokens):
        return _SQLITE_ALL_TOKENS
    similarity = SequenceMatcher(None, query_norm, title or haystack[:200]).ratio()
    return similarity * _SQLITE_FUZZY_WEIGHT if similarity >= _SQLITE_FUZZY_MIN_RATIO else 0.0


def _matches_token(source: str | None, query_norm: str, identifier_query: str | None) -> bool:
    """Whether ``source`` carries the query as a whole word, spaced or underscored.

    The SQLite half of tripl-h9x2's query-time fold: ``q='screen spot'`` has to
    reach a document whose text spells ``screen_spot``, the same way
    ``token_boundary_regex`` lets it on Postgres.
    """
    if _contains_exact_token(source or "", query_norm):
        return True
    return identifier_query is not None and _contains_exact_token(source or "", identifier_query)


def token_boundary_regex(query: str) -> str | None:
    """PostgreSQL word-boundary pattern for the query, or ``None`` if it is not a token.

    QUERY-TIME HALF OF tripl-h9x2
    -----------------------------
    Entities in this product are named in snake_case (``screen_spot``,
    ``vip_segment``, ``catch_report_created``) but people type them with spaces.
    This function used to require ``[a-z0-9_]+`` over the RAW query, so it
    returned ``None`` for anything containing a space — which silently deleted
    the 3.5 (keywords) and 3.0 (body) word-boundary tiers from the ranking of
    every multi-word query, and for Cyrillic, which is not in ``[a-z0-9]`` at
    all. Measured: ``q='screen spot'`` ranked the ``screen_spot`` event 5th at
    4.545, behind harvested-value variables, because the only tiers left compare
    the spaced query against an underscored title and all miss.

    So the query is folded INTO the identifier form (spaces -> underscores)
    instead of being rejected for having spaces, and the token test is Unicode
    (``\\w``) instead of ASCII-only, so a Cyrillic query is a token like any
    other. ``\\m``/``\\M`` are PostgreSQL word boundaries and treat ``_`` as a
    word character, so ``\\mscreen_spot\\M`` still matches only the whole
    identifier and never a fragment of ``screen_spot_v2``.

    The index-time half lives in ``_search_documents._spaced_identifiers``,
    which puts the SPACED alias of each identifier into the document's
    keywords; between the two, ``screen_spot`` and ``screen spot`` reach each
    other whichever side the underscore is on. The SQLite fallback scorer gets
    the index-time half for free and applies the query-time half itself, through
    the shared :func:`identifier_form` — see :func:`fallback_score`, which also
    lists what it CANNOT reproduce.

    Queries that are not identifier-shaped (punctuation, quotes, ``100%``) still
    return ``None`` and keep the LIKE/trigram behaviour they always had — this
    only converts a whitespace-separated identifier, it does not invent tokens.
    """
    identifier_query = identifier_form(query)
    if identifier_query is None:
        return None
    return rf"\m{re.escape(identifier_query)}\M"


def identifier_form(query: str) -> str | None:
    """The query folded into its snake_case identifier form, or ``None``.

    Extracted from :func:`token_boundary_regex` (tripl-h9x2) so the SQLite
    fallback scorer can apply the identical fold to its own word-boundary tiers
    rather than carrying a second, subtly different idea of what an identifier
    is — see :func:`fallback_score`. Both dialects therefore agree on which
    queries are identifier-shaped, which is the part of tripl-h9x2 that does not
    need PostgreSQL to hold.
    """
    normalized_query = _normalize(query)
    identifier_query = re.sub(r"\s+", "_", normalized_query)
    if not re.fullmatch(r"\w+", identifier_query, flags=re.UNICODE):
        return None
    return identifier_query


def _contains_exact_token(source: str, query_norm: str) -> bool:
    if not source or not query_norm:
        return False
    return re.search(rf"(^|[^\w]){re.escape(query_norm)}([^\w]|$)", _normalize(source)) is not None


def merge_results(
    lexical_results: list[SearchResult],
    semantic_results: list[SearchResult],
    limit: int,
) -> list[SearchResult]:
    """Fold the semantic leg into the lexical one: one ranking, two certainties.

    A semantic row arrives with ``score`` set to its raw cosine similarity in
    [0, 1] (see :func:`postgres_semantic_search`). For RANKING it is converted
    onto the lexical score's scale by ``_SEMANTIC_SCORE_WEIGHT``, and a document
    both legs found keeps the sum — that arithmetic is unchanged.

    The raw cosine is recorded on the result before it is overwritten, because
    it is the only honest measure of how sure the semantic leg is and the merged
    score destroys it (tripl-txcz). ``finalize_results`` reads it back; nothing
    else does, and it never reaches the API response.
    """
    merged: dict[uuid.UUID, SearchResult] = {item.id: item for item in lexical_results}
    for item in semantic_results:
        existing = merged.get(item.id)
        cosine = max(0.0, item.score)
        semantic_score = cosine * _SEMANTIC_SCORE_WEIGHT
        if existing is None:
            item.score = semantic_score
            item.semantic_used = True
            item.record_semantic_cosine(cosine)
            merged[item.id] = item
            continue
        existing.score += semantic_score
        existing.semantic_used = True
        existing.record_semantic_cosine(cosine)
    return sorted(merged.values(), key=lambda item: (-item.score, item.title))[:limit]


def finalize_results(items: list[SearchResult], limit: int) -> list[SearchResult]:
    """Apply the cross-entity event-type boost, then rank, trim, and stamp confidence.

    CONFIDENCE IS ABSOLUTE, NOT RELATIVE TO THE TOP HIT (tripl-txcz)
    ---------------------------------------------------------------
    This used to divide every score by the top score, which makes the best
    result of ANY result set exactly 1.0 by construction. The number therefore
    could not express the one thing a user needs from it — "I did not really
    find what you asked for" — and the UI paints it as a percentage badge.
    Measured on production: ``q='asdkjhasd'`` (pure keyboard mash) was served at
    confidence 1.0 on an absolute score of 0.636.

    The fraction is now taken against ``_FULL_CONFIDENCE_SCORE``, the score a
    document reaches when it IS the thing that was typed, so confidence means
    the same thing across queries: it is comparable between two searches, it
    falls when the match is weak, and it reaches 1.0 only when the ranking
    arithmetic actually says so. The relative ORDER of results is untouched —
    this changes the number attached to a result, not which result wins.

    BOTH LEGS HAVE TO BE ABLE TO SAY "CERTAIN"
    ------------------------------------------
    Taking that fraction off the merged score alone would have quietly done to
    the semantic leg what the same issue forbids doing to it deliberately. A
    vector-only hit is scored ``cosine * _SEMANTIC_SCORE_WEIGHT`` for ranking,
    so its score cannot exceed 2.5 and a PERFECT cosine of 1.0 would have been
    reported at 2.5 / 7.0 = 0.357 — a semantic rescue of 'пейволл' or 'forcast',
    the queries that leg exists for, served to the user as barely-a-guess.

    So confidence is the maximum of the two certainties the result actually
    carries:

    * the ABSOLUTE score certainty, ``score / _FULL_CONFIDENCE_SCORE`` capped at
      1.0, which is what the lexical ladder (and the SQLite fallback's tiers)
      express;
    * for a result the semantic leg produced, its cosine similarity, which is
      already a [0, 1] certainty and needs no rescaling at all.

    ``max`` rather than a sum or a blend: the two are alternative pieces of
    evidence for the same claim ("this is what you meant"), so a document that
    one leg is sure about is a confident answer even when the other leg is
    indifferent to it, and neither can drag the other down. The RANKING still
    sees only the merged score — this function decides what number is painted on
    a result, never where it sits.
    """
    boosted = _apply_event_type_boost(items)
    boosted.sort(key=lambda item: (-item.score, item.title))
    trimmed = boosted[:limit]
    for item in trimmed:
        score_confidence = min(1.0, max(0.0, item.score) / _FULL_CONFIDENCE_SCORE)
        semantic_confidence = item.semantic_cosine or 0.0
        item.confidence = round(max(score_confidence, semantic_confidence), 4)
    return trimmed


def _apply_event_type_boost(items: list[SearchResult]) -> list[SearchResult]:
    """Lift events whose event type matches the query.

    When a descriptive query resolves to an event type (e.g. "экран спота"
    matching the ``pageviews`` type), every event of that type gets a
    multiplicative score boost proportional to how strongly the type matched.
    Type relevance is derived from the candidate set itself (the ``event_type``
    documents present in it), so this works for both the Postgres
    (lexical + semantic) and SQLite paths without an extra query.
    """
    type_scores: dict[str, float] = {}
    for item in items:
        if item.entity_type == "event_type":
            key = _normalize(item.title)
            if key:
                type_scores[key] = max(type_scores.get(key, 0.0), item.score)
    top_type = max(type_scores.values(), default=0.0)
    if top_type <= 0:
        return items
    for item in items:
        if item.entity_type != "event" or not item.subtitle:
            continue
        relevance = type_scores.get(_normalize(item.subtitle), 0.0) / top_type
        if relevance > 0:
            item.score *= 1.0 + _TYPE_BOOST_WEIGHT * relevance
    return items


async def enrich_event_hits(
    session: AsyncSession,
    items: list[SearchResult],
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    event_ids: set[uuid.UUID] = set()
    for item in items:
        if item.parent_event_id is not None:
            event_ids.add(item.parent_event_id)
    if not event_ids:
        return

    rows = (
        await session.execute(
            select(Event.id, Event.name, Event.status).where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.id.in_(event_ids),
            )
        )
    ).all()
    events_by_id: dict[uuid.UUID, tuple[str, str]] = {
        event_id: (name, status) for event_id, name, status in rows
    }

    variable_rows = (
        await session.execute(
            select(
                VariableValue.id,
                VariableValue.event_id,
                VariableValue.variable_id,
                Variable.name,
                VariableValue.field_definition_id,
                FieldDefinition.name,
                FieldDefinition.display_name,
                VariableValue.source_column,
                VariableValue.value_kind,
                VariableValue.observed_count,
                VariableValue.values,
            )
            .join(Variable, VariableValue.variable_id == Variable.id)
            .join(FieldDefinition, VariableValue.field_definition_id == FieldDefinition.id)
            .where(
                VariableValue.project_id == project_id,
                VariableValue.branch_id == branch_id,
                VariableValue.event_id.in_(event_ids),
                FieldDefinition.sensitivity == "none",
            )
            .order_by(
                VariableValue.event_id.asc(),
                FieldDefinition.order.asc(),
                FieldDefinition.name.asc(),
                Variable.name.asc(),
            )
        )
    ).all()
    variable_values_by_event: dict[uuid.UUID, list[SearchEventVariableValue]] = {}
    for (
        context_id,
        event_id,
        variable_id,
        variable_name,
        field_definition_id,
        field_name,
        field_display_name,
        source_column,
        value_kind,
        observed_count,
        values,
    ) in variable_rows:
        variable_values_by_event.setdefault(event_id, []).append(
            SearchEventVariableValue(
                id=context_id,
                variable_id=variable_id,
                variable_name=variable_name,
                field_definition_id=field_definition_id,
                field_name=field_name,
                field_display_name=field_display_name,
                source_column=source_column,
                value_kind=value_kind,
                observed_count=observed_count,
                values=list(values or []),
            )
        )

    for item in items:
        if item.parent_event_id is None:
            continue
        event_state = events_by_id.get(item.parent_event_id)
        if event_state is None:
            continue
        name, status = event_state
        item.event_id = item.parent_event_id
        item.name = name
        item.implemented = status in ("implemented", "live")
        item.variable_values = variable_values_by_event.get(item.parent_event_id, [])


def row_to_result(row: object, query: str, *, semantic_used: bool) -> SearchResult:
    mapping = cast(Mapping[str, object], row)
    score_raw = mapping["score"]
    score = float(str(score_raw)) if score_raw is not None else 0.0
    return SearchResult(
        id=uuid.UUID(str(mapping["id"])),
        entity_type=cast(SearchEntityType, str(mapping["entity_type"])),
        entity_id=uuid.UUID(str(mapping["entity_id"])),
        parent_event_id=uuid.UUID(str(mapping["parent_event_id"]))
        if mapping["parent_event_id"] is not None
        else None,
        title=str(mapping["title"]),
        subtitle=str(mapping["subtitle"] or ""),
        description=str(mapping.get("description") or ""),
        snippet=snippet(str(mapping["body"] or ""), query),
        route_path=str(mapping["route_path"]),
        score=score,
        highlights=highlights(str(mapping["title"]), str(mapping["body"] or ""), query),
        semantic_used=semantic_used,
    )


def document_to_result(
    document: SearchDocument,
    score: float,
    query: str,
    *,
    semantic_used: bool,
) -> SearchResult:
    return SearchResult(
        id=document.id,
        entity_type=cast(SearchEntityType, document.entity_type),
        entity_id=document.entity_id,
        parent_event_id=document.parent_event_id,
        title=document.title,
        subtitle=document.subtitle,
        description=document.description or "",
        snippet=snippet(document.body, query),
        route_path=document.route_path,
        score=score,
        highlights=highlights(document.title, document.body, query),
        semantic_used=semantic_used,
    )


def snippet(body: str, query: str, *, length: int = 180) -> str:
    from tripl.services._search_documents import _clean

    text_body = _clean(body)
    if not text_body:
        return ""
    query_norm = _normalize(query)
    body_norm = _normalize(text_body)
    idx = body_norm.find(query_norm) if query_norm else -1
    if idx < 0:
        return text_body[:length]
    start = max(0, idx - 60)
    end = min(len(text_body), start + length)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(text_body) else ""
    return f"{prefix}{text_body[start:end]}{suffix}"


def highlights(title: str, body: str, query: str) -> list[str]:
    result: list[str] = []
    for token in _tokens(query)[:4]:
        for source in (title, body):
            source_norm = _normalize(source)
            idx = source_norm.find(token)
            if idx >= 0:
                result.append(source[max(0, idx - 20) : idx + len(token) + 40].strip())
                break
    return result

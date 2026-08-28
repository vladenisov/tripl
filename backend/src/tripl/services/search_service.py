"""Search service — public API, and the index write path.

This module is the stable import surface for all callers, and it OWNS the
reindex side: the incremental diff (:func:`_reindex_branch_documents`), the
builder-version stamp, the demo-fixture embedding path, and the ``text_vector``
/ index DDL. Read-side implementation is delegated to two private siblings:

* ``_search_documents``  — building a branch's documents, one builder per kind
* ``_search_query``      — querying, ranking, result shaping

Calling this a pure facade (as this docstring once did) is what let reviewers
skip the half of the subsystem that actually writes rows.
"""

from __future__ import annotations

import dataclasses
import logging
import math
import uuid

from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.project import Project
from tripl.models.search_document import SearchDocument
from tripl.schemas.search import (
    SearchEntityType,
    SearchResponse,
    SearchResult,
)
from tripl.services import app_settings_service
from tripl.services._search_documents import (
    DOCUMENT_BUILDER_VERSION,
    BuiltDocument,
)
from tripl.services._search_documents import (
    build_documents as _build_documents,
)
from tripl.services._search_query import (
    _is_postgres,
    _safe_limit,
    fallback_score,
    merge_results,
)
from tripl.services._search_query import (
    enrich_event_hits as _enrich_event_hits,
)
from tripl.services._search_query import (
    finalize_results as _finalize_results,
)
from tripl.services._search_query import (
    postgres_search as _postgres_search,
)
from tripl.services._search_query import (
    sanitize_query as _sanitize_query,
)
from tripl.services._search_query import (
    sqlite_search as _sqlite_search,
)
from tripl.services._search_query import (
    token_boundary_regex as _token_boundary_regex,
)
from tripl.services.app_settings_service import AiConfig
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug

logger = logging.getLogger(__name__)

# Re-export types / helpers that tests and callers may reference directly.
__all__ = [
    "CANDIDATE_WINDOW",
    "AiConfig",
    "BuiltDocument",
    "ReindexOutcome",
    "SearchEntityType",
    "SearchResponse",
    "SearchResult",
    "_finalize_results",
    "_queue_branch_reindex",
    "_queue_embedding_refresh",
    "_reindex_branch_documents",
    "_sanitize_query",
    "_token_boundary_regex",
    "fallback_score",
    "merge_results",
    "reindex_branch",
    "reindex_project_branch",
    "sanitize_embedding",
    "search_event_ids",
    "search_project",
]


def _doc_to_model(
    doc: BuiltDocument,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    ai_config: AiConfig,
) -> SearchDocument:
    return SearchDocument(
        project_id=project_id,
        branch_id=branch_id,
        entity_type=doc.entity_type,
        entity_id=doc.entity_id,
        parent_event_id=doc.parent_event_id,
        title=doc.title,
        subtitle=doc.subtitle,
        description=doc.description,
        body=doc.body,
        keywords=doc.keywords,
        route_path=doc.route_path,
        archived=doc.archived,
        content_hash=doc.content_hash,
        builder_version=DOCUMENT_BUILDER_VERSION,
        embedding_status="pending" if ai_config.search_embeddings_enabled else "disabled",
        embedding_model=ai_config.search_embedding_model
        if ai_config.search_embeddings_enabled
        else None,
    )


@dataclasses.dataclass(frozen=True, slots=True)
class ReindexOutcome:
    """What a reindex DID, which is not the same as what it was configured to do.

    ``embeddings_scheduled`` used to be answered by the caller re-reading the
    ``search_embeddings_enabled`` flag, so the API reported a refresh as queued
    whenever the feature was switched on — including when the broker was down and
    the enqueue had just been swallowed by the ``except`` in
    :func:`_queue_embedding_refresh` (tripl-0tt4 item 6). The operator reading
    that response is deciding whether to go and look at the queue, so it has to
    mean "a task was handed to the broker", not "a task would have been if
    everything worked".
    """

    documents_indexed: int
    embeddings_scheduled: bool


async def reindex_branch(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID | None = None,
    *,
    schedule_embeddings: bool = True,
) -> ReindexOutcome:
    project_id = await get_project_id_by_slug(session, slug)
    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    return await reindex_project_branch(
        session,
        project_id=project_id,
        branch_id=resolved_branch_id,
        slug=slug,
        schedule_embeddings=schedule_embeddings,
    )


# Stale rows are deleted by primary key in bounded chunks so the ``IN ()``
# list stays a sane size for the driver/planner on large branches.
_REINDEX_DELETE_CHUNK = 500


def _embedding_state_reusable(
    *,
    status: str,
    model: str | None,
    enabled: bool,
    current_model: str,
    demo_fixture_model: str | None = None,
) -> bool:
    """Whether a content-unchanged row's embedding state fits the current config.

    See :func:`_reindex_branch_documents` for the full reasoning; in short,
    ``failed`` rows are never reused (so every reindex retries them) and
    ``ready`` rows are reused only under the same model.

    ``demo_fixture_model`` is set only for the keyless demo (embeddings
    disabled, demo project, fixture present): fixture-stamped rows are
    ``ready`` under the fixture's model, and dropping them on every reindex
    would defeat the incremental diff and open a committed window with no
    semantic-eligible rows.
    """
    if not enabled:
        if status == "ready" and demo_fixture_model is not None:
            return model == demo_fixture_model
        return status == "disabled"
    return status == "pending" or (status == "ready" and model == current_model)


async def _reindex_branch_documents(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
) -> tuple[int, AiConfig]:
    """Incrementally rebuild the branch's search index WITHOUT committing.

    Diffs the freshly built documents against the existing rows on the unique
    ``(entity_type, entity_id)`` key instead of delete-all + insert-all, so an
    unchanged row survives the reindex with its ``text_vector`` and embedding
    intact. A row is KEPT only when its ``content_hash`` equals the rebuilt
    document's hash — identical hash means identical searchable text, so the
    stored row (including its text vector and any ready embedding) can stay
    untouched — AND its embedding state is consistent with the current config:

    * embeddings disabled: only ``disabled`` rows are kept;
    * embeddings enabled: ``pending`` rows are kept (the queued refresh picks
      them up) and ``ready`` rows are kept only under the SAME model — a
      ``ready`` row under a different model is re-inserted as ``pending`` so
      the index never mixes vectors from different models;
    * ``failed`` rows are deliberately NOT kept, so any reindex retries them;
    * ``disabled`` rows are not kept once embeddings are enabled (they would
      otherwise never get embedded).

    Everything else is deleted and re-inserted with the status derived from
    the config (see ``_doc_to_model``). The work participates in the caller's
    transaction and the caller owns the commit; callers that mutate primary
    data first can thus cover the data write and the index rebuild in a single
    atomic transaction.

    Returns the document count and the resolved ``AiConfig`` so the caller can
    schedule the fire-and-forget embedding refresh *after* its commit succeeds.
    """
    project_slug = slug or await _project_slug(session, project_id)
    documents = await _build_documents(session, project_id, branch_id, project_slug)
    ai_config = await app_settings_service.get_ai_config(session)
    demo_fixture_model = await _demo_fixture_model(session, project_id, ai_config)

    existing_rows = (
        await session.execute(
            select(
                SearchDocument.id,
                SearchDocument.entity_type,
                SearchDocument.entity_id,
                SearchDocument.content_hash,
                SearchDocument.builder_version,
                SearchDocument.embedding_status,
                SearchDocument.embedding_model,
            ).where(
                SearchDocument.project_id == project_id,
                SearchDocument.branch_id == branch_id,
            )
        )
    ).all()
    existing = {(row.entity_type, row.entity_id): row for row in existing_rows}

    keep_ids: set[uuid.UUID] = set()
    to_insert: list[BuiltDocument] = []
    for doc in documents:
        row = existing.get((doc.entity_type, doc.entity_id))
        if (
            row is not None
            and row.content_hash == doc.content_hash
            and _embedding_state_reusable(
                status=row.embedding_status,
                model=row.embedding_model,
                enabled=ai_config.search_embeddings_enabled,
                current_model=ai_config.search_embedding_model,
                demo_fixture_model=demo_fixture_model,
            )
        ):
            keep_ids.add(row.id)
        else:
            to_insert.append(doc)

    delete_ids = [row.id for row in existing.values() if row.id not in keep_ids]
    for start in range(0, len(delete_ids), _REINDEX_DELETE_CHUNK):
        chunk = delete_ids[start : start + _REINDEX_DELETE_CHUNK]
        await session.execute(delete(SearchDocument).where(SearchDocument.id.in_(chunk)))

    # A KEPT row was written by an older builder generation but its stored text
    # is byte-identical to what the current builders just produced — that is what
    # the content_hash comparison above proved. So it is current in substance and
    # only its stamp is behind; stamping it here is what lets the staleness sweep
    # converge. Without this a branch whose documents all survive the diff would
    # come back due on every pass, forever (tripl-uji9).
    restamp_ids = [
        row.id
        for row in existing.values()
        if row.id in keep_ids and row.builder_version != DOCUMENT_BUILDER_VERSION
    ]
    for start in range(0, len(restamp_ids), _REINDEX_DELETE_CHUNK):
        chunk = restamp_ids[start : start + _REINDEX_DELETE_CHUNK]
        await session.execute(
            update(SearchDocument)
            .where(SearchDocument.id.in_(chunk))
            .values(builder_version=DOCUMENT_BUILDER_VERSION)
        )
    if to_insert:
        session.add_all(
            [
                _doc_to_model(
                    doc,
                    project_id=project_id,
                    branch_id=branch_id,
                    ai_config=ai_config,
                )
                for doc in to_insert
            ]
        )
    await session.flush()
    if _is_postgres(session):
        await _refresh_text_vectors(session, project_id, branch_id)
    return len(documents), ai_config


async def reindex_project_branch(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
    schedule_embeddings: bool = True,
) -> ReindexOutcome:
    count, ai_config = await _reindex_branch_documents(
        session,
        project_id=project_id,
        branch_id=branch_id,
        slug=slug,
    )
    await session.commit()

    if await _apply_demo_search_embeddings(
        session,
        project_id=project_id,
        branch_id=branch_id,
        ai_config=ai_config,
    ):
        await session.commit()

    scheduled = False
    if schedule_embeddings:
        scheduled = _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    return ReindexOutcome(documents_indexed=count, embeddings_scheduled=scheduled)


async def _demo_fixture_model(
    session: AsyncSession,
    project_id: uuid.UUID,
    ai_config: AiConfig,
) -> str | None:
    """Fixture model whose stamped rows the incremental reindex may reuse.

    Non-``None`` only for the keyless demo case (embeddings disabled, Postgres,
    demo project, fixture present) — everywhere else the plain
    :func:`_embedding_state_reusable` rules apply unchanged.
    """
    if ai_config.search_embeddings_enabled or not _is_postgres(session):
        return None
    is_demo = await session.scalar(select(Project.is_demo).where(Project.id == project_id))
    if not is_demo:
        return None
    from tripl.services.demo.search_embeddings import load_demo_embedding_fixture

    fixture = load_demo_embedding_fixture()
    return fixture.model if fixture is not None else None


async def _apply_demo_search_embeddings(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    ai_config: AiConfig,
) -> int:
    """Keyless demo semantic search: stamp precomputed fixture vectors.

    Postgres + demo projects only. Covers every path through
    :func:`reindex_project_branch` — demo provisioning/reset, the lazily built
    demo feature-branch index, and manual reindex. A missing or stale fixture
    makes this a no-op and the demo stays lexical-only, exactly as before.

    When live embeddings are enabled under a model DIFFERENT from the
    fixture's, stamping is skipped entirely: flipping the freshly inserted
    ``pending`` rows to ``ready`` with fixture vectors would hide them from
    the embedding worker and cosine-rank live query vectors against another
    model's vector space. The queued worker embeds them instead.
    """
    if not _is_postgres(session):
        return 0
    is_demo = await session.scalar(select(Project.is_demo).where(Project.id == project_id))
    if not is_demo:
        return 0
    from tripl.services.demo.search_embeddings import (
        apply_demo_embedding_fixture,
        load_demo_embedding_fixture,
    )

    fixture = load_demo_embedding_fixture()
    if fixture is None:
        return 0
    if ai_config.search_embeddings_enabled and ai_config.search_embedding_model != fixture.model:
        return 0
    return await apply_demo_embedding_fixture(
        session,
        project_id=project_id,
        branch_id=branch_id,
    )


#: How many rows each retrieval leg pulls before fusion, no matter what page
#: size the caller asked for (tripl-0tt4 item 2).
#:
#: WHY THE WINDOW MUST NOT TRACK THE PAGE SIZE
#: -------------------------------------------
#: :func:`merge_results` SUMS the two legs: a document found lexically AND
#: semantically keeps ``lexical + cosine * weight``, while a document found by
#: one leg keeps only that leg's score. So the bonus is not a property of the
#: document — it is a property of the document having landed inside BOTH
#: windows. Shrink the window and a document that was #35 semantically silently
#: stops being paid for it, which moves the TOP of the list, not just its tail.
#:
#: The previous rule (``+24`` while ``capped_limit < 50``) was also not
#: monotonic: ``limit=49`` retrieved 73 candidates and ``limit=50`` retrieved
#: 50, so asking for MORE results made the engine consider FEWER of them. That
#: is what produced the reported fault — ``q='экран спота'`` answering with a
#: different top-1 at ``limit=5`` than at ``limit=50``.
#:
#: WHY 100
#: -------
#: It is above every window the old rule could produce (its maximum was 73), so
#: no interactive query retrieves fewer candidates than it does today, and it
#: equals the page size cap on ``GET /search`` (``Query(le=100)``), so the
#: largest page the HTTP API can ask for is exactly one window. ``max`` rather
#: than a plain constant because bulk callers legitimately want more:
#: :func:`search_event_ids` passes ``limit=10000`` and must keep retrieving
#: 10000, not 100.
#:
#: AND ONE ROW PAST IT (tripl-wkwv.3)
#: ----------------------------------
#: :func:`search_project` asks each leg for ``candidate_limit + 1``. Every leg
#: and :func:`merge_results` stop at whatever number they are handed, so a leg
#: that came back exactly full is indistinguishable from one that returned
#: everything there was — and ``truncated`` exists to tell those two apart. The
#: probe row is ranked with the rest and then dropped by ``finalize_results``,
#: which trims to the page size, so it cannot appear in an answer; it only makes
#: saturation observable instead of guessed. It does not reintroduce the fault
#: above either: the retrieved window is still the same for every page size
#: below the cap, and still monotonic in ``limit``.
CANDIDATE_WINDOW = 100


async def search_project(
    session: AsyncSession,
    slug: str,
    query: str,
    *,
    branch_id: uuid.UUID | None = None,
    entity_types: list[SearchEntityType] | None = None,
    include_archived: bool = False,
    limit: int = 20,
) -> SearchResponse:
    # Sanitize here rather than in the router: this is the single funnel every
    # caller goes through (HTTP search, ai_service.ask_plan, search_event_ids),
    # and it runs before the dialect split so the lexical SQL, the embedding
    # call, and the demo fixture lookup all see the same cleaned string.
    normalized_query = _sanitize_query(query)
    if not normalized_query:
        return SearchResponse(items=[], total=0, truncated=False, semantic_used=False)

    project_id = await get_project_id_by_slug(session, slug)
    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _ensure_index_exists(session, project_id, resolved_branch_id)

    capped_limit = _safe_limit(limit)
    candidate_limit = max(capped_limit, CANDIDATE_WINDOW)
    # One row past the window, so a full window can be told apart from "that was
    # everything" (tripl-wkwv.3). See CANDIDATE_WINDOW for why the probe cannot
    # reach an answer.
    retrieval_limit = candidate_limit + 1

    if _is_postgres(session):
        project_is_demo = bool(
            await session.scalar(select(Project.is_demo).where(Project.id == project_id))
        )
        items, semantic_used = await _postgres_search(
            session,
            project_id=project_id,
            branch_id=resolved_branch_id,
            query=normalized_query,
            entity_types=entity_types,
            include_archived=include_archived,
            limit=retrieval_limit,
            project_is_demo=project_is_demo,
        )
    else:
        items = await _sqlite_search(
            session,
            project_id=project_id,
            branch_id=resolved_branch_id,
            query=normalized_query,
            entity_types=entity_types,
            include_archived=include_archived,
            limit=retrieval_limit,
        )
        semantic_used = False

    # The retrieved set, measured BEFORE the trim: `total` is `len(items)` by
    # construction and therefore equals `limit` on any full page, so it can never
    # say whether hits were dropped (tripl-wkwv.3). This count is free — the rows
    # are already in memory — and answers that.
    candidate_count = len(items)
    items = _finalize_results(items, capped_limit)
    await _enrich_event_hits(
        session,
        items,
        project_id=project_id,
        branch_id=resolved_branch_id,
    )
    return SearchResponse(
        items=items,
        total=len(items),
        # A dropped hit, observed rather than inferred. `retrieval_limit` fetched
        # one row past the window, so a retrieved set bigger than the page IS a
        # hit this response does not carry, and a set that fits IS the whole
        # answer — which is what every consumer of this flag was already told it
        # means (tripl-wkwv.3).
        #
        # There is deliberately no `candidate_count >= candidate_limit` disjunct
        # beside it. That reads "the window filled", which is a different claim:
        # at `limit=100` — the maximum `GET /search` accepts — a query matching
        # exactly 100 documents fills the window while the body carries every hit
        # either leg can produce, and the flag would have said `true` with no
        # `limit` left to raise.
        truncated=candidate_count > len(items),
        semantic_used=semantic_used,
    )


async def search_event_ids(
    session: AsyncSession,
    slug: str,
    query: str,
    *,
    branch_id: uuid.UUID | None = None,
    include_archived: bool = True,
    limit: int = 10000,
) -> list[uuid.UUID]:
    response = await search_project(
        session,
        slug,
        query,
        branch_id=branch_id,
        entity_types=["event", "tag"],
        include_archived=include_archived,
        limit=limit,
    )
    event_ids: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for item in response.items:
        event_id = item.parent_event_id if item.parent_event_id is not None else item.entity_id
        if event_id not in seen:
            seen.add(event_id)
            event_ids.append(event_id)
    return event_ids


async def _project_slug(session: AsyncSession, project_id: uuid.UUID) -> str:
    project = await session.get(Project, project_id)
    if project is None:
        msg = f"Project {project_id} not found"
        raise ValueError(msg)
    return project.slug


#: Branches whose read-path index check this process has already answered.
#:
#: An entry can never become a WRONG answer: ids are ``uuid4`` and a deleted
#: project or branch never comes back, so a stale key costs two uuids of memory
#: and nothing else.
_CHECKED_BRANCH_INDEXES: set[tuple[uuid.UUID, uuid.UUID]] = set()


def _queue_branch_reindex(project_id: uuid.UUID, branch_id: uuid.UUID) -> bool:
    """Hand one branch's rebuild to the worker; ``False`` if the broker refused.

    Same shape as :func:`_queue_embedding_refresh`: a search GET must not 500
    because the broker is down, so the failure is logged and reported back, never
    raised at the caller.
    """
    try:
        from tripl.worker.celery_app import celery_app

        celery_app.send_task(
            "tripl.worker.tasks.search.reindex_search_branch",
            args=[str(project_id), str(branch_id)],
        )
    except Exception:
        logger.exception(
            "Failed to queue search reindex for project %s branch %s", project_id, branch_id
        )
        return False
    return True


async def _ensure_index_exists(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    """Ask for the branch's index once — the first time this process searches it.

    WHY THE ANSWER IS KEPT FOR THE PROCESS LIFETIME (tripl-2x5d)
    ------------------------------------------------------------
    The probe answers one question — has this branch ever been indexed — and the
    only thing a "no" can trigger is one rebuild. Both are dead weight afterwards,
    and the command palette is not a once-a-page caller: it issues a request per
    debounce boundary, so every keystroke that crossed one paid for this round
    trip before any searching started.

    The case that actually hurt is the branch that indexes to ZERO documents (a
    project whose catalog is still empty). Its probe answers ``None`` forever, so
    without the memo EVERY search re-ran a full :func:`reindex_project_branch`
    from a GET: build every document, diff it against the table, delete, insert,
    and COMMIT.

    WHY THE BUILD IS ENQUEUED RATHER THAN RUN HERE (tripl-zbv0)
    -----------------------------------------------------------
    The memo bounded that cost to once per branch; the first search still paid it
    in full, inside a GET, with the user waiting. It is handed to
    ``tripl.worker.tasks.search.reindex_search_branch`` instead, which makes the
    price explicit rather than hidden: the FIRST search of a never-indexed branch
    answers with an empty list and the branch is searchable from the next one.
    Nothing else could enqueue it — the staleness sweep in
    ``worker/tasks/search.py`` selects on ``builder_version``, so it cannot see a
    branch that has no rows at all.

    The memo is recorded whether or not the enqueue succeeded, so a broker outage
    costs one wasted attempt per branch instead of one per search. A branch left
    unindexed that way is picked up by the same triggers every other branch
    relies on: a CRUD mutation, the post-scan reindex of main, or an explicit
    ``POST /search/reindex``. Those triggers now cover every document kind — the
    ``scan_config``/``alert_rule`` gap this docstring used to describe was closed
    by tripl-ugrm.
    """
    memo_key = (project_id, branch_id)
    if memo_key in _CHECKED_BRANCH_INDEXES:
        return
    exists = await session.scalar(
        select(SearchDocument.id)
        .where(SearchDocument.project_id == project_id, SearchDocument.branch_id == branch_id)
        .limit(1)
    )
    # The dialect check is not a test accommodation: ``reindex_branch_from_worker``
    # returns immediately on any non-postgresql bind, so publishing the message
    # from one would hand the broker work no worker can do. Production is
    # PostgreSQL (see ``config.Settings.database_url``); a SQLite bind keeps the
    # index it gets from mutations and merges, and gets no lazy first build.
    if exists is None and _is_postgres(session):
        _queue_branch_reindex(project_id, branch_id)
    _CHECKED_BRANCH_INDEXES.add(memo_key)


#: The stored-vector expression: the STEMMED lexemes of a document, plus its
#: SURFACE lexemes, in one tsvector (tripl-uojz).
#:
#: WHY BOTH, WHEN a7c3e1b9d5f2 JUST FINISHED ARGUING FOR THE STEM
#: --------------------------------------------------------------
#: Stemming was right and is kept. What it did not anticipate is that Snowball
#: OVER-stems, and that it over-stems the shortest form of a word — the bare
#: nominative — hardest. Measured on production: ``to_tsvector('tripl_search',
#: 'уловы улов уловов')`` is ``'ул':2 'улов':1,3``. Russian Snowball computes its
#: RV region for ``улов`` as ``лов``, that region ends in ``ов`` (the masculine
#: genitive-plural ending), so the ending is stripped and the nominative lands on
#: ``ул`` — a lexeme NO inflected form of the same word ever produces. Every
#: inflected form lands on ``улов``. The word is therefore split into two
#: disjoint lexical classes by the very dictionary that was supposed to unify it.
#:
#: This is not one unlucky word. Measured lemma / over-stem, with the number of
#: production ``search_documents`` rows holding each:
#:
#:     экран/экра 414/3971 · показа/показ 341/429 · открыт/откр 302/260
#:     закрыт/закр 183/100 · создан/созда 124/172 · найден/найд 18/181
#:     выключен/выключ 10/137 · архив/арх 23/53 · улов/ул 151/0
#:
#: Which FORM produces which lexeme is looked up, not inferred — the natural
#: guess is wrong for the word with the biggest numbers::
#:
#:     экран -> экра · экрана -> экра · экраны -> экра · экране -> экран
#:
#: That table also kills the cheap fix. A query-side-only expansion assumes the
#: documents stranded on the over-stem are a negligible tail. They are the
#: MAJORITY for ``экран``: 3971 rows store the over-stem ``экра`` and 414 store
#: ``экран``. Under a stem-only index ``q='экране'`` expands to
#: ``'экран' | 'экране'``, reaches the 414 and misses the 3971 — and nothing on
#: the query side can ever reach them, because they store a lexeme (``экра``)
#: that is not a word anyone types. (``q='экрана'`` is the mirror trap: it
#: expands to ``'экра' | 'экрана'``, reaches the 3971 on its stem exactly as it
#: did before, and its surface term matches nothing at all, since a stem-only
#: index stores ``экрана`` nowhere.) The breakage is bidirectional and the
#: DOCUMENT side is the one that has to carry the surface form.
#:
#: WHAT THE SECOND LEG BUYS, STATED AS A CONDITION AND NOT AS A SLOGAN
#: -------------------------------------------------------------------
#: A document (and a query) now carries ``{stem(w), surface(w)}`` for every token
#: ``w``. Two forms A and B of one word meet iff those two sets intersect. They
#: already met when ``stem(A) == stem(B)``; the new leg adds the case that was
#: missing, ``surface(A) == stem(B)`` — which is EXACTLY the over-stem failure,
#: because the form that gets over-stripped is spelled the same as the stem the
#: forms in the OTHER class produce. ``улов`` indexes ``{ул, улов}``, ``уловы``
#: indexes ``{улов, уловы}``, and they meet on ``улов`` from either direction;
#: ``экран`` ``{экра, экран}`` and ``экране`` ``{экран, экране}`` meet on
#: ``экран``, having met nowhere before.
#:
#: It is not a universal guarantee and should not be sold as one: two forms that
#: BOTH over-stem, to different lexemes, and whose surfaces match neither stem,
#: still miss each other — measured, not hypothetical: ``экрана``
#: ``{экра, экрана}`` against ``экране`` ``{экран, экране}`` is disjoint and this
#: change does not repair it. What it repairs is every pair with an over-stemmed
#: form on one side, which is the population the row counts above are about.
#:
#: It also does not, and cannot, guarantee that two DIFFERENT words stay apart.
#: ``surface(A) == stem(B)`` is a string equality; nothing in it asks whether A
#: and B are forms of one word, so an unrelated word spelled like another's stem
#: now matches it. What IS guaranteed is that the change is purely additive (both
#: legs OR-ed on both sides, the stem leg unchanged, so no existing match is
#: lost) and that new matches require a whole shared spelling rather than a
#: prefix. The residue is checked empirically over this vocabulary by
#: ``tests/relevance/test_stemming_invariants.py``, not argued.
#:
#: WHY A SECOND CONFIGURATION RATHER THAN ``'simple'``
#: ---------------------------------------------------
#: ``tripl_search_surface`` (created by the migration that introduced this
#: expression) is byte-for-byte what ``tripl_search`` was BEFORE a7c3e1b9d5f2:
#: ``COPY = simple`` with the six word token types on ``unaccent, simple``. The
#: ``unaccent`` is load-bearing, not decoration. The stem leg unaccents a token
#: before stemming it, so ``зачёты`` stems via ``зачеты``; if the surface leg
#: skipped ``unaccent`` it would index ``зачёт`` while the stem leg of every
#: inflected form produced ``зачет``, and the ``surface(A) == stem(B)`` identity
#: the whole fix rests on would break on every word containing ``ё``.
#:
#: This is NOT the per-language pair a7c3e1b9d5f2 rejected. That rejection was
#: about needing to CLASSIFY a query (``spot`` vs ``спот`` vs ``screen спота``)
#: to pick one configuration, and about two stored columns and two indexes. Here
#: both configurations are applied unconditionally to every token, nothing is
#: classified, and the two results are concatenated into the ONE existing
#: ``text_vector`` behind the ONE existing GIN index.
#: THE TITLE IS WEIGHTED, EVERYTHING ELSE IS NOT (tripl-dito)
#: ----------------------------------------------------------
#: ``setweight`` was never used, so every lexeme was weight D and ``ts_rank_cd``
#: scaled all of them by the same 0.1 from its default ``{0.1, 0.2, 0.4, 1.0}``.
#: The lexical leg therefore could not tell a title match from a body match at
#: all — measured, 1305 inverted pairs out of 8224 on the final score.
#:
#: WHY ONLY THE TITLE, AND WHY THE REST IS PINNED AT D RATHER THAN LEFT ALONE
#: Three variants were measured on production against the three real inversions.
#: Lifting ``keywords`` to B (the intuitive choice) FAILED: the documents in the
#: fault carry the query IN their keywords, because ``_variable_document``
#: writes the bound event's name there — ``${property.query}`` holds ``search``
#: from ``spotlight_search`` — so weighting keywords lifted the offender almost
#: as much as the victim and the inversion survived (paywall gap 0.92, lift
#: +0.689). Title-only closed all three and is also the simplest.
#:
#: ``'D'`` is written explicitly rather than relied on as the default because
#: that is what makes the guarantee readable: a document with no title match is
#: scored exactly as it was before this change. Measured, not argued — for
#: ``${property.newValue}``, ``${property.query}`` and
#: ``spot_screen_community_open_feed`` the final score moved 0.000.
#:
#: The leg is still bounded: flag 32 is ``rank/(rank+1)``, so ``lexical_score``
#: cannot exceed 1.0 however far an A-weighted rank climbs, and the ladder it is
#: calibrated against is untouched. What changes is discrimination WITHIN the
#: leg, which is the whole point.
TEXT_VECTOR_EXPRESSION = """
    setweight(to_tsvector('tripl_search', coalesce(title, '')), 'A')
    || setweight(to_tsvector('tripl_search_surface', coalesce(title, '')), 'A')
    || setweight(
        to_tsvector('tripl_search', concat_ws(' ', subtitle, body, keywords)),
        'D'
    )
    || setweight(
        to_tsvector(
            'tripl_search_surface',
            concat_ws(' ', subtitle, body, keywords)
        ),
        'D'
    )
"""


async def _refresh_text_vectors(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    """Vectorize the rows a reindex just inserted, with the stem+surface expression.

    THIS EXPRESSION AND THE MIGRATION'S MUST STAY BYTE-IDENTICAL (tripl-uojz)
    ------------------------------------------------------------------------
    A migration rebuilds every stored vector once; this function writes every
    vector produced after that. If the two expressions disagree, half the table
    is indexed one way and half the other, no error is raised anywhere, and the
    only symptom is that some documents are unreachable by some forms of some
    words — which is the bug being fixed, reintroduced silently and partially.
    a7c3e1b9d5f2 kept them in sync by copying the string and saying so in a
    docstring; that is a convention and a convention is not a check.

    So the string now lives in :data:`TEXT_VECTOR_EXPRESSION`, the migration
    keeps its own frozen copy (a migration must not import application code — it
    has to keep meaning what it meant on the day it ran), and
    ``tests/test_alembic_revisions.py`` compares the two constants directly. The
    duplication is deliberate; the silence about it was the defect.
    """
    # Only freshly inserted rows need vectorizing: rows kept by the
    # incremental reindex have an unchanged searchable text (identical
    # content_hash) and therefore still carry a valid text_vector.
    await session.execute(
        text(
            f"""
            UPDATE search_documents
            SET text_vector = {TEXT_VECTOR_EXPRESSION}
            WHERE project_id = :project_id AND branch_id = :branch_id
              AND text_vector IS NULL
            """  # noqa: S608 - no interpolation of user input; the operand is a module constant
        ),
        {"project_id": project_id, "branch_id": branch_id},
    )


def _queue_embedding_refresh(
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    *,
    ai_config: AiConfig,
) -> bool:
    if not ai_config.search_embeddings_enabled:
        return False
    try:
        from tripl.worker.celery_app import celery_app

        celery_app.send_task(
            "tripl.worker.tasks.search.embed_search_documents",
            args=[str(project_id), str(branch_id)],
        )
    except Exception:
        logger.exception("Failed to queue search embedding refresh")
        return False
    return True


def sanitize_embedding(values: list[float]) -> list[float]:
    sanitized = [float(value) for value in values]
    if len(sanitized) != settings.search_embedding_dimensions:
        return []
    if any(not math.isfinite(value) for value in sanitized):
        return []
    return sanitized

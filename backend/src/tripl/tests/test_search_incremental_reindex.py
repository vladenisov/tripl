"""Incremental search reindex (tripl-kt6v).

``_reindex_branch_documents`` diffs the rebuilt documents against existing
rows on ``(entity_type, entity_id)`` + ``content_hash`` instead of doing
delete-all + insert-all, so:

* content-unchanged rows keep their row id, ``text_vector`` and any *ready*
  embedding (as long as the embedding model matches the current config);
* ``failed`` rows are always re-inserted as ``pending`` so a reindex retries
  them;
* ``ready`` rows under a *different* model are re-inserted as ``pending`` so
  the index never mixes vectors from different models.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.config import settings
from tripl.models.search_document import SearchDocument
from tripl.services import search_service
from tripl.tests.conftest import TestSessionLocal
from tripl.tests.test_search import _create_event_type, _create_fact_metric, _create_fact_table

SENTINEL_EMBEDDING = [0.25, -0.5, 0.75]


async def _setup_project(client: AsyncClient, slug: str) -> tuple[dict, dict]:
    resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert resp.status_code == 201
    await _create_event_type(client, slug, name="pv", display_name="Page View")
    fact_table = await _create_fact_table(client, slug)
    metric = await _create_fact_metric(client, slug, fact_table["id"])
    return fact_table, metric


async def _docs_by_entity(project_id: uuid.UUID) -> dict[tuple[str, str], SearchDocument]:
    async with TestSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(SearchDocument).where(SearchDocument.project_id == project_id)
                )
            )
            .scalars()
            .all()
        )
        return {(row.entity_type, str(row.entity_id)): row for row in rows}


async def _set_embedding_state(
    doc_id: uuid.UUID,
    *,
    status: str,
    model: str | None,
    embedding: list[float] | None,
) -> None:
    async with TestSessionLocal() as session:
        doc = await session.get(SearchDocument, doc_id)
        assert doc is not None
        doc.embedding_status = status
        doc.embedding_model = model
        doc.embedding = embedding
        await session.commit()


async def _reindex(slug: str) -> None:
    async with TestSessionLocal() as session:
        await search_service.reindex_branch(session, slug, schedule_embeddings=False)


def _enable_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "search_embeddings_enabled", True)
    monkeypatch.setattr(settings, "search_embedding_api_key", "sk-test")
    # Keep the fire-and-forget Celery enqueue out of the test loop.
    monkeypatch.setattr(search_service, "_queue_embedding_refresh", lambda *args, **kwargs: False)


@pytest.mark.asyncio
async def test_reindex_keeps_rows_when_content_unchanged_and_embeddings_disabled(
    client: AsyncClient,
) -> None:
    _, metric = await _setup_project(client, "inc-disabled")
    project_id = uuid.UUID(metric["project_id"])

    before = await _docs_by_entity(project_id)
    assert before
    assert {row.embedding_status for row in before.values()} == {"disabled"}

    await _reindex("inc-disabled")

    after = await _docs_by_entity(project_id)
    assert {key: row.id for key, row in after.items()} == {
        key: row.id for key, row in before.items()
    }
    assert {row.embedding_status for row in after.values()} == {"disabled"}


@pytest.mark.asyncio
async def test_reindex_preserves_ready_embedding_and_reinserts_changed_docs(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_embeddings(monkeypatch)
    _, metric = await _setup_project(client, "inc-ready")
    project_id = uuid.UUID(metric["project_id"])
    metric_key = ("metric", metric["id"])

    before = await _docs_by_entity(project_id)
    assert before[metric_key].embedding_status == "pending"
    await _set_embedding_state(
        before[metric_key].id,
        status="ready",
        model=settings.search_embedding_model,
        embedding=SENTINEL_EMBEDDING,
    )

    # No content change: the row (id + ready embedding) survives the reindex.
    await _reindex("inc-ready")
    kept = await _docs_by_entity(project_id)
    assert kept[metric_key].id == before[metric_key].id
    assert kept[metric_key].embedding_status == "ready"
    assert kept[metric_key].embedding == SENTINEL_EMBEDDING

    # Content change: the metric's doc is re-inserted as pending; every other
    # document keeps its row untouched.
    renamed = await client.patch(
        f"/api/v1/projects/inc-ready/metrics/{metric['id']}",
        json={"display_name": "Renamed Revenue"},
    )
    assert renamed.status_code == 200

    after = await _docs_by_entity(project_id)
    assert after[metric_key].id != before[metric_key].id
    assert after[metric_key].title == "Renamed Revenue"
    assert after[metric_key].embedding_status == "pending"
    assert after[metric_key].embedding is None
    for key, row in after.items():
        if key != metric_key:
            assert row.id == kept[key].id


@pytest.mark.asyncio
async def test_reindex_retries_failed_documents_as_pending(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_embeddings(monkeypatch)
    _, metric = await _setup_project(client, "inc-failed")
    project_id = uuid.UUID(metric["project_id"])
    metric_key = ("metric", metric["id"])

    before = await _docs_by_entity(project_id)
    await _set_embedding_state(before[metric_key].id, status="failed", model=None, embedding=None)

    await _reindex("inc-failed")

    after = await _docs_by_entity(project_id)
    assert after[metric_key].embedding_status == "pending"


@pytest.mark.asyncio
async def test_reindex_reembeds_ready_rows_from_a_different_model(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_embeddings(monkeypatch)
    _, metric = await _setup_project(client, "inc-model")
    project_id = uuid.UUID(metric["project_id"])
    metric_key = ("metric", metric["id"])

    before = await _docs_by_entity(project_id)
    await _set_embedding_state(
        before[metric_key].id,
        status="ready",
        model="some-older-model",
        embedding=SENTINEL_EMBEDDING,
    )

    await _reindex("inc-model")

    after = await _docs_by_entity(project_id)
    assert after[metric_key].id != before[metric_key].id
    assert after[metric_key].embedding_status == "pending"
    assert after[metric_key].embedding is None

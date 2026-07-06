"""Unit tests for the search-embedding worker task (tripl-kt6v).

A request-level embedding failure (``embed_texts`` returning ``[]`` for a
non-empty batch: network error, 429, 400) must NOT mark documents ``failed``
— the documents are left ``pending`` and the task retries itself. Per-item
failures (sanitize rejection, short response tail) keep the old semantics.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from unittest.mock import MagicMock

import pytest
from celery.exceptions import Retry

from tripl.config import settings
from tripl.models.search_document import SearchDocument
from tripl.services.app_settings_service import env_ai_config
from tripl.worker.tasks import search as search_tasks


def _doc(*, body: str = "body text", keywords: str = "keywords") -> SearchDocument:
    return SearchDocument(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        branch_id=uuid.uuid4(),
        entity_type="event",
        entity_id=uuid.uuid4(),
        title="Title",
        subtitle="Subtitle",
        body=body,
        keywords=keywords,
        route_path="/p/demo",
        content_hash="0" * 64,
        embedding_status="pending",
    )


def test_embed_text_puts_keywords_before_body() -> None:
    doc = _doc(body="BODYTEXT", keywords="KEYWORDS")

    text = search_tasks._embed_text(doc)

    assert text == "Title\nSubtitle\nKEYWORDS\nBODYTEXT"


def test_embed_text_caps_joined_text_at_6000_chars() -> None:
    doc = _doc(body="x" * 20_000)

    text = search_tasks._embed_text(doc)

    assert len(text) == search_tasks._EMBED_TEXT_MAX_CHARS == 6000
    # Truncation eats the body tail, never the high-signal head.
    assert text.startswith("Title\nSubtitle\nkeywords\n")


def test_batch_failure_raises_and_leaves_documents_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docs = [_doc(), _doc()]
    monkeypatch.setattr(search_tasks, "embed_texts", lambda texts, *, config: [])
    session = MagicMock()

    with pytest.raises(search_tasks._BatchEmbeddingFailedError):
        search_tasks._embed_documents(session, docs, env_ai_config())

    assert [doc.embedding_status for doc in docs] == ["pending", "pending"]
    session.execute.assert_not_called()


def test_short_response_marks_only_the_tail_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    docs = [_doc(), _doc(), _doc()]
    vector = [0.1] * settings.search_embedding_dimensions
    monkeypatch.setattr(search_tasks, "embed_texts", lambda texts, *, config: [vector])
    session = MagicMock()

    embedded, failed = search_tasks._embed_documents(session, docs, env_ai_config())

    assert (embedded, failed) == (1, 2)
    # The first doc is updated via raw SQL (not the ORM attribute), the
    # unmatched tail is marked failed in-place.
    assert docs[0].embedding_status == "pending"
    assert [doc.embedding_status for doc in docs[1:]] == ["failed", "failed"]
    assert session.execute.call_count == 1


def test_sanitize_rejection_marks_that_document_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docs = [_doc(), _doc()]
    good = [0.1] * settings.search_embedding_dimensions
    bad = [0.1, 0.2]  # wrong dimensionality -> sanitize_embedding returns []
    monkeypatch.setattr(search_tasks, "embed_texts", lambda texts, *, config: [bad, good])
    session = MagicMock()

    embedded, failed = search_tasks._embed_documents(session, docs, env_ai_config())

    assert (embedded, failed) == (1, 1)
    assert docs[0].embedding_status == "failed"


def test_task_retries_on_batch_failure_and_keeps_docs_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docs = [_doc()]
    session = MagicMock()
    session.get_bind.return_value.dialect.name = "postgresql"
    session.execute.return_value.scalars.return_value.all.return_value = docs
    monkeypatch.setattr(search_tasks, "_get_sync_session", lambda: session)
    enabled_config = replace(
        env_ai_config(),
        search_embeddings_enabled=True,
        search_embedding_api_key="sk-test",
    )
    monkeypatch.setattr(
        search_tasks.app_settings_service,
        "get_ai_config_sync",
        lambda session=None: enabled_config,
    )
    monkeypatch.setattr(search_tasks, "embed_texts", lambda texts, *, config: [])

    # Direct task calls surface the retry as a raised celery Retry.
    with pytest.raises(Retry):
        search_tasks.embed_search_documents(str(uuid.uuid4()), str(uuid.uuid4()))

    assert docs[0].embedding_status == "pending"
    session.commit.assert_not_called()
    session.close.assert_called_once()


def test_stranded_chaser_requeues_one_embed_task_per_pending_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The beat chaser re-queues the embed task for every (project, branch)
    that still has stale pending documents — the safety net behind the
    event-driven queue-after-reindex flow."""
    project_id, branch_id = uuid.uuid4(), uuid.uuid4()
    session = MagicMock()
    session.execute.return_value.all.return_value = [(project_id, branch_id)]
    monkeypatch.setattr(search_tasks, "_get_sync_session", lambda: session)
    enabled_config = replace(
        env_ai_config(),
        search_embeddings_enabled=True,
        search_embedding_api_key="sk-test",
    )
    monkeypatch.setattr(
        search_tasks.app_settings_service,
        "get_ai_config_sync",
        lambda session=None: enabled_config,
    )
    fake_task = MagicMock()
    monkeypatch.setattr(search_tasks, "embed_search_documents", fake_task)

    result = search_tasks.requeue_stranded_search_embeddings()

    assert result == {"branches_requeued": 1}
    fake_task.delay.assert_called_once_with(str(project_id), str(branch_id))
    session.close.assert_called_once()


def test_stranded_chaser_noop_when_embeddings_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = MagicMock()
    monkeypatch.setattr(search_tasks, "_get_sync_session", lambda: session)
    disabled_config = replace(env_ai_config(), search_embeddings_enabled=False)
    monkeypatch.setattr(
        search_tasks.app_settings_service,
        "get_ai_config_sync",
        lambda session=None: disabled_config,
    )
    fake_task = MagicMock()
    monkeypatch.setattr(search_tasks, "embed_search_documents", fake_task)

    result = search_tasks.requeue_stranded_search_embeddings()

    assert result == {"branches_requeued": 0}
    session.execute.assert_not_called()
    fake_task.delay.assert_not_called()

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select, text

from tripl.models.search_document import SearchDocument
from tripl.services import app_settings_service
from tripl.services.embedding_service import embed_texts
from tripl.services.search_service import sanitize_embedding
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session

logger = logging.getLogger(__name__)


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.search.embed_search_documents",
    bind=True,
    max_retries=2,
)
def embed_search_documents(
    self: object,
    project_id: str,
    branch_id: str,
    limit: int = 100,
) -> dict[str, int]:
    session = _get_sync_session()
    embedded = 0
    failed = 0
    try:
        ai_config = app_settings_service.get_ai_config_sync(session)
        if not ai_config.search_embeddings_enabled:
            return {"embedded": 0, "failed": 0}
        if session.get_bind().dialect.name != "postgresql":
            return {"embedded": 0, "failed": 0}

        docs = list(
            session.execute(
                select(SearchDocument)
                .where(
                    SearchDocument.project_id == uuid.UUID(project_id),
                    SearchDocument.branch_id == uuid.UUID(branch_id),
                    SearchDocument.embedding_status == "pending",
                )
                .order_by(SearchDocument.updated_at.asc(), SearchDocument.id.asc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        if not docs:
            return {"embedded": 0, "failed": 0}

        texts = [
            "\n".join([doc.title, doc.subtitle, doc.body, doc.keywords]).strip() for doc in docs
        ]
        embeddings = embed_texts(texts, config=ai_config)
        for doc, raw_embedding in zip(docs, embeddings, strict=False):
            embedding = sanitize_embedding(raw_embedding)
            if not embedding:
                doc.embedding_status = "failed"
                failed += 1
                continue
            vector = "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"
            session.execute(
                text(
                    """
                    UPDATE search_documents
                    SET embedding = CAST(:embedding AS vector),
                        embedding_status = 'ready',
                        embedding_model = :embedding_model,
                        updated_at = now()
                    WHERE id = :document_id
                    """
                ),
                {
                    "embedding": vector,
                    "embedding_model": ai_config.search_embedding_model,
                    "document_id": doc.id,
                },
            )
            embedded += 1

        if len(embeddings) < len(docs):
            for doc in docs[len(embeddings) :]:
                doc.embedding_status = "failed"
                failed += 1

        session.commit()
        remaining = session.scalar(
            select(SearchDocument.id)
            .where(
                SearchDocument.project_id == uuid.UUID(project_id),
                SearchDocument.branch_id == uuid.UUID(branch_id),
                SearchDocument.embedding_status == "pending",
            )
            .limit(1)
        )
        if remaining is not None:
            embed_search_documents.delay(project_id, branch_id, limit)
        return {"embedded": embedded, "failed": failed}
    except Exception:
        session.rollback()
        logger.exception("Failed to embed search documents")
        raise
    finally:
        session.close()

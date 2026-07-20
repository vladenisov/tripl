"""Keyless semantic search for the demo project.

The demo's searchable text is fully deterministic, so its embeddings can be
precomputed once (by a maintainer running
``scripts/generate_demo_search_embeddings.py`` with a real OpenAI key) and
shipped as a compressed ``.npz`` fixture. At demo (re)index time the fixture
vectors are stamped onto matching search documents; at query time a small set
of canned query vectors stands in for the live embedding call. No API key is
ever needed at runtime.

The fixture keys documents by ``sha256(embed_text)`` — NOT by ``content_hash``,
which mixes in the per-install random demo slug and entity ids and is therefore
not install-stable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
import zipfile
import zlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.search_document import SearchDocument
from tripl.services._search_documents import embed_text_for
from tripl.services.demo.scenario import DEMO_RECIPE_VERSION

logger = logging.getLogger(__name__)

DEFAULT_FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "search_embeddings_v4.npz"

# Module attribute (not inlined) so tests can monkeypatch the location.
_FIXTURE_PATH = DEFAULT_FIXTURE_PATH


def normalize_demo_query(query: str) -> str:
    """Canonical form for canned-query lookup: casefold + collapsed whitespace."""
    return re.sub(r"\s+", " ", query.casefold()).strip()


def embed_text_key(embed_text: str) -> str:
    """Install-stable fixture key for one document's embed text."""
    return hashlib.sha256(embed_text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class DemoEmbeddingFixture:
    """Parsed fixture: vectors keyed by embed-text sha256 / normalized query."""

    model: str
    dimensions: int
    doc_vectors: dict[str, list[float]]
    query_vectors: dict[str, list[float]]


def load_demo_embedding_fixture() -> DemoEmbeddingFixture | None:
    """Parse-once fixture reader; ``None`` when absent or unusable.

    A missing or stale fixture is an expected state (fresh checkout, recipe
    bump, changed dimensions), so every rejection is a single INFO log — never
    an error — and the demo simply stays lexical-only.
    """
    return _parse_fixture(_FIXTURE_PATH)


@lru_cache(maxsize=8)
def _parse_fixture(path: Path) -> DemoEmbeddingFixture | None:
    if not path.is_file():
        logger.info(
            "Demo search-embedding fixture missing at %s; demo semantic search stays lexical",
            path,
        )
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            manifest_raw = data["manifest"].item()
            manifest = json.loads(str(manifest_raw))
            doc_vectors = np.asarray(data["doc_vectors"], dtype=np.float32)
            query_vectors = np.asarray(data["query_vectors"], dtype=np.float32)
        recipe_version = str(manifest.get("recipe_version", ""))
        model = str(manifest.get("model", ""))
        dimensions = int(manifest.get("dimensions", 0))
        doc_keys = manifest.get("doc_keys")
        query_keys = manifest.get("query_keys")
    except (
        OSError,
        EOFError,
        KeyError,
        TypeError,
        ValueError,
        AttributeError,
        # np.load raises these (direct Exception subclasses, so they need
        # listing) on archives that carry the zip magic but are truncated or
        # corrupted — e.g. an interrupted generator run or a partial deploy.
        zipfile.BadZipFile,
        zlib.error,
    ) as exc:
        logger.info("Demo search-embedding fixture at %s is unreadable (%s); ignoring", path, exc)
        return None
    if recipe_version != DEMO_RECIPE_VERSION:
        logger.info(
            "Demo search-embedding fixture at %s targets recipe %r (current %r); ignoring",
            path,
            recipe_version,
            DEMO_RECIPE_VERSION,
        )
        return None
    if dimensions != settings.search_embedding_dimensions:
        logger.info(
            "Demo search-embedding fixture at %s has %d dimensions (configured %d); ignoring",
            path,
            dimensions,
            settings.search_embedding_dimensions,
        )
        return None
    if (
        not isinstance(doc_keys, list)
        or not isinstance(query_keys, list)
        or doc_vectors.shape != (len(doc_keys), dimensions)
        or query_vectors.shape != (len(query_keys), dimensions)
    ):
        logger.info(
            "Demo search-embedding fixture at %s has inconsistent keys/vector shapes; ignoring",
            path,
        )
        return None

    return DemoEmbeddingFixture(
        model=model,
        dimensions=dimensions,
        doc_vectors={
            str(key): [float(value) for value in row]
            for key, row in zip(doc_keys, doc_vectors, strict=True)
        },
        query_vectors={
            str(key): [float(value) for value in row]
            for key, row in zip(query_keys, query_vectors, strict=True)
        },
    )


def demo_query_embedding(query: str) -> list[float] | None:
    """Canned vector for a demo search query, or ``None`` on a fixture miss."""
    fixture = load_demo_embedding_fixture()
    if fixture is None:
        return None
    vector = fixture.query_vectors.get(normalize_demo_query(query))
    return list(vector) if vector is not None else None


async def apply_demo_embedding_fixture(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> int:
    """Stamp fixture vectors onto this branch's search documents; return count.

    Postgres-only (the caller guards the dialect and ``project.is_demo``);
    reuses the worker task's ``CAST(:embedding AS vector)`` UPDATE idiom.
    Idempotent: rows already ``ready`` are left alone, unmatched rows are left
    untouched, and a demo reset simply re-runs the whole thing on the freshly
    re-seeded rows. Does not commit — the caller owns the transaction.
    """
    fixture = load_demo_embedding_fixture()
    if fixture is None:
        return 0

    rows = (
        await session.execute(
            select(
                SearchDocument.id,
                SearchDocument.title,
                SearchDocument.subtitle,
                SearchDocument.keywords,
                SearchDocument.body,
                SearchDocument.embedding_status,
            ).where(
                SearchDocument.project_id == project_id,
                SearchDocument.branch_id == branch_id,
            )
        )
    ).all()

    applied = 0
    for row in rows:
        if row.embedding_status == "ready":
            continue
        key = embed_text_key(
            embed_text_for(
                title=row.title,
                subtitle=row.subtitle,
                keywords=row.keywords,
                body=row.body,
            )
        )
        embedding = fixture.doc_vectors.get(key)
        if embedding is None:
            continue
        vector = "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"
        await session.execute(
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
                "embedding_model": fixture.model,
                "document_id": row.id,
            },
        )
        applied += 1
    return applied

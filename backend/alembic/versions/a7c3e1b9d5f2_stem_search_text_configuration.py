"""stem tripl_search in English and Russian, by token type

Revision ID: a7c3e1b9d5f2
Revises: 1c9d4b7e0a25
Create Date: 2026-08-14 12:00:00.000000

tripl-nh5s. ``tripl_search`` was created as ``CREATE TEXT SEARCH CONFIGURATION
... (COPY = simple)`` with only ``unaccent`` mapped (e8f9a0b1c2d3:33, 41-45).
``simple`` folds case and strips nothing else — it has no stemmer in ANY
language — so a word and its inflections are unrelated lexemes and the lexical
leg cannot retrieve one from the other.

MEASURED ON PRODUCTION (26 queries over three real projects, every response 200)
-------------------------------------------------------------------------------
A pure-semantic hit cannot exceed 2.5 (``2.5 * cosine`` in
``_search_query.merge_results``), so a maximum score under 2.5 is proof that no
lexical row survived at all:

* ``q='улов'`` 3.006 with the catch-report events on top; ``q='уловы'`` 0.900,
  every catch-report event gone.
* ``q='экран'`` 4.110 vs ``q='экраны'`` 1.127.
* ``q='purchase'`` 19.565 vs ``q='purchases'`` 5.160.
* ``q='spots'`` never returns ``spot`` or ``screen_spot``.

ONE CONFIGURATION, ROUTED BY TOKEN TYPE — NOT ONE CONFIGURATION PER LANGUAGE
----------------------------------------------------------------------------
Language in this index is a property of a TOKEN, not of a document and not of
the corpus. The same ``search_documents`` row routinely holds both: the event
``screen_spot`` is titled in ASCII snake_case, its description is «Показ экрана
спота», its subtitle is «Просмотры экранов» and its keywords carry the ASCII
identifiers of every field it is bound to. There is no per-document language to
switch on.

Per-language configurations (``tripl_search_en`` / ``tripl_search_ru``) were
rejected for three concrete reasons:

* ``to_tsvector`` takes exactly ONE configuration, so two configurations mean two
  ``tsvector`` columns, two GIN indexes and two ``ts_rank_cd`` legs to merge —
  double the index size and double the write cost on every reindex, to describe
  one column of text.
* ``websearch_to_tsquery`` also takes exactly one configuration, so the QUERY
  would have to be classified. ``spot`` and ``спот`` are guessable; ``screen
  спота`` is not, and mixed queries are exactly what this product's users type.
* The default parser already does the classification, per token and without a
  heuristic: it labels an all-ASCII word ``asciiword`` and a word containing any
  non-ASCII letter ``word``. Routing those two token types to two different
  Snowball dictionaries inside ONE configuration gets the per-language stemming
  with none of the duplication.

So: ``asciiword``/``asciihword``/``hword_asciipart`` -> ``unaccent`` +
English Snowball; ``word``/``hword``/``hword_part`` -> ``unaccent`` + Russian
Snowball. ``unaccent`` stays FIRST in both chains — it is a filtering
dictionary, so it hands the de-accented token on to the stemmer rather than
consuming it, which is also how it survives ``ё`` -> ``е`` on the Russian side.

Note that a chain like ``unaccent, english_stem, russian_stem`` — the obvious
first guess — cannot work: a Snowball dictionary NEVER returns NULL, it always
"recognises" a token, so nothing after the first stemmer in a chain is ever
reached. English stemming would silently be applied to Cyrillic (where it is a
no-op beyond lowercasing) and the Russian plurals in the measurement above would
stay broken. The token type is the only place the split can be made.

WHAT HAPPENS TO A DOCUMENT CONTAINING BOTH
------------------------------------------
It produces ONE tsvector in which its ASCII tokens are English-stemmed and its
Cyrillic tokens Russian-stemmed, side by side, and nothing is dropped. The
``screen_spot`` document above indexes as ``screen`` ``spot`` ``показ``
``экран`` ``спот``: ``q='spots'`` reaches it through the English half and
``q='экрана спота'`` through the Russian half, from the same row and the same
index. A Cyrillic identifier such as ``экран_поиска`` splits on the underscore
into two ``word`` tokens and is stemmed as Russian; an English word inside
Russian prose is an ``asciiword`` and is stemmed as English. The one crossover
is an accented Latin word (``café``), which the parser classifies ``word`` and
therefore hands to the Russian stemmer — Russian Snowball strips Cyrillic
endings only, so it comes back unchanged, i.e. it degrades to today's behaviour
rather than to nonsense.

WHY THE IDENTIFIERS DO NOT GET WORSE
------------------------------------
The fear with stemming an identifier-heavy column is that ``screen_spot`` stops
matching ``screen_spot``. It does not: index and query run through the SAME
configuration, so both sides stem identically and every exact-name query keeps
working. What stemming really costs here is over-merging — ``properties`` and
``property`` both become ``properti``, ``status`` becomes ``statu`` — and that
lands in the leg that can afford it: ``ts_rank_cd`` is bounded at 4.0
(tripl-gbxj) and sits UNDER the 5.0 boost for "the title IS what you typed",
which is a literal string comparison and is not stemmed at all. Recall improves
in the leg built for recall; precision keeps its literal tiers.

WHY CUSTOM DICTIONARIES INSTEAD OF THE BUILT-IN ``english_stem``/``russian_stem``
--------------------------------------------------------------------------------
The shipped ``english_stem`` and ``russian_stem`` dictionaries carry a stopword
list, and stopword removal is wrong for THIS column on the English side. Event
names in an analytics catalog are built out of English function words —
``sign_in``/``sign_out``, ``screen_on``/``screen_off``, ``opt_in``/``opt_out``,
``add_to_cart`` — and the parser splits them on the underscore, so a stopword
list deletes the half that distinguishes them: ``sign_in`` and ``sign_out``
would index to the identical single lexeme ``sign`` and become lexically
indistinguishable forever. That is a silent, permanent loss of index
information.

``tripl_english_stem`` and ``tripl_russian_stem`` are therefore plain Snowball
dictionaries declared WITHOUT ``StopWords``: they stem and remove nothing. The
tradeoff is real and worth stating — ``websearch_to_tsquery`` ANDs its terms, so
a sentence-shaped query now requires its function words to be present in the
document too ("the purchase event" needs ``the``). Two things make that the
cheaper side of the trade: every one of the 26 measured production queries is
entity-name shaped and none contains a stopword, and a query that misses on the
tsvector is still retrieved by the trigram and ``LIKE`` legs of the same
statement (``postgres_lexical_search``'s WHERE is an OR) and by the semantic
leg. A collision in the index has no such rescue.

Both dictionaries are created inside the ``public`` search path exactly as
``tripl_search`` itself is, and both are dropped by ``downgrade()`` — the CI
round trip runs empty -> head -> base -> head, and a dictionary left behind at
base makes the SECOND ``upgrade head`` fail on ``CREATE TEXT SEARCH DICTIONARY``
(which has no ``IF NOT EXISTS``). That is why the creation is guarded by a
catalog lookup and the drop is unconditional.

THE STORED TSVECTORS ARE REBUILT HERE, IN THIS MIGRATION
--------------------------------------------------------
Changing a configuration does NOT touch a ``tsvector`` that was already
computed: every existing ``search_documents.text_vector`` holds unstemmed
lexemes, while ``websearch_to_tsquery('tripl_search', ...)`` immediately starts
producing stemmed ones. Left alone, that combination is WORSE than the bug being
fixed — ``q='purchase'`` would stem to ``purchas`` and stop matching the stored
``purchase``, i.e. queries that work today would break — so a half-applied state
is not acceptable and the rebuild belongs in the same transaction as the
mapping change.

It is a single ``UPDATE`` because it can be: unlike tripl-gbxj and tripl-h9x2,
which changed what TEXT a document contains and therefore needed
``build_documents`` to run, this revision changes only how existing text is
tokenized. ``to_tsvector`` over the stored columns is exactly what
``search_service._refresh_text_vectors`` does, and the expression here is copied
from it verbatim so the two cannot disagree.

Two operational notes for whoever deploys this:

* The ``UPDATE`` rewrites every row of ``search_documents`` and its GIN index
  inside the migration's transaction, and the API entrypoint runs
  ``alembic upgrade head`` before uvicorn starts. On the current index (tens of
  thousands of rows) that is seconds; it is bounded by table size, not by
  project count.
* It does NOT substitute for the document REBUILD that tripl-gbxj and tripl-h9x2
  require, and nothing in this revision does. Those two changed a document's
  TEXT (harvested values left variable keywords, spaced identifier aliases
  joined them), so every stored row's ``content_hash`` is now stale and only
  ``_search_documents.build_documents`` can regenerate it. Until that has run
  for a branch, the branch's rows are ranked on pre-fix text. The two changes
  are independent and commute: this revision re-vectorizes whatever text is
  stored now, and a later rebuild re-inserts the changed rows and re-runs
  ``to_tsvector`` on them through ``_refresh_text_vectors``. Either order ends
  consistent; skipping the rebuild leaves the ranking fixes unapplied, not the
  stemming.

WHAT ACTUALLY REBUILDS A BRANCH (AND WHAT WAS WRONG ABOVE)
----------------------------------------------------------
An earlier draft of this note said only ``POST
/api/v1/projects/{slug}/search/reindex?branch_id=...`` can regenerate those
rows. That is false, and believing it would make an operator do work the
application does for itself. ``search_service.reindex_project_branch`` is called
from a dozen places and EVERY one of them rebuilds the whole branch rather than
the entity that changed: any write to an event type, field, meta field,
variable, relation, metric or fact table (``event_type_service``,
``field_service``, ``variable_service``, ``metric_definition_service``, …), a
plan-branch merge, a demo provision/reset, the Celery worker bridge after a scan
or catalog refresh (``worker/search_reindex.py``), and ``_ensure_index_exists``
when a branch has no documents at all. An actively edited branch therefore heals
itself on the first write after deploy, with no operator action.

What does NOT heal itself is a branch nobody writes to — an archived plan
branch, a project kept for reference. Those keep pre-fix documents indefinitely,
and a mixed branch (old rows next to rows rebuilt by an edit) is scored on two
different texts at once.

THIS IS DOCUMENTED, NOT AUTOMATED — DELIBERATELY
------------------------------------------------
The automatic options are to delete every ``search_documents`` row here (so
``_ensure_index_exists`` rebuilds each branch lazily on its first search) or to
rebuild them all inside the migration. Both discard every stored embedding, so
on an instance with ``SEARCH_EMBEDDINGS_ENABLED=true`` they re-embed the entire
catalog against a paid provider as a side effect of ``alembic upgrade head``.
That is a cost and a privacy decision belonging to an operator, not to a
migration that is supposed to change a text-search configuration. So the
instruction is written where someone deploying this will actually read it —
``website/docs/run/runbook.md``, "Post-deploy verification" — instead of only in
a migration docstring nobody opens.

"""

from collections.abc import Sequence

from alembic import op

revision: str = "a7c3e1b9d5f2"
down_revision: str | None = "1c9d4b7e0a25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: The ASCII half of the default parser's word tokens. ``screen_spot`` splits on
#: the underscore into two of these; a dotted name (``page_data.extra.spot_id``)
#: is a ``host`` token instead and is deliberately NOT in either list, so it
#: keeps the ``simple`` mapping that indexes it whole.
_ASCII_TOKEN_TYPES = "asciiword, asciihword, hword_asciipart"

#: The non-ASCII half: any word carrying a letter outside ASCII, which in this
#: corpus means Cyrillic prose and Cyrillic identifiers.
_NON_ASCII_TOKEN_TYPES = "word, hword, hword_part"

#: Copied verbatim from ``search_service._refresh_text_vectors`` — the two must
#: produce byte-identical vectors or a later incremental reindex would silently
#: disagree with what this migration wrote.
_REBUILD_TEXT_VECTORS = """
    UPDATE search_documents
    SET text_vector = to_tsvector(
        'tripl_search',
        concat_ws(' ', title, subtitle, body, keywords)
    )
"""


def _create_snowball_dictionary(name: str, language: str) -> None:
    """Create a stopword-free Snowball dictionary if it is not already there.

    ``CREATE TEXT SEARCH DICTIONARY`` has no ``IF NOT EXISTS``, and this revision
    has to survive being replayed over a database that already carries the
    dictionary (the CI round trip re-runs ``upgrade head`` after ``downgrade
    base``), so the guard is a catalog lookup — the same shape e8f9a0b1c2d3 uses
    for ``tripl_search`` itself.
    """
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_ts_dict
                WHERE dictname = '{name}'
            ) THEN
                CREATE TEXT SEARCH DICTIONARY {name} (
                    TEMPLATE = snowball,
                    Language = {language}
                );
            END IF;
        END
        $$;
        """
    )


def upgrade() -> None:
    _create_snowball_dictionary("tripl_english_stem", "english")
    _create_snowball_dictionary("tripl_russian_stem", "russian")
    op.execute(
        f"""
        ALTER TEXT SEARCH CONFIGURATION tripl_search
            ALTER MAPPING FOR {_ASCII_TOKEN_TYPES}
            WITH unaccent, tripl_english_stem
        """
    )
    op.execute(
        f"""
        ALTER TEXT SEARCH CONFIGURATION tripl_search
            ALTER MAPPING FOR {_NON_ASCII_TOKEN_TYPES}
            WITH unaccent, tripl_russian_stem
        """
    )
    op.execute(_REBUILD_TEXT_VECTORS)


def downgrade() -> None:
    # Back to exactly what e8f9a0b1c2d3 left behind: one mapping statement over
    # the same six token types, ``unaccent, simple``. The mapping has to stop
    # referencing the dictionaries before they can be dropped, and the stored
    # vectors have to be rebuilt afterwards for the same reason the upgrade
    # rebuilds them — a stemmed vector under an unstemmed query configuration is
    # a worse index than either state on its own.
    op.execute(
        f"""
        ALTER TEXT SEARCH CONFIGURATION tripl_search
            ALTER MAPPING FOR {_ASCII_TOKEN_TYPES}, {_NON_ASCII_TOKEN_TYPES}
            WITH unaccent, simple
        """
    )
    op.execute("DROP TEXT SEARCH DICTIONARY IF EXISTS tripl_russian_stem")
    op.execute("DROP TEXT SEARCH DICTIONARY IF EXISTS tripl_english_stem")
    op.execute(_REBUILD_TEXT_VECTORS)

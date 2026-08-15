"""index the surface form beside the stem, and match both

Revision ID: b6d1f0a3c7e2
Revises: a7c3e1b9d5f2
Create Date: 2026-08-15 09:00:00.000000

tripl-uojz. a7c3e1b9d5f2 gave ``tripl_search`` an English and a Russian Snowball
stemmer and fixed the fault it was aimed at: a word and its inflections became
one lexeme, so ``q='purchases'`` reached ``purchase_completed`` for the first
time. It also introduced a NEW fault, in the same mechanism, which this revision
repairs without giving the stemmer up.

MEASURED ON THE DEPLOYED DATABASE (image d47b55b2, alembic_version a7c3e1b9d5f2)
-------------------------------------------------------------------------------
The migration is applied and its mappings are correct — ``asciiword`` ->
``tripl_english_stem``, ``word`` -> ``tripl_russian_stem``. The fault is not a
misconfiguration; it is what Snowball does with these words::

    to_tsvector('tripl_search', 'уловы улов уловов')  ->  'ул':2 'улов':1,3

The SINGULAR over-stems. Russian Snowball computes the RV region of ``улов`` as
``лов``; that region ends in ``ов``, which is the masculine genitive-plural
ending, so the ending is stripped and the bare nominative lands on ``ул``. Every
INFLECTED form lands on ``улов``. The word is split into two disjoint lexical
classes, and the class the nominative fell into is one no other form can reach.

It is not one word, and it is not rare vocabulary. Measured lemma / over-stem,
with the number of production ``search_documents`` rows holding each::

    экран/экра   414/3971     показа/показ   341/429
    открыт/откр  302/260      закрыт/закр    183/100
    создан/созда 124/172      найден/найд     18/181
    выключен/выключ 10/137    архив/арх       23/53
    улов/ул      151/0

WHICH FORM PRODUCES WHICH LEXEME — LOOKED UP, NOT INFERRED
-----------------------------------------------------------
The counts above say which lexemes exist. They do not say which form makes
which, and the natural guess (nominative over-stems, everything inflected lands
on the lemma) is WRONG for the very word with the biggest numbers::

    экран -> экра    экрана -> экра    экраны -> экра    экране -> экран

So the ``экра`` class is not just the bare nominative: it is the nominative,
the genitive AND the nominative plural. The ``экран`` class — the 414 rows — is
reached by the prepositional. The cut is prepositional-vs-the-rest.

THE QUERY-SIDE-ONLY FIX IS DEAD, AND THAT TABLE IS WHAT KILLED IT
------------------------------------------------------------------
The cheap repair — leave the index alone, expand the QUERY to
``stem(q) | surface(q)`` — was designed first. Read it against the stems above,
because the direction matters and stating it backwards makes the repair look
survivable.

Under a stem-only index a document is reachable iff one of its STORED lexemes
equals a term of the query. The 3971 rows store ``экра``; the 414 store
``экран``. A query-side expansion therefore does exactly this:

* ``q='экране'`` -> ``'экран' | 'экране'``. Reaches the 414. Misses the 3971 —
  the MAJORITY of the documents that hold this word, and the whole population
  the fix exists for. Nothing on the query side can rescue them: they store
  ``экра``, and no spelling a user types is ``экра``.
* ``q='экрана'`` -> ``'экра' | 'экрана'``. Reaches the 3971 on its stem alone,
  exactly as it did before the expansion, and misses the 414. The added surface
  term ``'экрана'`` matches nothing at all, because under a stem-only index no
  document stores the lexeme ``экрана`` — every text containing that word stores
  ``экра``.

That is the shape of the failure in general: a query-side-only expansion can
only help when the DOCUMENT's stored lexeme happens to be spelled the way the
user typed it. The over-stemmed majority stores a lexeme that is not a word, so
it is unreachable from the query side by construction. The document side has to
carry its surface form, which is what this revision does. The breakage runs in
both directions, so the repair is applied to both sides.

WHAT THIS REVISION CHANGES
--------------------------
1. It creates ``tripl_search_surface``, a second configuration that is
   byte-for-byte what ``tripl_search`` was BEFORE a7c3e1b9d5f2: ``COPY = simple``
   with the six word token types on ``unaccent, simple``. Nothing about its
   behaviour is a guess — it is the configuration that was in production until
   the previous deploy.
2. It rebuilds every stored ``search_documents.text_vector`` as
   ``to_tsvector('tripl_search', …) || to_tsvector('tripl_search_surface', …)``:
   the stemmed lexemes and the surface lexemes, in the ONE existing column,
   behind the ONE existing GIN index.

The query side is changed in the same commit
(``services/_search_query.postgres_lexical_search``): the single tsquery
construction site ORs the same two configurations, and the 3.25 boost tier that
derives from it builds its document side the same way.

THE CONDITION THIS REPAIRS, STATED EXACTLY
-------------------------------------------
Every token ``w`` now contributes ``{stem(w), surface(w)}`` on both sides. Two
forms A and B of one word meet iff those sets intersect. They already met when
``stem(A) == stem(B)``; what was missing is ``surface(A) == stem(B)``, and that
is precisely the over-stem case — the form that gets over-stripped is spelled
the same as the stem that the forms in the OTHER class produce. ``улов`` indexes
``{ул, улов}``, ``уловы`` indexes ``{улов, уловы}``, and they meet on ``улов``
from either direction. ``экран`` indexes ``{экра, экран}`` and ``экране``
indexes ``{экран, экране}``: they meet on ``экран``, and on the stem leg alone
they did not meet at all.

``экран`` against ``экрана`` is NOT an example of this. Both stem to ``экра``,
so they always met, on the stem leg, and anything built on that pair certifies
nothing about this revision. Use ``экране``.

This is not a universal guarantee and is not claimed as one: two forms that both
over-stem, to different lexemes, whose surfaces match neither stem, still miss
each other. That is not hypothetical either — ``экрана`` ``{экра, экрана}``
against ``экране`` ``{экран, экране}`` is disjoint, and this revision does not
repair that pair. What it repairs is every pair with an over-stemmed form on one
side and that form's own spelling as a stem on the other, which is the
population the row counts above are about.

WHAT THIS DOES TO PRECISION — THE HONEST VERSION
-------------------------------------------------
An earlier draft of this docstring claimed the change "cannot COLLAPSE two words
that were distinct", because the surface leg "only adds lexemes strictly more
specific than the stem". That argument is unsound, and it is retracted here
rather than quietly deleted, because it is exactly the kind of claim that gets
trusted instead of tested. "More specific" is not a property a tsvector lexeme
has: a lexeme is a string, a match is a string equality, and the identity this
whole repair is built on — ``surface(A) == stem(B)`` — fires without ever asking
whether A and B are forms of the same word. A word whose spelling happens to be
another word's stem now matches it. That is the intended behaviour for
``экран``/``экране`` and the unintended one for any unrelated pair of the same
shape.

What IS guaranteed:

* **The change is purely additive.** Both legs are OR-ed on both sides and the
  stem leg is byte-identical to a7c3e1b9d5f2's, so every match that existed
  before still exists. Nothing findable becomes unfindable and no class is
  split; the only movement is toward more recall.
* **The new matches are bounded by whole spellings, not by prefixes.** Two texts
  can now meet only if some string in ``{stem(a), a}`` equals some string in
  ``{stem(b), b}``. Words sharing no full spelling and no stem are untouched —
  which is what separates this from "index every prefix" or "drop the stemmer",
  the two cheap changes that would satisfy every retrieval assertion and destroy
  precision.
* **The residue is measured rather than argued.**
  ``tests/relevance/test_stemming_invariants.py`` asserts against the real
  configurations that this vocabulary's distinct words still do not reach each
  other. That is an empirical check on the words we ship, not a proof about all
  words, and it is deliberately not written up as one.

WHY ``unaccent`` IS IN THE SURFACE CHAIN AND NOT JUST ``simple``
----------------------------------------------------------------
The stem leg unaccents a token before stemming it, so ``зачёты`` is stemmed via
``зачеты``. If the surface leg skipped ``unaccent`` it would index ``зачёт``
while the stem leg of every inflected form produced ``зачет``, and the
``surface(A) == stem(B)`` identity the whole repair rests on would fail for
every word containing ``ё`` — which in this corpus includes ``Отчёт об улове``,
the catch-report event type itself.

WHY THIS IS NOT THE PER-LANGUAGE PAIR a7c3e1b9d5f2 REJECTED
------------------------------------------------------------
That rejection was about needing to CLASSIFY — ``to_tsvector`` and
``websearch_to_tsquery`` each take exactly one configuration, so per-language
configurations would have forced a language guess on every query, and ``screen
спота`` is not guessable. Here both configurations are applied unconditionally
to every token and nothing is classified. The two results are concatenated into
one tsvector, so there is still one column, one GIN index and one
``ts_rank_cd``. The axis is normalization depth, not language.

WHAT THIS COSTS
---------------
* **tsvector size.** Position entries double exactly: every token is indexed
  twice. Distinct lexemes grow only by the number of distinct tokens whose stem
  differs from their surface — near zero for ASCII identifiers
  (``stem('spot') == 'spot'``), most words for Russian prose. Expect roughly
  1.2-1.4x on identifier-heavy rows and 1.6-1.9x on prose-heavy rows.
* **GIN index size.** GIN keys are distinct lexemes, so the index grows by the
  number of NEW distinct surface forms across the whole branch — a larger
  relative jump than the column itself.
* **Two hard limits move closer.** A tsvector caps a single lexeme at 256
  positions and the whole vector at 1 MB. The position cap means a token
  repeated 180 times merges to 256 rather than 360, so heavily repeated terms
  gain LESS than double. The 1 MB cap is the one that can fail loudly: a row
  whose current vector is already past ~500 KB will raise "string is too long
  for tsvector" and abort this migration. That is checked BEFORE deploy, on the
  real database, by the read-only verification SQL that ships with this change
  (``website/docs/run/runbook.md``, "The surface-form release") — do not run this
  migration without it. Note the shape that check has to have: the oversized
  ``tsvector`` cannot be built in order to be measured, so a naive
  ``SELECT length((to_tsvector(…) || to_tsvector(…))::text)`` over the table
  raises the very error it is looking for and reports nothing. The runbook check
  bounds the rows by input length first and traps
  ``program_limit_exceeded`` per row second, so it answers with a count and a
  list of documents instead of aborting.
* **``ts_rank_cd``.** See ``_search_query.postgres_lexical_search`` for the
  per-case reasoning, including the two plural relevance cases whose 0.25 margin
  this change is NOT certified to preserve.

NO DOCUMENT REBUILD IS REQUIRED, AND HERE IS WHY NOT
-----------------------------------------------------
a7c3e1b9d5f2 had to say the opposite for tripl-gbxj and tripl-h9x2, so the
difference is worth being explicit about. Those two changed what TEXT a document
CONTAINS, which changes ``BuiltDocument.content_hash`` (computed over
entity_type, entity_id, title, subtitle, description, body, keywords, route_path
and archived — see ``_search_documents``), so every stored row's hash went stale
and only ``build_documents`` could regenerate it.

This revision changes only how the SAME stored text is tokenized. No hash input
moves, ``build_documents`` would re-emit byte-identical rows, and the
incremental reindex would correctly keep every row it already has. The single
``UPDATE`` below therefore leaves the table fully consistent — including
archived branches nobody writes to, which is the one population that does not
heal itself on the next edit. Embeddings are untouched, so nothing here re-bills
a paid provider.

The rebuild must be in the same transaction as the configuration creation for
the reason a7c3e1b9d5f2 gives at length: the query side switches the instant the
code deploys, and a stored vector built by the old expression under a query built
by the new one is worse than either state alone.

Two operational notes:

* This ``UPDATE`` rewrites every row of ``search_documents`` and its GIN index,
  and the API entrypoint runs ``alembic upgrade head`` before uvicorn starts. It
  is bounded by table size, not project count.
* A full-table UPDATE leaves dead tuples and a bloated GIN index behind.
  ``VACUUM (ANALYZE) search_documents`` cannot run inside a migration's
  transaction; run it afterwards, or let autovacuum catch up.

DOWNGRADE
---------
CI runs empty -> head -> base -> head, so ``downgrade()`` must return the schema
to EXACTLY the state ``upgrade()`` found: stored vectors rebuilt with the
stem-only expression a7c3e1b9d5f2 left behind, and ``tripl_search_surface``
dropped. A configuration left behind at base would survive into the re-upgrade
and fail it — ``CREATE TEXT SEARCH CONFIGURATION`` has no ``IF NOT EXISTS`` —
which is why the creation is catalog-guarded and the drop is unconditional. The
stem-only rebuild string below is a deliberate frozen copy of a7c3e1b9d5f2's,
not an import of it: that revision is history and must not be re-read through
whatever the code says later.

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b6d1f0a3c7e2"
down_revision: str | None = "a7c3e1b9d5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: The six word token types, exactly as e8f9a0b1c2d3 and a7c3e1b9d5f2 name them.
#: A dotted name (``page_data.extra.spot_id``) is a ``host`` token and is
#: deliberately absent from both revisions' lists, so it keeps the ``simple``
#: mapping that indexes it whole — in this configuration as in ``tripl_search``.
_WORD_TOKEN_TYPES = "asciiword, asciihword, hword_asciipart, word, hword, hword_part"

#: MUST stay whitespace-identical to ``search_service.TEXT_VECTOR_EXPRESSION``.
#: a7c3e1b9d5f2 kept its copy in sync by convention and said so in a docstring;
#: ``tests/test_alembic_revisions.py`` now compares the two constants directly,
#: because a convention is not a check and a silent divergence indexes half the
#: table one way and half the other with no error anywhere.
_TEXT_VECTOR_EXPRESSION = """
    to_tsvector(
        'tripl_search',
        concat_ws(' ', title, subtitle, body, keywords)
    )
    || to_tsvector(
        'tripl_search_surface',
        concat_ws(' ', title, subtitle, body, keywords)
    )
"""

_REBUILD_TEXT_VECTORS = f"""
    UPDATE search_documents
    SET text_vector = {_TEXT_VECTOR_EXPRESSION}
"""

#: The stem-only expression a7c3e1b9d5f2 wrote, frozen here so ``downgrade()``
#: restores exactly what ``upgrade()`` found. Intentionally duplicated rather
#: than imported from that revision: history must not change meaning.
_REBUILD_STEM_ONLY_TEXT_VECTORS = """
    UPDATE search_documents
    SET text_vector = to_tsvector(
        'tripl_search',
        concat_ws(' ', title, subtitle, body, keywords)
    )
"""


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_ts_config
                WHERE cfgname = 'tripl_search_surface'
            ) THEN
                CREATE TEXT SEARCH CONFIGURATION tripl_search_surface (COPY = simple);
            END IF;
        END
        $$;
        """
    )
    op.execute(
        f"""
        ALTER TEXT SEARCH CONFIGURATION tripl_search_surface
            ALTER MAPPING FOR {_WORD_TOKEN_TYPES}
            WITH unaccent, simple
        """
    )
    op.execute(_REBUILD_TEXT_VECTORS)


def downgrade() -> None:
    # Rebuild FIRST, drop second: the stem-only expression does not reference
    # tripl_search_surface, so the order is free, but rebuilding while the
    # configuration still exists keeps the table valid at every instant rather
    # than only at the end of the transaction.
    op.execute(_REBUILD_STEM_ONLY_TEXT_VECTORS)
    op.execute("DROP TEXT SEARCH CONFIGURATION IF EXISTS tripl_search_surface")

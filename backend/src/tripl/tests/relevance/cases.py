"""The relevance case table: query -> what must rank first, what must not beat it.

WHY A TABLE AND NOT PROSE ASSERTIONS
------------------------------------
Every entry here was measured against production before it was written down
(tripl-338u): 26 queries over three real projects, every response HTTP 200. Ten
cases, each of them "this query must produce exactly this ranking, and here is
what actually beat it in production".

One case is NOT one of those ten and is labelled as such in its ``measured``
field: ``repetition-outlier-does-not-outrank-the-screen-it-names``. It exists
because a measured production query could not reach the fault — the corpus had
no document with the repetition profile the production fault needed, so the
``ts_rank_cd`` normalization it pins was invisible to every other case. Its
input (``corpus._SETTINGS_CARD_TARGETS``) is built to the measured production
profile even though the query that reads it is constructed here.

WHAT THE ``xfail`` FIELD IS, AND WHAT IT DOES NOT PROVE HERE
------------------------------------------------------------
A case today's ranking fails is marked ``xfail(strict=True)`` — an unexpected
PASS is a hard failure, so a fix cannot land unnoticed with a stale marker — and
the commit DELETING an ``xfail`` is the proof that fix worked.

For the FOUR fixed faults that proof does not exist in this repository's history,
and this docstring will not pretend otherwise: the harness and those four fixes
landed in ONE commit, so no case ever carried a marker on a merged branch. What
the table proves for them is weaker and worth saying plainly — it proves the
ranking is right NOW, and it will catch the next regression in it. Their real
proof was by MUTATION, named on each case: revert the source change, watch that
case go red.

The mechanism itself is live, on exactly one case.
``russian-phrase-finds-the-event-it-describes`` carries an ``xfail`` for
tripl-9t2s — a fault the four fixes did not address, filed rather than tuned
away. Deleting that marker is the proof for that issue, in the workflow this
field exists for.

The rule that is NOT negotiable either way: an assertion is never weakened to
make a case pass.

WHAT HAS BEEN FIXED
-------------------
Four faults were measured. All four are fixed, and every case below passes
except the one that carries an ``xfail`` (see ``russian-phrase-...``):

* **tripl-gbxj** (unbounded ``ts_rank_cd`` x4.0, harvested values joined into
  variable keywords) — ``spot`` and ``screen_spot`` now rank their own event
  first instead of the variables that merely mention it. Those two cases pin the
  KEYWORDS half only: restoring ``include_values=True`` in
  ``_search_documents._variable_document`` fails ``purchase-plural``, while
  deleting normalization flag 32 used to leave the whole table green, because
  ``rank / (rank + 1)`` only bends outliers and this corpus had none.
  ``repetition-outlier-does-not-outrank-the-screen-it-names`` is the case that
  closes that gap.
* **tripl-h9x2** (``token_boundary_regex`` refused every query with a space, and
  the surviving tiers compared a spaced query against an underscored title) —
  ``screen spot`` now finds ``screen_spot``.
* **tripl-txcz** (confidence normalized to the top hit) — a keyboard-mash query
  is no longer served as a certain answer.
* **tripl-nh5s** (``tripl_search`` was ``COPY = simple``, which stems in no
  language) — migration ``a7c3e1b9d5f2`` routes ASCII word tokens to an English
  Snowball dictionary and non-ASCII word tokens to a Russian one, so a plural
  reaches its singular and ``экрана спота`` reaches ``экран``. The same issue
  added the 3.25 tier to the boost ladder, without which the stemmer fixed
  RETRIEVAL and left the RANKING where it was: every other tier compares literal
  characters, so a plural query could still only reach the ladder through the
  harvested value that happens to spell the plural.

Two cases (``purchase``, ``улов``) are load-bearing in the opposite direction:
they are the singular halves of the stemming pairs and they already passed on
production before any of this. If a "fix" ever breaks them, the harness has
caught a regression rather than a missing feature — and they are also what proves
the harness discriminates instead of failing everything it is shown. That role
extends to every pair here: singular and plural are asserted side by side, so a
stemmer that over-merges (or a configuration change that quietly reverts to
``simple``) shows up as one half of a pair going red.

WHAT THIS TABLE DOES NOT COVER
------------------------------
Every case here runs with the semantic leg OFF (see
:mod:`tripl.tests.relevance.conftest` — the fixture hard-fails if embeddings are
enabled, because a live provider makes rankings irreproducible). The semantic
leg's own guarantees — the cosine floor and the confidence it reports — are
covered by :mod:`tripl.tests.relevance.test_semantic_floor`, which builds its
vectors by hand and needs no provider.
"""

from __future__ import annotations

from dataclasses import dataclass

# Document titles, which is what a search result carries. Events are titled by
# name, variables by ``${name}``, fields and event types by display name — see
# ``services/_search_documents``.
EVENT_SPOT = "spot"
EVENT_SCREEN_SPOT = "screen_spot"
EVENT_SCREEN_HOME = "screen_home"
EVENT_SCREEN_SETTINGS = "screen_settings"
EVENT_CATCH_REPORT = "catch_report_created"
EVENT_PURCHASE = "purchase_completed"

VAR_SPOT_ID = "${property.spot_id}"
VAR_CUBE = "${property.cube}"
VAR_PAGE_DATA_SPOT_ID = "${page_data.extra.spot_id}"
VAR_SCREEN_NAME = "${property.screen_name}"
VAR_CARD_TARGET = "${property.card_target}"

FIELD_SCREEN = "Экран"
FIELD_CATCH_KIND = "Тип улова"


@dataclass(frozen=True)
class RelevanceCase:
    """One measured query and the ranking it must produce.

    ``expect_top`` is the document title that must come back first. Nothing in
    ``must_not_outrank`` may be ranked above it — those are the documents that
    actually beat it on production, so they are named rather than implied, and a
    failure says which competitor won instead of just "wrong order".

    ``max_top_confidence`` covers the one case that is about the score rather
    than the order: confidence used to be normalized to the top hit, so a query
    that matched nothing was still served as a perfect answer (tripl-txcz).

    ``xfail`` is the reason a case is EXPECTED to fail, or ``None``. Exactly one
    case sets it (``russian-phrase-...``, for tripl-9t2s); see the module
    docstring for why the four already-fixed faults were proved by mutation
    instead.
    """

    id: str
    query: str
    measured: str
    expect_top: str | None = None
    must_not_outrank: tuple[str, ...] = ()
    max_top_confidence: float | None = None
    xfail: str | None = None


CASES: tuple[RelevanceCase, ...] = (
    RelevanceCase(
        id="spot-event-beats-harvested-variables",
        query="spot",
        measured=(
            "production: ${property.spot_id} 73.69, ${property.cube} 55.68, "
            "${page_data.extra.spot_id} 51.12; the events named 'spot' and "
            "'screen_spot' did not appear at all"
        ),
        # Fixed by tripl-gbxj: ts_rank_cd is normalized (flag 32) so the lexical
        # leg is bounded below the 5.0 exact-title boost, and harvested values
        # are no longer joined into a variable's keywords. The marker is gone,
        # which is the proof.
        expect_top=EVENT_SPOT,
        must_not_outrank=(VAR_SPOT_ID, VAR_CUBE, VAR_PAGE_DATA_SPOT_ID),
    ),
    RelevanceCase(
        id="screen_spot-exact-title-beats-harvested-variables",
        query="screen_spot",
        measured=(
            "production: the 5.0 exact-title boost fires and the screen_spot event "
            "still ranks 3rd at 9.00, behind variables at 11.93 and 10.82"
        ),
        # Fixed by tripl-gbxj: with the lexical leg capped at 4.0, the 5.0
        # exact-title boost can no longer be outweighed by repetition alone.
        expect_top=EVENT_SCREEN_SPOT,
        must_not_outrank=(VAR_SPOT_ID, VAR_CUBE, VAR_PAGE_DATA_SPOT_ID),
    ),
    RelevanceCase(
        id="repetition-outlier-does-not-outrank-the-screen-it-names",
        query="screen_settings",
        measured=(
            "production: the same fault as q='spot' (73.69 vs a correct answer at "
            "4.55) at the scale that actually caused it — 1526 harvested-value "
            "variables, one document repeating the query token ~180 times for a raw "
            "ts_rank_cd of ~17 and a lexical leg of ~68. The QUERY is a harness "
            "construction rather than one of the 26 production queries, and this "
            "field says so rather than inventing a number: the two cases above are "
            "ranked against variables holding four to eight values per context, "
            "which is nowhere near enough repetition for the fix to be observable"
        ),
        # THE MUTATION THIS CASE EXISTS TO FAIL, NAMED EXACTLY
        # Reverting `ts_rank_cd(d.text_vector, q.tsq, 32)` to
        # `ts_rank_cd(d.text_vector, q.tsq)` in
        # `services/_search_query.postgres_lexical_search` must turn this case red.
        # Nothing else in the table can do that: measured on this corpus, deleting
        # the flag left all fourteen other outcomes byte-identical, because flag 32
        # is `rank / (rank + 1)` and therefore only bends OUTLIERS — an ordinary
        # match at raw 0.5 moves from a 2.0 lexical leg to 1.33 and reorders
        # nothing. So the normalization half of tripl-gbxj shipped with no guard,
        # and a contributor deleting the flag would have seen a clean suite. The
        # other half (harvested values out of a variable's `keywords`) has always
        # been pinned by `purchase-plural`; this is its missing twin.
        #
        # THE ARITHMETIC, MEASURED ON THE REAL tripl_search CONFIGURATION
        # `${property.card_target}` (corpus._SETTINGS_CARD_TARGETS: 90 values x 2
        # bindings = 180 occurrences of the `screen`+`settings` cover) has a raw
        # ts_rank_cd of 18.0 for this query, and a boost of 2.25 — the body-LIKE
        # tier, because the values are underscore-joined and `\m...\M` treats `_`
        # as a word character, so no token tier fires on it:
        #
        #   normalized:   4.0 * (18.0/19.0) + 2.25 + 2*0.100 = 6.24
        #   unnormalized: 4.0 * 18.0        + 2.25 + 2*0.100 = 74.45
        #
        # The `screen_settings` EVENT scores 5.0 (exact title) + 2.0 (perfect
        # trigram on that title) + its own lexical leg: 8.33 normalized, 9.00
        # unnormalized. So the fix wins by ~2.1 and the revert loses by ~65 — the
        # verdict is not sitting on a rounding error in either direction. Every
        # other document this query retrieves is a variable bound to the
        # screen_settings event, topping out at ~4.7 on the 3.5 keyword-token tier.
        #
        # The corpus document is invisible to every case above it: its text carries
        # no `spot`, `purchase` or `улов` lexeme, no trigram over the 0.3 threshold
        # for any of their queries, and no substring any of them LIKE-match, so it
        # is not even retrieved by them. See its comment in corpus.py for the
        # bindings that keep the repetitions out of every EVENT document too.
        expect_top=EVENT_SCREEN_SETTINGS,
        must_not_outrank=(VAR_CARD_TARGET,),
    ),
    RelevanceCase(
        id="spaced-query-finds-underscored-event",
        query="screen spot",
        measured="production: screen_spot ranked 5th at 4.545",
        # Fixed by tripl-h9x2: token_boundary_regex folds 'screen spot' into
        # 'screen_spot', so the 3.5 keyword-token tier fires on the event's own
        # name, and every identifier is additionally indexed in its spaced form.
        expect_top=EVENT_SCREEN_SPOT,
        must_not_outrank=(VAR_SPOT_ID, VAR_CUBE, EVENT_SCREEN_HOME),
    ),
    RelevanceCase(
        id="russian-phrase-finds-the-event-it-describes",
        query="экран спота",
        measured=(
            "production: never returned screen_spot at all, though its description "
            "is literally 'Показ экрана спота'"
        ),
        # Fixed by tripl-nh5s, the half tripl-h9x2 could not reach. The regex
        # tiers were made Unicode-aware there, but a regex matches literal
        # characters and the document says 'экрана спота' where the query says
        # 'экран спота'. With the Russian Snowball dictionary mapped to non-ASCII
        # word tokens, both sides stem to 'экран' & 'спот' and the event is
        # RETRIEVED — which is all it needs, since its two competitors survive on
        # trigram similarity alone (a subtitle every pageview event shares, and
        # the 'Экран' field whose title is a substring of the query).
        expect_top=EVENT_SCREEN_SPOT,
        must_not_outrank=(EVENT_SCREEN_HOME, FIELD_SCREEN),
        # MEASURED on this harness after tripl-gbxj/h9x2/txcz/nh5s landed:
        # Экран=1.000, screen_spot=0.791, spot=0.433. The event went from ABSENT
        # in production to rank 1, which is what those four fixes were for — but
        # the `Экран` FIELD still takes the top slot, and that is a different
        # fault with a different cause: its whole title is ONE of the query's two
        # words, while screen_spot matches BOTH of them in its description.
        # Nothing in the scoring rewards term COVERAGE, so a short almost-exact
        # title beats a complete match. Tuning a weight to flip this one case
        # would be fitting to a sample; the fix is a coverage term, and that is
        # its own change (tripl-9t2s).
        xfail="tripl-9t2s: nothing in the score rewards matching MORE of the query",
    ),
    RelevanceCase(
        id="purchase-singular",
        query="purchase",
        measured="production: 19.565, correct entity on top — the control for the pair below",
        expect_top=EVENT_PURCHASE,
        must_not_outrank=(VAR_SCREEN_NAME,),
    ),
    RelevanceCase(
        id="purchase-plural",
        query="purchases",
        measured="production: q='purchase' 19.565 vs q='purchases' 5.160",
        # Fixed by tripl-nh5s. Both halves of that issue are needed here and the
        # case is the reason to say so: the English Snowball dictionary stems
        # 'purchases' and 'purchase_completed' to the same 'purchas', which gets
        # the event RETRIEVED, but the harvested screen name literally spells
        # 'purchases' in its body and was still collecting the 3.0 body-token
        # boost the event could not reach. The 3.25 stemmed tier over
        # title/keywords is what puts the event back on top.
        expect_top=EVENT_PURCHASE,
        must_not_outrank=(VAR_SCREEN_NAME,),
    ),
    RelevanceCase(
        id="ulov-singular",
        query="улов",
        measured="production: 3.006 with the catch-report events on top — the control",
        expect_top=EVENT_CATCH_REPORT,
        must_not_outrank=(VAR_SCREEN_NAME, FIELD_CATCH_KIND),
    ),
    RelevanceCase(
        id="ulov-plural",
        query="уловы",
        measured="production: max 0.900, every catch-report event gone",
        # Fixed by tripl-nh5s, Russian half. 'уловы', 'улове' and 'улова' all
        # stem to 'улов', so the event, its 'Отчёт об улове' type and the 'Тип
        # улова' field are all retrieved by the plural for the first time. The
        # event carries 'улове' in the type name folded into its keywords, so it
        # takes the 3.25 tier while the harvested screen name — whose keywords
        # lost their values to tripl-gbxj — is left on its literal 3.0.
        expect_top=EVENT_CATCH_REPORT,
        must_not_outrank=(VAR_SCREEN_NAME,),
    ),
    RelevanceCase(
        id="spots-plural",
        query="spots",
        measured="production: q='spots' never returns 'spot' or 'screen_spot'",
        # Fixed by tripl-nh5s. 'spots' stems to 'spot', which every spot_* value
        # in the corpus already indexes, so the event named 'spot' is retrieved
        # and its title stems to the query — the 3.25 tier — while the harvested
        # screen name spelled 'spots' keeps only its literal body tier. This is
        # also the case that proves the tier discriminates rather than lifting
        # everything: 'screen_spot' stems to 'spot' too and takes the same tier,
        # and 'spot' still wins it on trigram similarity to the query.
        expect_top=EVENT_SPOT,
        must_not_outrank=(VAR_SCREEN_NAME,),
    ),
    RelevanceCase(
        id="garbage-query-is-not-a-confident-answer",
        query="asdkjhasd",
        measured="production: served at confidence 1.0 on an absolute score of 0.636",
        # No ordering expectation on purpose: there is no right answer to this
        # query. The claim under test is that whatever comes back must not be
        # presented as certain.
        # Fixed by tripl-txcz: confidence is a fraction of an ABSOLUTE reference
        # score (_FULL_CONFIDENCE_SCORE) instead of a fraction of the top hit,
        # so the best of a bad set is no longer 1.0 by construction. The same
        # issue put a cosine floor under the semantic leg, which is the other
        # way a junk query used to acquire confident-looking results.
        max_top_confidence=0.5,
    ),
)

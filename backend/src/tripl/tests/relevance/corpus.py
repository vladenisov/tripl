"""The miniature corpus the search-relevance harness ranks against (tripl-338u).

WHY THIS EXISTS
---------------
The backend suite runs on in-memory SQLite (``tests/conftest.py``), and search
keeps a hand-written Python fallback (``_search_query.sqlite_search``) for
exactly that reason. The consequence is that the PRODUCTION ranking SQL —
``postgres_lexical_search`` (``services/_search_query.py``), the semantic leg,
and ``merge_results`` — has never been executed by a test. Every weight in that
SQL is therefore unfalsifiable: you can change ``lexical_score * 4.0`` to
anything at all and the suite stays green. This corpus is the input half of the
fix; :mod:`tripl.tests.relevance.cases` is the expectation half.

WHAT IT REPRODUCES
------------------
It is a deliberate miniature of three ranking faults measured on production
(26 queries, three real projects, every response HTTP 200):

* **Harvested-value noise beats the real entity.** One production project holds
  1526 auto-detected "variables" that are really harvested field values. A
  variable document used to repeat the variable name, the bound event names and
  every observed value in BOTH ``body`` and ``keywords``
  (``_search_documents._variable_document``), and ``ts_rank_cd`` was called with
  no normalization flag and weighted x4, so raw term frequency scaled without
  bound. Both halves were fixed by tripl-gbxj — harvested values are body text
  only, and the rank is normalized with flag 32 — and the two cases below that
  measured it no longer carry an ``xfail``. Measured before that: ``q='spot'`` returned
  ``${property.spot_id}`` at 73.69 and ``${property.cube}`` at 55.68 — the
  latter purely because one harvested value is ``spot:reload:bento`` — while the
  events actually named ``spot`` and ``screen_spot`` did not appear at all.
  Reproduced here by ``property.spot_id`` / ``property.cube`` /
  ``page_data.extra.spot_id``, whose bound contexts outnumber any single event's.
  Those three reproduce the SHAPE of the fault but not its SCALE, and only the
  scale separates the two code paths: normalization flag 32 bends outliers and
  leaves ordinary scores alone, so at the handful of values per context those
  three carry, the fixed and the unnormalized SQL order this corpus
  identically. ``property.card_target`` — 180
  repetitions of one token in a single document, the production profile — is what
  makes the normalization half falsifiable; read its comment for the arithmetic.

* **No stemming in any language.** ``tripl_search`` was
  ``CREATE TEXT SEARCH CONFIGURATION ... (COPY = simple)`` with only ``unaccent``
  mapped, and ``simple`` does not stem. Measured: ``q='улов'`` 3.006 with the
  catch-report events on top vs ``q='уловы'`` 0.900 with every catch-report event
  gone; ``q='purchase'`` 19.565 vs ``q='purchases'`` 5.160; ``q='spots'`` never
  returns ``spot``. Reproduced by ``catch_report_created`` / ``purchase_completed``
  carrying only the singular, and by ``property.screen_name`` — a harvested screen
  name whose observed values happen to include the plurals ``purchases``,
  ``уловы`` and ``spots``, which is what a plural query hit instead. Fixed by
  tripl-nh5s (migration ``a7c3e1b9d5f2``), and the corpus is deliberately built so
  that the fix cannot be faked: the singular entity and the plural-spelling
  variable are BOTH in the index, so a plural query has a wrong answer available
  to it and has to out-rank it rather than merely retrieve something.

* **The boost ladder cannot see a phrase or Cyrillic.**
  ``token_boundary_regex`` returns ``None`` for anything outside ``[a-z0-9_]+``,
  which removes the 3.5/3.0 tiers for every query with a space or Cyrillic, and
  the surviving ``LIKE`` tiers compare a spaced query against an underscored
  title. Measured: ``q='screen spot'`` ranked ``screen_spot`` 5th at 4.545;
  ``q='экран спота'`` never returned it, though its description is literally
  ``Показ экрана спота``. Reproduced by that exact event plus same-type siblings
  (``screen_home``, ``screen_settings``, ``app_open``) that share its subtitle, so
  a hit surviving on subtitle trigram similarity alone cannot land on top by luck.

* **Confidence is normalized to the top hit**, so a query that matched nothing is
  still served at confidence 1.0 (measured: ``q='asdkjhasd'`` at 1.0 on an
  absolute score of 0.636). Reproduced by ``property.session_key``, whose
  harvested values are junk device keys — one of them contains ``asdkjhasd``, so
  a garbage query retrieves something weak instead of retrieving nothing, which
  is what makes the confidence claim observable at all.

TWO DELIBERATE OMISSIONS
------------------------
The ``pageviews`` field definitions are named ``view_id`` / ``card_id`` rather
than ``screen`` / ``spot_id``. Field names are copied into the event-type
document (``_event_type_document`` folds ``field_text`` into ``body``), and any
event-type document that matches the query multiplies EVERY event of that type by
up to 1.75 (``_search_query._apply_event_type_boost``). Naming the fields after
the query terms would silently apply that multiplier to the very events under
measurement and turn each case into a test of the type boost instead of a test of
the lexical ranking. The events, their values and the variables still carry
``screen``/``spot`` exactly as production does.

No event tags are seeded. A tag document has ``keywords = tag.name``, which trips
the ``lower(d.keywords) = lower(:query)`` 4.0 tier and would add a fourth,
unrelated competitor to every single-word case for no extra signal.

The corpus is ~30 documents: small enough to read end to end, large enough that
no case is decided by having only one candidate.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.domain_enums import FieldDefinitionType
from tripl.models.event import Event, EventStatus
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.project import Project
from tripl.models.variable import Variable, VariableType
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.services.plan_branch_service import ensure_main_branch_id

#: Distinctive enough that it cannot collide with a project a developer actually
#: has, in the (unsupported) event someone points the harness at a real database.
PROJECT_SLUG = "relevance-harness"
PROJECT_NAME = "Relevance Harness"


@dataclass(frozen=True)
class SeedField:
    name: str
    display_name: str
    description: str = ""


@dataclass(frozen=True)
class SeedEventType:
    name: str
    display_name: str
    description: str
    fields: tuple[SeedField, ...]


@dataclass(frozen=True)
class SeedEvent:
    name: str
    event_type: str
    description: str
    #: ``(field name, observed value)`` pairs; the field must belong to the
    #: event's own type.
    field_values: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class SeedContext:
    """One ``VariableValue``: a variable bound to a specific event + field.

    This is the row that makes a variable document heavy — every context repeats
    the variable name, the event name, the source column and all observed values
    into both ``body`` and ``keywords``.
    """

    event: str
    field: str
    source_column: str
    values: tuple[str, ...]
    observed_count: int


@dataclass(frozen=True)
class SeedVariable:
    name: str
    description: str
    contexts: tuple[SeedContext, ...]


@dataclass(frozen=True)
class Corpus:
    """Identifiers the harness needs to query what it just seeded."""

    slug: str
    project_id: uuid.UUID
    branch_id: uuid.UUID


EVENT_TYPES: tuple[SeedEventType, ...] = (
    SeedEventType(
        name="pageviews",
        display_name="Просмотры экранов",
        description="Показы экранов и карточек в приложении",
        fields=(
            SeedField("view_id", "Экран", "Идентификатор показанного экрана"),
            SeedField("card_id", "Карточка", "Идентификатор открытой карточки"),
        ),
    ),
    SeedEventType(
        name="catch_report",
        display_name="Отчёт об улове",
        description="События рыбалки",
        fields=(
            SeedField("catch_kind", "Тип улова", "Что именно поймали"),
            SeedField("catch_weight", "Вес улова", "Вес в килограммах"),
        ),
    ),
    SeedEventType(
        name="commerce",
        display_name="Commerce",
        # Deliberately free of the word "purchase": the commerce event-type
        # document must not match `q='purchase'`, or the event-type boost lifts
        # every commerce event at once and the case stops measuring the ranking.
        description="Payments and refunds",
        fields=(
            SeedField("product", "Product", "Product identifier"),
            SeedField("payment_method", "Payment method", "How the user paid"),
        ),
    ),
)

EVENTS: tuple[SeedEvent, ...] = (
    SeedEvent("app_open", "pageviews", "Запуск приложения", (("view_id", "app_open"),)),
    SeedEvent("screen_home", "pageviews", "Показ главного экрана", (("view_id", "screen_home"),)),
    SeedEvent(
        "screen_settings",
        "pageviews",
        "Показ экрана настроек",
        (("view_id", "screen_settings"),),
    ),
    # The two events at the centre of faults A and C.
    SeedEvent(
        "screen_spot",
        "pageviews",
        "Показ экрана спота",
        (("view_id", "screen_spot"), ("card_id", "spot_1042")),
    ),
    SeedEvent(
        "spot",
        "pageviews",
        "Открытие карточки спота",
        (("view_id", "spot"), ("card_id", "spot_1042")),
    ),
    # Fault B, Russian half. Carries the bare token "улов" twice so the singular
    # query has a real lexical hit and the plural query provably has none.
    SeedEvent(
        "catch_report_created",
        "catch_report",
        "Отправлен улов: пользователь подтвердил улов в отчёте",
        (("catch_kind", "улов"), ("catch_weight", "3.2")),
    ),
    # Fault B, English half.
    SeedEvent(
        "purchase_completed",
        "commerce",
        "Purchase completed successfully",
        (("product", "premium_year"), ("payment_method", "card")),
    ),
    SeedEvent(
        "payment_failed",
        "commerce",
        "Payment declined by the provider",
        (("payment_method", "card"),),
    ),
)

#: Harvested identifiers. Every one of them tokenizes to a `spot` lexeme because
#: the Postgres text-search parser splits on `_`, which is the mechanism behind
#: `${property.spot_id}` scoring 73.69 for `q='spot'` in production.
_SPOT_IDS: tuple[str, ...] = ("spot_1042", "spot_88", "spot_7", "spot_301")

#: Composite keys harvested into an auto-detected variable. These are why
#: `${property.cube}` — a variable with nothing to do with spots — scored 55.68
#: for `q='spot'`: `:` is not a word character, so `spot` is a standalone token
#: here and even wins the 3.5 keyword-token boost tier.
_CUBE_KEYS: tuple[str, ...] = (
    "spot:reload:bento",
    "spot:open:bento",
    "spot:close:bento",
    "home:reload:bento",
)

#: Harvested screen names. The plurals are the point: with no stemming, these are
#: what `q='purchases'`, `q='уловы'` and `q='spots'` used to hit, instead of the
#: purchase / catch-report / spot entities the user was looking for. They stay in
#: the corpus after tripl-nh5s because they are the wrong answer the fix has to
#: OUT-RANK: each of them still spells the plural literally, which is worth a 3.0
#: body-token boost that no correctly-spelled entity can earn — the reason a
#: stemmer alone did not move these queries and the ladder needed the 3.25 tier.
_SCREEN_NAMES: tuple[str, ...] = ("purchases", "уловы", "spots", "экран_поиска")

#: Harvested town names — the shape of the 1526 auto-detected "variables" that are
#: really field values. They match none of the queries; they are here so the
#: corpus has the same kind of bulk the production index has.
_TOWNS: tuple[str, ...] = ("Тверь", "Казань", "Сочи", "Пермь", "Уфа", "Тула", "Омск", "Клин")

#: Harvested session keys. `asdkjhasd7f2` is what makes the confidence case
#: observable: a garbage query retrieves this weakly instead of retrieving
#: nothing, and today it is still served at confidence 1.0.
_SESSION_KEYS: tuple[str, ...] = ("asdkjhasd7f2", "k18sjdhq", "a91mzz01")

#: Harvested card destinations: the identifier of the screen a settings card
#: opens. THE REPETITION OUTLIER (tripl-gbxj, normalization half).
#:
#: WHY THIS EXISTS NEXT TO THE SPOT VARIABLES ABOVE, WHICH LOOK LIKE THE SAME THING
#: `property.spot_id` and friends reproduce the SHAPE of fault A — a
#: harvested-value document mentioning the query term more often than the entity
#: named after it — but not its SCALE, and scale is the only thing the
#: normalization flag reacts to. Flag 32 is `rank / (rank + 1)`: it bends
#: OUTLIERS and leaves ordinary scores essentially untouched, so at the four-to-
#: eight values per context every variable above carries, the two code paths —
#: `ts_rank_cd(d.text_vector, q.tsq, 32)` and the
#: unnormalized `ts_rank_cd(d.text_vector, q.tsq)` it replaced — order this corpus
#: identically. Measured before this variable existed: reverting the flag left the
#: harness byte-identically green (14 passed, 1 xfailed), so half of tripl-gbxj
#: had no regression guard at all while the other half — harvested values out of
#: `keywords` — was pinned by `purchase-plural`. This variable is the missing
#: input; `cases.repetition-outlier-does-not-outrank-the-screen-it-names` is the
#: missing expectation.
#:
#: WHY 180 OCCURRENCES AND NOT SOME OTHER NUMBER
#: The production fault needed scale: 1526 auto-detected harvested-value
#: variables, one document repeating the query token roughly 180 times, which
#: drove its raw `ts_rank_cd` to ~18 and its lexical leg (`* 4.0`) to ~68 — an
#: order of magnitude past the entire boost ladder — against a correct answer at
#: 4.55 (see `_search_query.postgres_lexical_search`). So the count here is that
#: count: 6 sections x 15 card ids = 90 values, bound to 2 contexts = 180
#: occurrences of the `screen`+`settings` cover in one body. Measured on the real
#: `tripl_search` configuration, both halves of the arithmetic hold:
#:
#: * unnormalized, raw rank 18.0 -> lexical leg 72.0, and this document scores
#:   ~74.5 against the `screen_settings` EVENT's 9.0 (5.0 exact title + 2.0
#:   trigram + 2.0 lexical). The revert loses by 65 points, not by a rounding
#:   error;
#: * normalized, the same rank collapses to 0.947 -> lexical leg 3.79, and the
#:   document scores ~6.24 against the event's 8.33. The case passes with ~2
#:   points of margin, which is wider than any single tier of the boost ladder.
#:
#: 180 is also comfortably under the 256 positions a `tsvector` keeps per lexeme,
#: so the outlier is carried by the rank rather than silently truncated by the
#: index — a larger count would not have made the failure any louder.
#:
#: WHY THE VALUES ARE UNDERSCORE-JOINED
#: PostgreSQL's `\m...\M` word boundaries treat `_` as a word character, so
#: `screen_settings_billing_1040` never fires the 3.5 (keywords) or 3.0 (body)
#: token tiers, and this document's only boost is the 2.25 body-LIKE tier. The
#: text-search parser splits on `_` regardless, so `ts_rank_cd` still sees all 180
#: covers. What lifts this document under the reverted code is therefore
#: `ts_rank_cd` and nothing else — which is exactly the mutation the case pins.
_SETTINGS_CARD_TARGETS: tuple[str, ...] = tuple(
    f"screen_settings_{section}_{card_id}"
    for section in ("billing", "profile", "notifications", "privacy", "about", "language")
    for card_id in range(1040, 1055)
)


def _contexts(
    source_column: str,
    values: tuple[str, ...],
    bindings: tuple[tuple[str, str], ...],
    observed_count: int,
) -> tuple[SeedContext, ...]:
    return tuple(
        SeedContext(
            event=event_name,
            field=field_name,
            source_column=source_column,
            values=values,
            observed_count=observed_count,
        )
        for event_name, field_name in bindings
    )


#: Every (event, field) pair a pageview variable can bind to. A production
#: harvested variable is bound to far more contexts than any single event has,
#: which is precisely why its document outweighs the event's.
_PAGEVIEW_BINDINGS: tuple[tuple[str, str], ...] = (
    ("app_open", "view_id"),
    ("screen_home", "view_id"),
    ("screen_settings", "view_id"),
    ("screen_spot", "view_id"),
    ("screen_spot", "card_id"),
    ("spot", "view_id"),
    ("spot", "card_id"),
)

VARIABLES: tuple[SeedVariable, ...] = (
    SeedVariable(
        name="property.spot_id",
        description="Идентификатор карточки, определён автоматически",
        contexts=_contexts("properties.spot_id", _SPOT_IDS, _PAGEVIEW_BINDINGS, 8140),
    ),
    SeedVariable(
        name="property.cube",
        description="Составной ключ экрана, определён автоматически",
        contexts=_contexts("properties.cube", _CUBE_KEYS, _PAGEVIEW_BINDINGS, 6221),
    ),
    SeedVariable(
        name="page_data.extra.spot_id",
        description="Идентификатор спота из полезной нагрузки, определён автоматически",
        contexts=_contexts(
            "page_data.extra.spot_id",
            _SPOT_IDS[:2],
            (("spot", "card_id"), ("screen_spot", "card_id")),
            1904,
        ),
    ),
    SeedVariable(
        name="property.screen_name",
        description="Имя экрана, определено автоматически",
        contexts=_contexts(
            "properties.screen_name",
            _SCREEN_NAMES,
            (("app_open", "view_id"), ("screen_home", "view_id"), ("screen_settings", "view_id")),
            4402,
        ),
    ),
    SeedVariable(
        name="property.city",
        description="Город пользователя, определён автоматически",
        contexts=_contexts(
            "properties.city",
            _TOWNS,
            (
                ("app_open", "view_id"),
                ("screen_home", "view_id"),
                ("catch_report_created", "catch_kind"),
            ),
            9530,
        ),
    ),
    SeedVariable(
        name="property.session_key",
        description="Ключ сессии, определён автоматически",
        contexts=_contexts(
            "properties.session_key",
            _SESSION_KEYS,
            (("app_open", "view_id"), ("screen_settings", "view_id")),
            7311,
        ),
    ),
    # The repetition outlier (tripl-gbxj). See _SETTINGS_CARD_TARGETS for why the
    # count is 180 and what each code path scores.
    #
    # THE BINDINGS ARE WHAT KEEP THE BLAST RADIUS AT ZERO — DO NOT "TIDY" THEM
    # Both contexts bind to `card_id` on events that declare no card_id value of
    # their own: EVENTS gives `app_open` and `screen_home` a `view_id` value and
    # nothing else. That is deliberate. `_search_documents._event_document` folds a
    # variable's harvested values into an event's body AND its keywords, but it
    # iterates the event's own `field_values` and only picks up contexts for
    # fields the event actually has a recorded value for — so with these bindings
    # the 180 repetitions reach exactly ONE document, this variable's.
    #
    # Binding to `view_id` instead (the obvious-looking choice, since that is
    # where every other pageview variable binds) would copy 180 `screen_settings`
    # occurrences into the `app_open` and `screen_home` event documents and hand
    # both of them a saturated lexical leg plus the 3.25 stemmed tier. `app_open`
    # already carries `spot` lexemes from `property.spot_id`, so it would newly
    # match `q='screen spot'` at ~7.0 and start competing with the `screen_spot`
    # event the `spaced-query-finds-underscored-event` case expects on top — a
    # green case re-baselined by a test-only addition, which is exactly what this
    # change is required not to do. Binding to `screen_settings` itself is wrong
    # for the mirror-image reason: the event name would enter this document's
    # keywords and buy it the 3.5 token tier, closing the margin the case needs.
    #
    # A harvested variable with no matching EventFieldValue is the production
    # shape, not a workaround: variables are auto-detected from ingested traffic
    # (hence `observed_count` in the thousands), while an event's field value is
    # the example its spec carries. The two are populated by different pipelines
    # and routinely disagree.
    SeedVariable(
        name="property.card_target",
        description="Куда ведёт карточка, определено автоматически",
        contexts=_contexts(
            "properties.card_target",
            _SETTINGS_CARD_TARGETS,
            (("app_open", "card_id"), ("screen_home", "card_id")),
            5188,
        ),
    ),
)


async def seed_corpus(session: AsyncSession) -> Corpus:
    """Insert the corpus and COMMIT it, returning what the harness needs to query.

    Seeds through the ORM rather than through the HTTP API on purpose: the
    harness is about ranking, and going through the API would drag registration,
    auth and a dozen endpoints into the failure surface of a search test. The
    documents themselves are still built by production code — the caller runs
    ``search_service.reindex_project_branch``, so ``build_documents`` and
    ``_refresh_text_vectors`` produce exactly the rows production ranks (tripl-338u).
    """
    project = Project(
        name=PROJECT_NAME,
        slug=PROJECT_SLUG,
        description="Fixed corpus for the search relevance harness (tripl-338u)",
    )
    session.add(project)
    await session.flush()
    branch_id = await ensure_main_branch_id(session, project.id)

    event_types: dict[str, EventType] = {}
    field_definitions: dict[tuple[str, str], FieldDefinition] = {}
    for type_order, seed_type in enumerate(EVENT_TYPES):
        event_type = EventType(
            project_id=project.id,
            branch_id=branch_id,
            name=seed_type.name,
            display_name=seed_type.display_name,
            description=seed_type.description,
            order=type_order,
        )
        session.add(event_type)
        await session.flush()
        event_types[seed_type.name] = event_type
        for field_order, seed_field in enumerate(seed_type.fields):
            definition = FieldDefinition(
                event_type_id=event_type.id,
                name=seed_field.name,
                display_name=seed_field.display_name,
                field_type=FieldDefinitionType.string.value,
                description=seed_field.description,
                order=field_order,
            )
            session.add(definition)
            field_definitions[seed_type.name, seed_field.name] = definition
    await session.flush()

    events: dict[str, Event] = {}
    event_type_of: dict[str, str] = {}
    for event_order, seed_event in enumerate(EVENTS):
        event = Event(
            project_id=project.id,
            branch_id=branch_id,
            event_type_id=event_types[seed_event.event_type].id,
            name=seed_event.name,
            description=seed_event.description,
            order=event_order,
            status=EventStatus.implemented.value,
        )
        session.add(event)
        await session.flush()
        events[seed_event.name] = event
        event_type_of[seed_event.name] = seed_event.event_type
        for field_name, value in seed_event.field_values:
            session.add(
                EventFieldValue(
                    event_id=event.id,
                    field_definition_id=field_definitions[seed_event.event_type, field_name].id,
                    value=value,
                )
            )
    await session.flush()

    for seed_variable in VARIABLES:
        variable = Variable(
            project_id=project.id,
            branch_id=branch_id,
            name=seed_variable.name,
            description=seed_variable.description,
            variable_type=VariableType.string.value,
        )
        session.add(variable)
        await session.flush()
        for context in seed_variable.contexts:
            definition = field_definitions[event_type_of[context.event], context.field]
            session.add(
                VariableValue(
                    project_id=project.id,
                    branch_id=branch_id,
                    variable_id=variable.id,
                    event_id=events[context.event].id,
                    field_definition_id=definition.id,
                    source_column=context.source_column,
                    # "high" == high-cardinality: exactly the classification these
                    # harvested values carry in production.
                    value_kind=VariableValueKind.high.value,
                    observed_count=context.observed_count,
                    values=list(context.values),
                )
            )
    await session.commit()

    return Corpus(slug=PROJECT_SLUG, project_id=project.id, branch_id=branch_id)

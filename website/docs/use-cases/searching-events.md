---
title: Searching events
sidebar_position: 3
---

# Searching events

tripl gives you two complementary ways to find events in your tracking plan. They
answer different questions, and using the wrong one wastes time or floods you with
noise:

- **Structured listing** — `GET /events` with substring filters. Use it for
  **exact, precise lookups**: every event carrying a given ticket key, a specific
  field value, a tag, a status, or an event type. Deterministic and repeatable.
- **Smart / semantic search** — `GET /search` with a natural-language query. Use it
  for **feature phrases** when you don't know the exact name: "where do we track
  signup completion?" Ranked by relevance, with a tunable cutoff.

Rule of thumb: if you can name the exact string (a ticket key, an ID, a field
value), use the structured listing. If you're describing a behaviour in words, use
smart search.

## Structured listing — `GET /events`

The listing endpoint applies **substring filters** across the catalog. Every filter
is optional, and you can combine them; results come back as `{items, total}`, with
each item embedding its `field_values`, `meta_values`, and `tags`.

Available query parameters:

| Param | Matches |
| --- | --- |
| `search` | substring over event name and description |
| `field_value` | substring over any field value |
| `meta_value` | substring over any meta value |
| `tag` | events carrying the given tag |
| `event_type_id` | events of a specific event type (a UUID) |
| `status` | events in a given lifecycle status — repeatable |
| `silent_since_days` | events not seen for at least N days |
| `offset` | skip the first N items (paging) |
| `limit` | cap the number of items returned (default `200`, max `10000`) |

`status` is the lifecycle filter, and you can pass it more than once to match any of
several states. The valid values are `draft`, `in_review`, `ready_for_dev`,
`implemented`, `live`, `deprecated`, and `archived`; anything else is rejected
with `422` naming the accepted values. There is no separate `implemented` or
`archived` boolean — "implemented" and "archived" are simply `status` values
(e.g. `status=implemented`, `status=archived`).

### Example: every event carrying a ticket key

This is the canonical precise lookup. If your project stores the originating ticket
as a meta value (for example a meta field named `ticket` holding `PROJ-123`), find
every event tied to that ticket with a single `meta_value` filter:

```bash
curl -s \
  -H "Authorization: Bearer tk_r_your_read_key" \
  "https://tripl.example.com/api/v1/projects/web/events?meta_value=PROJ-123"
```

### Example: combine filters

Find implemented events of one type whose name or description mentions "checkout",
limited to the first 20:

```bash
curl -s \
  -H "Authorization: Bearer tk_r_your_read_key" \
  "https://tripl.example.com/api/v1/projects/web/events?search=checkout&event_type_id=b0c2f1e4-7a3d-4c9e-9f01-2a4b6c8d0e12&status=implemented&limit=20"
```

:::tip Use the listing for exact keys and IDs
Ticket keys, field values, and IDs are exact strings. The substring listing matches
them precisely and only returns events that actually carry them.
:::

## Smart / semantic search — `GET /search`

The smart search endpoint takes a natural-language query `q` and returns ranked hits
across the whole project — not just events, but event types, fields, meta
fields, variables, relations, tags, metrics, and fact tables. The response is
`{items, total, semantic_used}`.

Query parameters:

| Param | Meaning |
| --- | --- |
| `q` | the natural-language query (1–500 characters) |
| `types` | restrict the entity kinds returned — repeatable |
| `include_archived` | include archived entities (default `false`) |
| `limit` | cap the number of hits (default `20`, max `100`) |

Each item carries:

- `entity_type` — one of `event`, `event_type`, `field`, `meta_field`, `variable`,
  `relation`, `tag`, `metric`, `fact_table`
- `title`, `subtitle`, `description` (or `snippet`)
- `confidence` — relevance in `0..1`
- `route_path` — where the entity lives in the app

Event hits additionally include `event_id`, `name`, `implemented`, and
`variable_values` (the observed variable readings for that event).

### Example: a feature phrase

```bash
curl -s \
  -H "Authorization: Bearer tk_r_your_read_key" \
  "https://tripl.example.com/api/v1/projects/web/search?q=where%20do%20we%20track%20signup%20completion&types=event&types=field&limit=10"
```

### Narrowing with `types`

Pass `types` once per entity kind you want to keep. To get only events and the
fields under them:

```text
?q=abandoned%20cart&types=event&types=field
```

### Understanding `confidence` and the cutoff

`confidence` is an **absolute score in `[0, 1]`**, comparable between queries. It is
the hit's relevance measured against the score a result reaches when it *is* the thing
you typed — an exact title match — capped at `1.0`. A query that found nothing good
therefore comes back with low confidence on every item, including the first one; a
top hit of `1.0` means the search really did find an exact match.

It used to be normalized to the top hit of the same response, which made the best
result `1.0` by construction — a keyboard mash was served as a perfect answer. If you
built a cutoff against that behaviour, re-check it: thresholds now mean the same thing
on every query, and the numbers are lower than they used to be for weak queries.

When semantic search is on, a hit the **meaning** match found reports that leg's own
cosine similarity instead, which is already a `0..1` certainty. So a result that no
keyword touched but that the vector index is sure about — a misspelling, or a phrase
that describes an event without naming it — is reported as the strong answer it is,
rather than being scaled down for having arrived by the other route. A single cutoff
therefore works across both legs.

Because the tail of a semantic search is always populated with loosely related
results, **trim it with a minimum-confidence cutoff** (a threshold of `0.6` is a
reasonable starting point):

```bash
curl -s \
  -H "Authorization: Bearer tk_r_your_read_key" \
  "https://tripl.example.com/api/v1/projects/web/search?q=user%20completed%20checkout&limit=25" \
  | jq '[.items[] | select(.confidence >= 0.6)]'
```

### Word forms and plurals

Keyword matching is **stemmed**, in English and in Russian, so a query finds the
other forms of the words you typed: `purchases` finds `purchase_completed`,
`spots` finds the `spot` event, and `экрана спота` finds the event whose
description is «Показ экрана спота». Both scripts work in the same project and
even in the same entity — an event named in `snake_case` with a Russian
description is matched from either side.

Two consequences worth knowing:

- Stemming is about word **forms**, not meaning: `purchase` and `buy` are still
  unrelated to keyword matching. That is what the semantic engine is for.
- Exact names still win. A query that IS an entity's name ranks that entity
  first, ahead of anything that merely stems to it.

### The `semantic_used` flag

`semantic_used` tells you which engine answered:

- `true` — embeddings were used (true semantic ranking by meaning).
- `false` — the instance has no embedding provider configured, so search fell back
  to keyword/substring matching. `/search` still works, but it ranks by word
  overlap (stemmed, as above) rather than by meaning.

Semantic ranking normally requires an embedding provider. See
[AI and search configuration](../run/ai-and-search.md) for how to enable it (and what
the keyword fallback behaves like when it's off).

:::note Demo project exception
The **demo project** ships with precomputed embedding vectors for its own
content and a small set of suggested queries, so demo searches can return
`semantic_used: true` even on an instance with **no** embedding provider
configured. Don't use demo-project responses to diagnose an instance's
embedding configuration — check a regular project (or the settings) instead.
:::

## When NOT to use smart search

:::warning Don't use smart search for exact keys or IDs
A semantic query for an exact code (a ticket key, an event ID, a field value)
**floods** the results: the exact string is loosely related to many events, so the
ranking surfaces dozens of weak matches instead of the one you want. For exact keys
and IDs, always use the **structured listing** (`GET /events`) with `meta_value`,
`field_value`, or `search` — it returns only the events that actually carry the
string.
:::

## Choosing a mode

| You want to… | Use |
| --- | --- |
| Find every event tagged to ticket `PROJ-123` | listing — `meta_value=PROJ-123` |
| Find events with a specific field value | listing — `field_value=…` |
| List implemented events of one type | listing — `event_type_id=…` + `status=implemented` |
| List not-yet-implemented events of one type | listing — `event_type_id=…` + `status=draft` |
| Find "where do we track signup completion?" | smart search — `q=…` |
| Discover related fields/variables for a feature | smart search — `q=…&types=event&types=field` |

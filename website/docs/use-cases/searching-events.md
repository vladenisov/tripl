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
`implemented`, `live`, `deprecated`, and `archived`. There is no separate
`implemented` or `archived` boolean — "implemented" and "archived" are simply
`status` values (e.g. `status=implemented`, `status=archived`).

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
across the whole tracking plan — not just events, but event types, fields, meta
fields, variables, relations, and tags. The response is
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
  `relation`, `tag`
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

`confidence` is **relative ranking, not an absolute score**. Each hit's relevance is
normalized to the **top hit**, so the best match is always `1.0` and the rest trail
off toward `0`. It tells you how each result compares to the strongest match in *this*
query — it does not mean "X% correct".

Because the tail of a semantic search is always populated with loosely related
results, **trim it with a minimum-confidence cutoff** (a threshold of `0.6` is a
reasonable starting point):

```bash
curl -s \
  -H "Authorization: Bearer tk_r_your_read_key" \
  "https://tripl.example.com/api/v1/projects/web/search?q=user%20completed%20checkout&limit=25" \
  | jq '[.items[] | select(.confidence >= 0.6)]'
```

### The `semantic_used` flag

`semantic_used` tells you which engine answered:

- `true` — embeddings were used (true semantic ranking by meaning).
- `false` — the instance has no embedding provider configured, so search fell back
  to keyword/substring matching. `/search` still works, but it ranks by literal
  token overlap rather than meaning.

Semantic ranking requires an embedding provider. See
[AI and search configuration](../run/ai-and-search.md) for how to enable it (and what
the keyword fallback behaves like when it's off).

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

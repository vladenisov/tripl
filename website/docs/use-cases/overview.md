---
title: Use cases
sidebar_position: 1
---

# Use cases

tripl is the canonical, queryable source of truth for your tracking plan — the
catalog of analytics events, their fields, meta fields, and descriptions. It is
built to be read and written by **both people and automation**: a teammate
browsing the app and an LLM agent or script hitting the REST API see exactly the
same catalog.

This section documents the patterns that fall out of treating the tracking plan
as a single, shared source of truth:

- **Query the catalog.** Find events before you act on them — by exact filters
  (event type, tag, a meta value carrying a ticket key), by field or meta
  substring, or by a natural-language feature phrase. The catalog tells you what
  already exists so you avoid duplicating or contradicting it.
- **Keep it in sync from an agent or script.** An LLM agent or automation can
  read the relevant events, draft new or updated definitions, and write them
  back safely with a WRITE key — attaching the originating ticket as a meta value
  so events stay retrievable by task.
- **Discover with smart search.** When you do not know the exact name, semantic
  search ranks events by relevance to a feature description, helping you find the
  right event to read or extend.

## Where to go next

- [Keep the catalog in sync from an LLM agent](./llm-agent.md) — the
  read-first, draft, validate, write-safely loop for agents and scripts.
- [Search and discover events](./searching-events.md) — structured listing
  versus smart/semantic search, and when to use each.
- [Enable smart search](../run/ai-and-search.md) — the instance settings that
  turn on semantic embeddings and AI assistance.

:::note
Smart search works even without embeddings configured: `/search` falls back to
keyword/substring matching (`semantic_used=false`). Enabling embeddings only
improves natural-language ranking — see [Enable smart search](../run/ai-and-search.md).
:::

---
title: AI & search providers
sidebar_position: 6
---

# AI & search providers

tripl ships with two **optional** feature groups that reach out to an external,
OpenAI-compatible provider. Both are **OFF by default** and must be explicitly
enabled — tripl runs fully without either:

1. **Semantic search embeddings** — upgrades the smart/global search
   (`GET /projects/{slug}/search`) from keyword/substring matching to
   embedding-based semantic ranking.
2. **AI assistance** — powers in-app helpers such as event-description
   suggestions on the event form.

A single shared variable, `OPENAI_API_KEY`, acts as the credential fallback for
both groups, so a minimal setup only needs one key.

:::info Why opt-in
Both groups send tracking-plan text to a third-party provider. They stay off
until an operator turns them on, so a default deployment never transmits your
catalog anywhere. See the [privacy trade-off](#the-privacy-trade-off) below.
:::

---

## Semantic search embeddings

When enabled, tripl indexes your tracking-plan text (event names, descriptions,
field and meta values, and related entities) as vector embeddings and uses them
to rank smart-search results by meaning rather than literal substring overlap.
The `/search` response then reports `semantic_used: true`.

When **disabled** — the default — `/search` still works. It transparently falls
back to keyword/substring matching and returns `semantic_used: false`. No text
leaves the instance. The one exception is the **demo project**: it ships with
precomputed embedding vectors for its own content, so demo searches can report
`semantic_used: true` without any provider configured — still with no text
leaving the instance, since those vectors are computed by maintainers ahead of
time and bundled with the release.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARCH_EMBEDDINGS_ENABLED` | `false` | Master switch for semantic search. When `false`, `/search` uses keyword/substring fallback only. |
| `SEARCH_EMBEDDING_PROVIDER` | `openai` | Embedding provider. |
| `SEARCH_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model used to index and query tracking-plan text. |
| `SEARCH_EMBEDDING_DIMENSIONS` | `1536` | Vector dimensionality. Must match the chosen model. |
| `SEARCH_EMBEDDING_API_KEY` | falls back to `OPENAI_API_KEY` | Credential for the embedding provider. |

:::tip
Leave `SEARCH_EMBEDDING_API_KEY` unset and just provide `OPENAI_API_KEY` if the
same credential serves both embeddings and AI assistance.
:::

---

## AI assistance

AI assistance drives generative helpers in the app — for example, suggesting an
event description on the event form. It targets an OpenAI-compatible chat
endpoint.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Master switch for AI assistance. When `false`, AI-backed helpers return a "disabled" response. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible API. Point this at a proxy or self-hosted endpoint to use a different backend. |
| `AI_MODEL` | `gpt-4o-mini` | Chat/completion model. |
| `AI_API_KEY` | falls back to `OPENAI_API_KEY` | Credential for the AI provider. |
| `AI_TIMEOUT_SECONDS` | `30` | Per-request timeout. |
| `AI_MAX_OUTPUT_TOKENS` | `700` | Cap on generated output length. |

:::note Bring your own endpoint
Because `AI_BASE_URL` speaks the OpenAI-compatible protocol, any compatible
gateway, proxy, or self-hosted model server works in place of OpenAI — set
`AI_BASE_URL` to its address and `AI_API_KEY` to whatever credential it expects.
:::

---

## The privacy trade-off

Enabling either group means tripl transmits indexed tracking-plan text to the
configured provider:

- **Embeddings** send event names, descriptions, field/meta values and related
  entity text to the embedding provider so they can be turned into vectors for
  semantic ranking.
- **AI assistance** sends the relevant event context to the chat model to
  generate suggestions.

This is precisely why both default to **OFF**: you opt in knowingly.

:::warning
With embeddings disabled, search is **not** broken — it degrades gracefully to
keyword/substring matching (`semantic_used: false`, except in the demo project,
which uses bundled precomputed vectors). Many deployments run this way
indefinitely. Only enable embeddings if you accept sending tracking-plan text
to the provider in exchange for semantic relevance.
:::

If your provider is a self-hosted or in-VPC OpenAI-compatible endpoint, you can
keep both features on while keeping all text inside your own infrastructure —
point `SEARCH_EMBEDDING_*` and `AI_BASE_URL` at that endpoint.

---

## How to set these

### Compose / environment

Like all backend settings, these are read from the process environment or a
`.env` file. In Docker Compose, add them to the API service environment:

```yaml
services:
  api:
    environment:
      # Semantic search embeddings (opt-in)
      SEARCH_EMBEDDINGS_ENABLED: "true"
      SEARCH_EMBEDDING_PROVIDER: openai
      SEARCH_EMBEDDING_MODEL: text-embedding-3-small
      SEARCH_EMBEDDING_DIMENSIONS: "1536"

      # AI assistance (opt-in)
      AI_ENABLED: "true"
      AI_BASE_URL: https://api.openai.com/v1
      AI_MODEL: gpt-4o-mini
      AI_TIMEOUT_SECONDS: "30"
      AI_MAX_OUTPUT_TOKENS: "700"

      # Shared credential fallback for both groups
      OPENAI_API_KEY: ${OPENAI_API_KEY}
```

Provide the key through your secret mechanism rather than committing it. See the
full [Configuration reference](./configuration.md) for how settings are loaded.

### Settings → Instance → AI

Operators can also review and adjust this configuration from the running
instance under **Settings → Instance → AI** (for example, at
`https://tripl.example.com/settings/instance/ai`). The same page governs both
the AI-assistance settings and the embeddings toggle, with the environment
variables above acting as defaults that the stored overrides can replace at
runtime — so you can confirm the active model and flip features on or off
without redeploying.

---

## Related

- [Configuration reference](./configuration.md) — every environment variable.
- [Admin guide](../administer/admin-guide.md) — instance settings and operator tasks.
- [Searching events](../use-cases/searching-events.md) — how smart search and the structured listing differ in practice.

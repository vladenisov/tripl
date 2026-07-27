# Agent API Guide

This guide describes the recommended way for external LLM agents and CLI scripts to consume the tripl API.

## Recommendation

Use the existing FastAPI OpenAPI contract plus this guide as the primary agent integration path.

- Machine-readable contract: `GET /openapi.json`
- Interactive contract browser: `GET /docs`
- Base API prefix: `/api/v1`

tripl now ships a first-party MCP server (`tripl-mcp`) that wraps this API in a curated toolset for MCP-capable agent runtimes — see [MCP Server](./mcp-server.md) for setup. This guide remains the raw REST contract underneath it: every MCP tool calls the endpoints described here with the same API-key auth, project fencing, and branch rules. Use the MCP server when the agent runs in an MCP-capable runtime; use raw OpenAPI plus this guide for direct HTTP integrations, scripts, and anything the curated toolset does not cover.

## MCP Server

For agents running in MCP-capable runtimes (Claude Code, Claude Desktop, and other MCP clients), `tripl-mcp` packages a curated read/write toolset on top of this API: stdio and streamable-http transports, `readOnlyHint` annotations on read tools, `tk_w_` key requirements on write tools, a mandatory `branch_id` on plan-mutating tools, and a `TRIPL_MCP_ALLOW_MAIN` gate that keeps agents off the main branch by default. Installation, transport configuration, and the full tool list live in [MCP Server](./mcp-server.md). Everything below documents the underlying REST contract that the MCP tools share.

## Authentication

Agents should authenticate with user-issued API keys:

```http
Authorization: Bearer tk_...
```

API keys are created by an authenticated user through:

```http
POST /api/v1/me/api-keys
```

Creation payload:

```json
{
  "name": "docs-agent",
  "scope": "read",
  "expires_in_days": 90,
  "project_slug": "demo"
}
```

Scopes:

- `read`: read-only. Mutation endpoints reject it, while read/query operations
  remain available even when an endpoint uses `POST` for a complex query body.
  Use this for retrieval, search, and agent context loading.
- `write`: allowed on mutation endpoints, subject to the user role behind the key. Editor-only routes still require an editor or owner user.
- Owner-only security and instance-administration routes require an interactive owner session; API keys do not perform owner-only actions.

Project scope:

- `project_slug` binds the key to one `/projects/{slug}/...` namespace.
- Project-scoped keys cannot call instance-level routes such as `/api/v1/projects` or `/api/v1/users`.
- Omit `project_slug` only for trusted automation that must read or write multiple projects.

If a Bearer token is invalid, expired, or revoked, the API returns `401`. If a valid key lacks project, scope, or role permission, the API returns `403`.

## Project And Branch Context

Most agent calls require a project slug in the path:

```text
/api/v1/projects/{slug}/...
```

Plan branch context is passed as the query parameter named `branch`:

```text
?branch=<branch_id>
```

If `branch` is omitted, services resolve the project's main branch. For read-only context gathering, omitting `branch` is usually correct. For proposed edits, pass the working branch id explicitly so the agent does not mutate the live plan by accident.

Discover branches:

```http
GET /api/v1/projects/{slug}/branches
```

The response includes each branch `id`, `name`, `kind`, and `status`. Use the `id` as the `branch` query parameter on plan endpoints.

Review what a working branch changed, and undo one change of it:

```http
GET  /api/v1/projects/{slug}/branches/{branch_id}/diff
POST /api/v1/projects/{slug}/branches/{branch_id}/revert
```

The diff returns one entry per changed entity, each carrying `entity_type`, `kind` (`added` / `changed` / `removed`), `name`, `parent`, the `entity_id` it describes, and — for a changed entity — `field_changes`. A collection-valued field there additionally breaks down into `items`, keyed by the member that moved (a field name, a tag, the event an override targets).

`revert` takes the coordinates of one such entry and restores it to the branch's base state, responding with the resulting diff:

```json
{ "entity_type": "event", "name": "purchase:success", "parent": "track", "field": "field_values" }
```

Omit `field` to revert the whole entity: an addition is deleted, an edit is written back, a deletion is rebuilt with its child rows. A revert never touches main, needs an open branch and an editor role, and answers with a `409` — rather than a partial write — when the change cannot be undone unambiguously (two entities answer to the name, the parent event type is still deleted, or the branch's base snapshot predates a field the entity needs).

## Search And Retrieval Flow

Start with project search when the agent has a natural-language question or a partial event name:

```http
GET /api/v1/projects/{slug}/search?q=purchase%20success&types=event&limit=10
GET /api/v1/projects/{slug}/search?q=user_id&types=variable&limit=10&branch=<branch_id>
```

Useful query parameters:

- `q`: required search text, 1 to 500 characters.
- `types`: optional repeated filter. Supported values are `event`, `event_type`,
  `field`, `meta_field`, `variable`, `relation`, `tag`, `metric`, and
  `fact_table`.
- `include_archived`: defaults to `false`.
- `limit`: 1 to 100, defaults to 20.
- `branch`: optional branch id.

Search results include `entity_type`, `entity_id`, `title`, `subtitle`,
`description`, `snippet`, `route_path`, `score`, `confidence`, and `highlights`.
Results linked to a concrete catalog event also include `event_id`, `name`, the
compatibility `implemented` projection, and safe `variable_values` contexts with
possible values for non-sensitive fields.

Use entity-specific endpoints for full context after search:

```http
GET /api/v1/projects/{slug}/events/{event_id}?branch=<branch_id>
GET /api/v1/projects/{slug}/events?search=purchase&limit=50&branch=<branch_id>
GET /api/v1/projects/{slug}/event-types
GET /api/v1/projects/{slug}/event-types/{event_type_id}
GET /api/v1/projects/{slug}/event-types/{event_type_id}/fields
GET /api/v1/projects/{slug}/variables?limit=200&offset=0&branch=<branch_id>
GET /api/v1/projects/{slug}/variables/{variable_id}/values?branch=<branch_id>
GET /api/v1/projects/{slug}/variables/{variable_id}/event-overrides?branch=<branch_id>
GET /api/v1/projects/{slug}/variables/drifts?branch=<branch_id>
```

Event responses include:

- event identity and state: `name`, `description`, lifecycle `status`,
  `reviewed`, `owner_id`, and optional `sunset_at`;
- event type id and brief event type data;
- field values and meta values;
- tags;
- metric breakdown columns;
- variable value contexts on field values that contain real `${variable}` placeholders.

`/variables` is paginated and returns `{"items": [...], "total": <int>}`.
`offset` defaults to `0` (minimum `0`) and `limit` defaults to `200` (`1` to
`5000`); out-of-range or non-numeric values are rejected with `422`. Read `total`
to decide whether another page is needed rather than assuming one response holds
the whole catalog.

Each item in `items` includes `allowed_values`, warehouse/JSON-path `bindings`,
`excluded_from_scans`, usage summaries, `open_drift_count`, and two inline
previews that spare a per-variable follow-up call: `sample_values` (observed
values unioned across every context, de-duplicated, capped at 20) and
`event_names` (distinct names of the events the variable was observed in,
alphabetical, capped at 20 — `event_count` carries the untruncated total).

`/variables/{variable_id}/values` returns the full per-event observed contexts
for one variable: low-cardinality contexts list all observed values, while
high-cardinality contexts list bounded samples and an observed count. Reach for
it only when the inline previews are not enough. Event overrides replace the
global documented list for their event.

## Updating Events

Agents that only read should use a `read` key. Agents that edit need a `write` key backed by an editor or owner user.

Patch one event:

```http
PATCH /api/v1/projects/{slug}/events/{event_id}?branch=<branch_id>
Content-Type: application/json
Authorization: Bearer tk_...
```

Example payload for a description-only update:

```json
{
  "description": "Fired after checkout succeeds and the order id is available."
}
```

Example payload for state-only review workflow:

```json
{
  "reviewed": false,
  "status": "in_review"
}
```

`EventUpdate` fields are optional and partial:

- `name`
- `description`
- `status`
- `sunset_at`
- `owner_id`
- `reviewed`
- `metric_breakdown_columns`
- `tags`
- `field_values`
- `meta_values`

When updating `field_values` or `meta_values`, send the full replacement list
for that collection. For narrow text edits, prefer patching only `description`,
`name`, tags, or state fields. Values written through event mutations are
treated as authored and are protected from later scan overwrite.

Event create and patch return `EventMutationResponse`, which is the event plus a
`warnings` array. When a scan config governs the event type with an
`event_name_format`, manual creation derives the canonical name from the
referenced field values. Missing template values produce `422`; a differing
client-supplied name is ignored with a warning. Read the mutation response and
use its returned name/id instead of assuming your proposed name became the
identity.

Bulk state updates are available for review/archive workflows:

```http
POST /api/v1/projects/{slug}/events/bulk-update?branch=<branch_id>
```

Payload:

```json
{
  "event_ids": ["00000000-0000-0000-0000-000000000000"],
  "reviewed": true,
  "status": "ready_for_dev"
}
```

The uniform bulk patch supports `status`, `sunset_at`, `owner_id`, and
`reviewed`. Bulk delete is a separate endpoint; both are write operations.

## Search Indexing

The API reindexes the affected branch after normal plan mutations. Agents usually do not need to call reindex manually.

Manual reindex is editor-only:

```http
POST /api/v1/projects/{slug}/search/reindex?branch=<branch_id>
```

Use this after out-of-band maintenance or imports if search results look stale. When embeddings are enabled, the normal embedding refresh flow is scheduled by the backend.

## Safe Agent Defaults

- Use a project-scoped `read` key for retrieval agents.
- Use a project-scoped `write` key only for agents that are explicitly allowed to edit the tracking plan.
- Pass `branch=<branch_id>` for all write calls unless the operator intentionally wants to edit main.
- Search first, then fetch the canonical entity by id before making decisions.
- Prefer partial `PATCH` payloads over sending whole objects.
- Treat field and meta value lists as full replacements when included in an event update.
- Monitoring outputs — signals, schema/distribution/variable-value drift, and
  app-version **release regressions** — are scan-produced. Query them through
  the endpoints in `/openapi.json`; only their explicit review/action endpoints
  mutate resolution state.
- Keep `/openapi.json` in the agent's tool context and use this guide for tripl-specific auth, branch, and workflow rules.

## Interactive API reference

Every endpoint — with request/response schemas — is rendered from the live
OpenAPI spec at **[API Reference](/integrate/api)** (also linked as **API** in the
top navigation). Regenerate the underlying spec with `bin/dump-openapi.sh` after
changing the HTTP API.

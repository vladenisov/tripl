# Agent API Guide

This guide describes the recommended way for external LLM agents and CLI scripts to consume the tripl API.

## Recommendation

Use the existing FastAPI OpenAPI contract plus this guide as the primary agent integration path.

- Machine-readable contract: `GET /openapi.json`
- Interactive contract browser: `GET /docs`
- Base API prefix: `/api/v1`

Do not build a separate MCP server yet. The current API already exposes the needed read, search, and update surfaces with project scoping, branch scoping, API-key auth, and RBAC. A thin MCP server would add another contract to maintain before there is a stable set of curated agent tools. Revisit MCP when agents repeatedly need higher-level operations such as `search_events`, `get_event_context`, `update_event_description`, or `list_tracking_plan_gaps` with custom safety policy, rate limits, and audit semantics that are hard to express through raw OpenAPI.

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

- `read`: allowed on `GET` endpoints only. Use this for retrieval, search, indexing, and agent context loading.
- `write`: allowed on mutation endpoints, subject to the user role behind the key. Editor-only routes still require an editor or owner user.

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

## Search And Retrieval Flow

Start with project search when the agent has a natural-language question or a partial event name:

```http
GET /api/v1/projects/{slug}/search?q=purchase%20success&types=event&limit=10
GET /api/v1/projects/{slug}/search?q=user_id&types=variable&limit=10&branch=<branch_id>
```

Useful query parameters:

- `q`: required search text, 1 to 500 characters.
- `types`: optional repeated filter. Supported values are `event`, `event_type`, `field`, `meta_field`, `variable`, `relation`, and `tag`.
- `include_archived`: defaults to `false`.
- `limit`: 1 to 100, defaults to 20.
- `branch`: optional branch id.

Search results include `entity_type`, `entity_id`, `title`, `subtitle`, `description`, `snippet`, `route_path`, `score`, `confidence`, and `highlights`.

Use entity-specific endpoints for full context after search:

```http
GET /api/v1/projects/{slug}/events/{event_id}?branch=<branch_id>
GET /api/v1/projects/{slug}/events?search=purchase&limit=50&branch=<branch_id>
GET /api/v1/projects/{slug}/event-types
GET /api/v1/projects/{slug}/event-types/{event_type_id}
GET /api/v1/projects/{slug}/event-types/{event_type_id}/fields
GET /api/v1/projects/{slug}/variables
GET /api/v1/projects/{slug}/variables/{variable_id}/values?branch=<branch_id>
```

Event responses include:

- event identity and state: `name`, `description`, `implemented`, `reviewed`, `archived`;
- event type id and brief event type data;
- field values and meta values;
- tags;
- metric breakdown columns;
- variable value contexts on field values that contain real `${variable}` placeholders.

Variable responses include usage summary fields, and `/variables/{variable_id}/values` returns per-event value contexts. Low-cardinality contexts list all observed values; high-cardinality contexts list bounded samples and an observed count.

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
  "archived": false
}
```

`EventUpdate` fields are optional and partial:

- `name`
- `description`
- `implemented`
- `reviewed`
- `archived`
- `metric_breakdown_columns`
- `tags`
- `field_values`
- `meta_values`

When updating `field_values` or `meta_values`, send the full replacement list for that collection. For narrow text edits, prefer patching only `description`, `name`, tags, or state fields.

Bulk state updates are available for review/archive workflows:

```http
POST /api/v1/projects/{slug}/events/bulk-update?branch=<branch_id>
```

Payload:

```json
{
  "event_ids": ["00000000-0000-0000-0000-000000000000"],
  "reviewed": true,
  "archived": false
}
```

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
- Keep `/openapi.json` in the agent's tool context and use this guide for tripl-specific auth, branch, and workflow rules.

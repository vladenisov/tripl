# Agent API Guide

This guide describes the recommended way for external LLM agents and CLI scripts to consume the tripl API.

## Recommendation

Use the existing FastAPI OpenAPI contract plus this guide as the primary agent integration path.

- Machine-readable contract: `GET /openapi.json`
- Interactive contract browser: `GET /docs`
- Base API prefix: `/api/v1`

tripl now ships a first-party MCP server (`tripl-mcp`) that wraps this API in a curated toolset for MCP-capable agent runtimes — see [MCP Server](./mcp-server.md) for setup. This guide remains the raw REST contract underneath it: every MCP tool calls the endpoints described here with the same API-key auth, project fencing, and branch rules. Use the MCP server when the agent runs in an MCP-capable runtime; use raw OpenAPI plus this guide for direct HTTP integrations, scripts, and anything the curated toolset does not cover.

## Base URL

The published document carries no `servers` block, by design. A client therefore
resolves every path against the URL it fetched the spec from: an instance reached
at `https://tripl.example.com/openapi.json` is called at
`https://tripl.example.com/api/v1/...`, and the same build reached at
`http://localhost:8000` in development is called there. Nothing to configure, and
no server-side setting can point your client at a different host than the one you
already reached.

Two consequences worth knowing:

- In `/docs`, **Try it out** calls the origin the page is open on. That is a
  same-origin request, so it works regardless of the instance's CORS allow-list.
- Code generators that insist on an absolute base URL substitute their own
  placeholder (often `http://localhost`) when `servers` is absent. Set your
  origin on the generated client's configuration instead of expecting the spec to
  carry it. The same applies to the committed `backend/openapi.json` in the
  repository, which is the same document with no retrieval URL to resolve against.

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
- Owner-only security and instance-administration routes require an interactive owner session; an API key is `403` on them even when its user is an owner. The one exception is the [metrics replay](#replaying-metrics), which a `write` key backed by an owner may call.

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

Add `?include_diff_counts=true` when you need a per-branch summary rather than the branches themselves. Each working branch then also carries `ahead` (how many entities it changed against its base) and `behind_base` (whether main moved since the branch was cut), computed for the whole list from a single plan snapshot — one request instead of a `/diff` call per branch. It is opt-in because building those snapshots is the expensive part of the response; leave it off when you only need the branch rows.

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
- `types`: optional repeated filter, taking the same values a result's
  `entity_type` carries. The accepted set is enumerated on the parameter itself
  in `/openapi.json` — read it from there rather than from a list here, since it
  grows as new kinds are indexed. It spans plan content and project
  configuration alike, so scan configs and alert rules are filterable values.
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

`usage=all|used|unused` narrows the listing: `unused` returns exactly the rows a
retirement pass would take, `used` its complement. It is answered by the same
retirement predicate rather than by a "zero usage count" shortcut, so `unused`
never offers up a variable that a live event value still names. The default is
`all` and an unrecognised value is a `422`. `total` reflects the filter, so it
stays the honest count for whichever set you asked for.

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

The catalog is not append-only. Every catalog scan run retires the scan-created
variables nothing refers to any more — no `${token}` in any stored event field
or meta value, no observed context, no value drift, no per-event override — so a
variable id cached from an earlier read can be gone by the next call. A variable
your agent edited, documented, bound, or excluded from scans is never retired.
The branch-wide version of the same pass,
`POST /projects/{slug}/danger/retire-unused-variables`, is not available to
agents: it takes the strict owner gate and rejects every API key.

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

## Dry-Running a Scan

Ask what a scan config *would* create, without writing anything:

```http
POST /api/v1/projects/{slug}/scans/dry-run
```

Send either a saved config:

```json
{ "scan_config_id": "…", "sample_row_limit": 5000 }
```

or a draft, in which case `data_source_id` and `base_query` are both required and
every other field is optional (`event_type_id`, `event_type_column`,
`time_column`, `event_name_format`, `event_group_rules`, `json_value_paths`,
`cardinality_threshold`, `app_version_column`, `platform_column`,
`scan_lookback_hours`). When `scan_config_id` is present the draft fields are
ignored.

It answers `202` with a job record; poll it:

```http
GET /api/v1/projects/{slug}/scans/dry-run-jobs/{job_id}
```

Same 202-and-poll shape as `/scans/preview`, and for the same reason: a dry run
issues the same `GROUP BY ALL` a real scan issues, which can outlive a gateway
timeout. While `status` is `pending` or `running`, `result_summary` is `null`.
On `completed` it holds:

```json
{
  "window_from": "2026-08-07T12:00:00Z",
  "window_to": "2026-08-08T12:00:00Z",
  "sampled_rows": 4812,
  "sample_row_limit": 5000,
  "sample_is_complete": false,
  "breakdown_combinations": 143,
  "events": [
    {
      "name": "Purchase Completed",
      "source_name": "Purchase Completed",
      "event_type": "Purchase",
      "approx_row_count": 3120,
      "share_of_sample": 0.648,
      "status": "new",
      "grouped_by_rule": null,
      "count_confidence": "sampled"
    }
  ],
  "events_truncated": true,
  "max_events_reached": false,
  "fields": [{ "name": "props", "type": "json", "status": "new", "event_type": "Purchase" }],
  "templated_columns": [{ "column": "country", "distinct_values": 214, "threshold": 100 }],
  "reserved_columns": ["ts", "app_version"],
  "unmapped_columns": ["legacy_flag"],
  "warnings": [],
  "errors": []
}
```

An event is identified by `event_type` **and** `source_name`, never by the name
alone: a run writes one event per event type, so a grouped scan
(`event_type_column`) whose name format collapses to the same string under two
event types produces two entries here — and `status` is resolved against that
event type's plan, not against a union.

Read it honestly. `sample_is_complete: false` means more distinct events exist
than the pass examined, so report "at least N", never N. `count_confidence` is
`"exact"` only when the sample is complete *and* no lookback window applied.
`share_of_sample` is deliberately offered instead of a projected table-wide
total — do not compute one. `errors` carries event-name-format failures verbatim
and does **not** fail the job; a non-empty `errors` means the config would fail
every real run.

Both routes are **owner-only** and session-only (an API key cannot reach them),
because the draft's `base_query` is free-text SQL run against a stored warehouse
credential. This is the same gate `/scans/preview` carries.

## Replaying Metrics

Recollect an existing scan config's metrics over a window you name:

```http
POST /api/v1/projects/{slug}/scans/{scan_id}/metrics/replay
```

```json
{
  "time_from": "2026-04-01T00:00:00Z",
  "time_to": "2026-04-02T00:00:00Z"
}
```

It answers `201` with the queued `ScanJob`; poll
`GET /api/v1/projects/{slug}/scans/{scan_id}/jobs` for its status. Use it to
backfill a window the scheduler missed or to recompute after a metric definition
changed. The config must already carry `time_column` and `interval`, otherwise
the call is `400`.

This is the **only** owner-gated route an API key can reach, and the gate is
strict about all three of its parts: the key's scope must be `write`, the user
behind it must have the `owner` role, and a project-bound key still only reaches
its own project. An editor's `write` key gets `403 Owner role required`; a `read`
key gets `403 API key has read-only scope`.

It is reachable because a replay only re-runs SQL an owner already authored
through the browser-only scan routes — it cannot introduce a new query. Creating
or editing a scan config, like connecting a data source, stays an interactive
owner session.

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

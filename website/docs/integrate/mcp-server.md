# MCP Server

tripl ships a first-party [Model Context Protocol](https://modelcontextprotocol.io)
server, **`tripl-mcp`**, that exposes a curated slice of the
[Agent API](./agent-api-guide.md) as typed MCP tools. It lives in `mcp-server/`
(Python module `tripl_mcp`) and is a **standalone client of a running tripl
instance** — it holds no database access and no privileged backdoor. Every tool
call becomes a normal `/api/v1` request authenticated with a tripl API key.

Because of that, the MCP server inherits the API-key security model wholesale:

- **Scope** — a `tk_r_` key makes every write tool fail; a `tk_w_` key is
  required for mutations and is still subject to the user role behind it.
- **Project fencing** — a project-scoped key confines all tools to that one
  `/projects/{slug}/...` namespace.
- **Roles** — editor-only routes still require an editor or owner user behind
  the key.
- **Owner and instance-administration operations are impossible by design** —
  those routes reject API keys entirely, so no MCP tool can reach them no
  matter how the server is configured.

## Configuration

The server is configured through environment variables:

| Variable | Required | Meaning |
|----------|----------|---------|
| `TRIPL_BASE_URL` | yes | Base URL of the tripl instance, e.g. `https://tripl.example.com` |
| `TRIPL_API_KEY` | stdio mode | API key (`tk_r_...` or `tk_w_...`) used for all requests |
| `TRIPL_MCP_ALLOW_MAIN` | no | Set to `1` to let plan-mutating tools run without a `branch_id` (i.e. write to the main branch). Off by default — leave it off. |

Give a discovery-only agent a `tk_r_` key and prefer project-scoped keys, the
same [safe defaults](./agent-api-guide.md#safe-agent-defaults) as for raw REST.

:::tip Same two variables as the CLI
`TRIPL_BASE_URL` and `TRIPL_API_KEY` are read identically by the
[operator CLI](../run/cli.md), and the two tools share one HTTP client (the MCP
server imports it from the `tripl` distribution in `cli/`). A shell configured
for one is configured for the other, so `tripl doctor` is the quickest way to
prove the URL and key an MCP client is about to use actually work — including
whether the key is fenced to a single project.
:::

## Running over stdio

Stdio is the default transport: the MCP client launches `tripl-mcp` as a child
process and the key comes from the environment.

:::note Which install paths work
All of them. `tripl-mcp` is on PyPI, and so is the `tripl` distribution it takes
its HTTP client from, so `uvx tripl-mcp` and the `uvx --from git+…` form below
each resolve from the index with no checkout involved.

They are not the same version. PyPI has **0.1.0**, which predates the client
extraction and exposes 17 tools; the copy in the repository has 18 — `get_scan`
landed after that release. Install from git to get the newer one.

The **container** image is published either way —
`ghcr.io/vladenisov/tripl-mcp`, built alongside the app image on every release —
and is what `docker compose --profile mcp up` pulls.
:::

### Claude Code

```bash
claude mcp add tripl \
  -e TRIPL_BASE_URL=https://tripl.example.com \
  -e TRIPL_API_KEY=tk_r_... \
  -- uvx tripl-mcp
```

Replace `uvx tripl-mcp` with
`uvx --from 'git+https://github.com/vladenisov/tripl.git#subdirectory=mcp-server' tripl-mcp`
to run the repository copy rather than the release.

Or check a `.mcp.json` into the project (put the key itself in your shell
environment, not in the file):

```json
{
  "mcpServers": {
    "tripl": {
      "command": "uvx",
      "args": ["tripl-mcp"],
      "env": {
        "TRIPL_BASE_URL": "https://tripl.example.com",
        "TRIPL_API_KEY": "${TRIPL_API_KEY}"
      }
    }
  }
}
```

### Claude Desktop

Add the same block under `mcpServers` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tripl": {
      "command": "uvx",
      "args": ["tripl-mcp"],
      "env": {
        "TRIPL_BASE_URL": "https://tripl.example.com",
        "TRIPL_API_KEY": "tk_r_..."
      }
    }
  }
}
```

Running from a source checkout instead of an installed package:

```bash
uv run --project /path/to/tripl/mcp-server tripl-mcp --transport stdio
```

## Running over streamable HTTP

For shared or containerized deployments, start the server once and let many
clients connect:

```bash
tripl-mcp --transport streamable-http --port 8765
```

In this mode the server does **not** use a stored key. Each client request must
carry its own `Authorization: Bearer tk_...` header, which the server passes
through to the tripl API for that request only — credentials are never stored
server-side. Different agents can therefore share one MCP server while keeping
distinct keys, scopes, and project fences.

The dev compose stack includes an optional, profile-gated `mcp` service that
builds `mcp-server/` and points it at the `api` container. It never starts by
default:

```bash
docker compose -f compose.dev.yaml --profile mcp up
```

## Toolset

The v1 toolset is deliberately curated rather than a 1:1 mirror of the OpenAPI
contract. Read tools carry the MCP `readOnlyHint` annotation so runtimes can
treat them as safe to auto-approve.

### Read tools

| Tool | Arguments | Backed by |
|------|-----------|-----------|
| `search_plan` | `slug, q, types?, limit?, branch_id?` | `GET /projects/{slug}/search` |
| `list_events` | `slug, search?, status?, tag?, meta_value?, event_type_id?, silent_since_days?, offset?, limit?, branch_id?` | `GET /projects/{slug}/events` |
| `get_event` | `slug, event_id, branch_id?` | `GET /projects/{slug}/events/{event_id}` |
| `list_event_types` | `slug` | `GET /projects/{slug}/event-types` |
| `get_event_type_fields` | `slug, event_type_id` | Event type + its field definitions, merged |
| `list_variables` | `slug, branch_id?` | `GET /projects/{slug}/variables` |
| `get_variable_values` | `slug, variable_id, branch_id?` | Variable values + event overrides |
| `list_branches` | `slug` | `GET /projects/{slug}/branches` |
| `get_branch_diff` | `slug, branch_id` | `GET /projects/{slug}/branches/{branch_id}/diff` |
| `list_scans` | `slug` | `GET /projects/{slug}/scans` — **trimmed**: identity, schedule and a derived `dispatchable` flag, without `base_query` and the tuning knobs |
| `get_scan` | `slug, scan_id` | `GET /projects/{slug}/scans/{scan_id}` — one config in full, including everything `list_scans` trims |
| `get_scan_status` | `slug, scan_id, job_id?` | Scan job listing, or one job when `job_id` is given |
| `monitors_summary` | `slug` | Monitors summary + top anomaly signals, combined |
| `reconciliation_status` | `slug` | Reconciliation coverage + dead/shadow event counts |
| `list_projects` | — | `GET /api/v1/projects` |

:::warning `list_scans` changed shape after 0.1.0
It used to return the whole `ScanConfigResponse` for every config — 30-odd
fields including the raw `base_query` SQL and every tuning knob — which is a
large payload to spend an agent's context on when the question is usually "which
scans exist, and are they scheduled". It now returns a trimmed projection plus a
derived `dispatchable` flag.

Nothing became unreachable: `get_scan` returns one config in full. If your agent
read a field off the listing, point it at `get_scan` for the config it actually
cares about.
:::

:::note
`list_projects` is instance-level: with a **project-scoped** key it returns
`403` by design. That is expected behavior, not a broken setup — use the
project the key is fenced to.
:::

:::note
`list_variables` passes the API response straight through, so it returns the
paged envelope `{"items": [...], "total": <int>}` — the first 200 variables of
the project. Compare `total` against `len(items)` before concluding a variable
does not exist; on a large catalog, fall back to `search_plan` with
`types=variable` to find a specific one.
:::

### Write tools

Every write tool states in its description that it needs a `tk_w_` key; with a
`tk_r_` key these calls fail with `403`.

| Tool | Arguments | Backed by |
|------|-----------|-----------|
| `create_event` | `slug, branch_id, event_type_id, name, description?, status?, tags?, field_values?, meta_values?` | `POST /projects/{slug}/events` |
| `update_event` | `slug, event_id, branch_id, patch{...}` | `PATCH /projects/{slug}/events/{event_id}` |
| `trigger_scan` | `slug, scan_id` | `POST /projects/{slug}/scans/{scan_id}/run` |

:::warning
In `update_event`, `field_values` and `meta_values` are **full-list
replacements**, exactly as in the REST contract: sending a partial list drops
the values you omitted. The tool description repeats this warning to the
agent. For narrow edits, patch only `description`, `name`, tags, or state
fields.
:::

### Branch safety

The Agent API guide's rule — never mutate main by accident — is encoded at the
tool layer: the plan-mutating tools (`create_event`, `update_event`) **require**
`branch_id`. Calls without a branch are rejected by the server itself unless
the operator explicitly sets `TRIPL_MCP_ALLOW_MAIN=1` in the server
environment. Discover branch ids with `list_branches` and review pending work
with `get_branch_diff`.

## Deliberately not exposed in v1

The following surfaces exist in the REST API but are intentionally left out of
the MCP toolset:

- **Branch merge, transition, and revert** — landing a branch on main is a
  human review workflow. Agents propose changes on a branch; a person reviews
  the diff and merges in the app.
- **Reconciliation accept/dismiss** — accepting a shadow event into the plan or
  archiving dead events is a resolution decision. `reconciliation_status`
  surfaces the findings; a human acts on them.
- **SSE streaming endpoints** — MCP tool calls are request/response; streams do
  not map onto them usefully.
- **Multipart photo upload** — binary upload flows stay in the app and the raw
  REST API.

If your integration needs any of these, call the REST API directly per the
[Agent API guide](./agent-api-guide.md) — with the understanding that you are
then outside the curated safety rails.

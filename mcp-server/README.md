# tripl-mcp

Standalone [MCP](https://modelcontextprotocol.io) server exposing a curated,
agent-safe toolset over a **running tripl instance**. It is a pure HTTP client
of the tripl REST API (`/api/v1`) — it imports no backend code and is not
mounted into the FastAPI app.

- 17 curated tools (14 read, 3 write): plan search, event read/write, event
  types & fields, variables, branches & diffs, scans, monitors, reconciliation,
  projects.
- Read tools carry `readOnlyHint`; write tools require a `tk_w_` API key.
- Plan-mutating tools **require `branch_id`** so an agent never edits the live
  main plan by accident. Operators can override with `TRIPL_MCP_ALLOW_MAIN=1`.
- Branch merge/revert/transition, SSE streams, and photo upload are
  intentionally not exposed in v1.

## stdio (Claude Code / Claude Desktop)

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

From a checkout instead of a published package:

```json
{
  "command": "uv",
  "args": ["run", "--project", "/path/to/tripl/mcp-server", "tripl-mcp"]
}
```

Create API keys in the tripl app under **Account → API keys**. Use a
project-scoped `tk_r_` key for read-only agents; reserve `tk_w_` keys for
agents explicitly allowed to edit the plan.

## streamable-http (shared server)

```bash
TRIPL_BASE_URL=https://tripl.example.com tripl-mcp --transport streamable-http --port 8765
```

In this mode the server holds **no credentials**. Every incoming MCP request
must carry `Authorization: Bearer tk_...`; the header is forwarded verbatim to
the tripl API and never stored. Requests without it get a clear tool error.

## Environment

| Variable | Meaning |
|----------|---------|
| `TRIPL_BASE_URL` | Base URL of the tripl instance (required) |
| `TRIPL_API_KEY` | API key for stdio mode (required for stdio) |
| `TRIPL_MCP_ALLOW_MAIN` | Set to `1` to allow plan writes without `branch_id` (edits main) |

## Development

```bash
cd mcp-server
uv sync
uv run pytest -q
uv run ruff check .
```

## Docs

Full agent workflow guidance lives in the website docs:
`website/docs/integrate/agent-api-guide.md` and
`website/docs/use-cases/llm-agent.md`.

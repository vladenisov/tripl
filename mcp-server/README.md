# tripl-mcp

Standalone [MCP](https://modelcontextprotocol.io) server exposing a curated,
agent-safe toolset over a **running tripl instance**. It is a pure HTTP client
of the tripl REST API (`/api/v1`) — it imports no backend code and is not
mounted into the FastAPI app.

- 18 curated tools (15 read, 3 write): plan search, event read/write, event
  types & fields, variables, branches & diffs, scans, monitors, reconciliation,
  projects.
- Read tools carry `readOnlyHint`; write tools require a `tk_w_` API key.
- Plan-mutating tools **require `branch_id`** so an agent never edits the live
  main plan by accident. Operators can override with `TRIPL_MCP_ALLOW_MAIN=1`.
- Branch merge/revert/transition, SSE streams, and photo upload are
  intentionally not exposed in v1.
- The HTTP client is **not in this package**. It lives in the `tripl`
  distribution (`../cli`) and is imported from there, so the CLI and this server
  share one implementation rather than two that drift (tripl-ey6j.1).

## stdio (Claude Code / Claude Desktop)

Both `tripl-mcp` and the `tripl` distribution it takes its HTTP client from are
on PyPI, so every form below resolves from the index — including the
`git+…#subdirectory=mcp-server` one, which no longer needs the sibling `cli/`
directory to find `tripl`.

> **The published release trails this repository.** PyPI has 0.1.0, uploaded
> before the client extraction (tripl-ey6j.1). It exposes 17 of the 18 tools
> listed above — `get_scan` landed after it. Install from git for the version
> this README describes.

From PyPI — the released version:

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

From git — no clone needed, and the way to run what is in this repository:

```json
{
  "mcpServers": {
    "tripl": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/vladenisov/tripl.git#subdirectory=mcp-server",
        "tripl-mcp"
      ],
      "env": {
        "TRIPL_BASE_URL": "https://tripl.example.com",
        "TRIPL_API_KEY": "tk_r_..."
      }
    }
  }
}
```

From a local checkout:

```json
{
  "command": "uv",
  "args": ["run", "--project", "/path/to/tripl/mcp-server", "tripl-mcp"]
}
```

Create API keys in the tripl app under **Settings → API keys**. Use a
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
uv run --group dev pytest -q
uv run --group dev ruff check
uv run --group dev ruff format --check
uv run --group dev mypy src
```

`uv` resolves `tripl` from `../cli` via `[tool.uv.sources]`, so an edit there is
picked up with no install step — and must be, because `tripl_cli.client` is this
server's transport. **Run both suites after touching it**, which is what
`ci.yml`'s `cli` and `mcp` jobs do.

The container image builds from the **repository root**, not this directory,
for the same reason:

```bash
docker build -f mcp-server/Dockerfile .   # `docker build ./mcp-server` no longer works
```

## Docs

Full agent workflow guidance lives in the website docs:
`website/docs/integrate/agent-api-guide.md` and
`website/docs/use-cases/llm-agent.md`.

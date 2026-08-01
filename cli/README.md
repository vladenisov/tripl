# tripl (CLI)

Operator CLI for a **running tripl instance** — diagnostics, health and live
monitoring. Like [`tripl-mcp`](../mcp-server), it is a pure HTTP client of the
tripl REST API (`/api/v1`): it imports no backend code and never touches the
database.

The distribution is **`tripl`**, the console script is **`tripl`**, and the
import package is **`tripl_cli`**. The last one is deliberate: the service's own
source package is `backend/src/tripl/`, so a distribution that installed an
importable `tripl` would shadow it in any environment holding both — a
contributor's backend venv, for one.

This package also owns the **shared async REST client** (`tripl_cli.client`).
`tripl-mcp` depends on `tripl` and imports it from here rather than carrying a
copy; there is exactly one `TriplClient` in the repo.

## Install

> **Not on PyPI.** There is no `tripl` package on the index yet, so a bare
> `uvx tripl` will not resolve. Install from git or from a checkout.

```bash
uvx --from "git+https://github.com/vladenisov/tripl.git#subdirectory=cli" tripl --version
```

From a local checkout:

```bash
uv run --project /path/to/tripl/cli tripl --version
```

## Configuration

Resolved **per field**, highest precedence first:

1. command-line flag — `--url` / `--base-url`, `--api-key`
2. environment — `TRIPL_BASE_URL`, `TRIPL_API_KEY`
3. config file — `base_url`, `api_key`

Per field, not per source: `--url https://staging` with the key still coming
from the config file works.

| Variable | Meaning |
|----------|---------|
| `TRIPL_BASE_URL` | Base URL of the tripl instance (the same variable `tripl-mcp` reads) |
| `TRIPL_API_KEY` | API key — `tk_r_` for read-only, `tk_w_` for write |
| `XDG_CONFIG_HOME` | Overrides the config file location on every platform |

There is deliberately **no `TRIPL_URL`**: two supported spellings for one
setting is how configuration drifts. If it is set and `TRIPL_BASE_URL` is not,
the error says so by name.

### Config file

| Platform | Path |
|----------|------|
| Linux / BSD / macOS | `$XDG_CONFIG_HOME/tripl/config.toml`, else `~/.config/tripl/config.toml` |
| Windows | `%APPDATA%\tripl\config.toml`, else the `~/.config` fallback |

```toml
# ~/.config/tripl/config.toml
base_url = "https://tripl.example.com"
api_key  = "tk_r_..."
```

TOML because `tomllib` is stdlib on the supported Pythons, so the file format
costs **zero runtime dependencies** — which matters, because `tripl-mcp`
inherits every dependency of this package. Unknown keys and unknown tables are
ignored, so an older CLI keeps working against a file written by a newer one.

`--config PATH` overrides discovery. A missing *default* file is fine; a missing
`--config` path is an error. On POSIX, a config file that holds an `api_key` and
is readable by other users gets one warning on stderr — `chmod 600` it.

Create API keys in the tripl app under **Account → API keys**.

## Development

```bash
cd cli
uv sync
uv run --group dev pytest -q
uv run --group dev ruff check
uv run --group dev ruff format --check
uv run --group dev mypy src
```

`mcp-server` resolves this package from `../cli` via `[tool.uv.sources]` while
it is unpublished, so a change here is picked up by `cd mcp-server && uv sync`
without any install step. Run **both** suites after touching `client.py`.

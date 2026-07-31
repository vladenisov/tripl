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

Python 3.12+; the only runtime dependency is `httpx`.

> **Not on PyPI.** There is no `tripl` package on the index yet, so a bare
> `uvx tripl` will not resolve. Install from git or from a checkout.

From a local checkout — the form verified against this revision:

```bash
uv run --project /path/to/tripl/cli tripl --version
# tripl 0.1.0
```

From git without a checkout. This package depends only on `httpx`, so it is
expected to resolve (unlike `tripl-mcp`, which needs the unpublished `tripl`),
but it is not exercised by CI:

```bash
uvx --from "git+https://github.com/vladenisov/tripl.git#subdirectory=cli" tripl --version
```

## Commands

Both commands are **read-only** — a `tk_r_` key is enough — and both take
`--json`, `--project SLUG` (repeatable) and `--include-demo`.

```bash
tripl doctor              # check the instance and report what is broken
tripl doctor --json       # one JSON document on stdout, human lines on stderr
tripl doctor --strict     # exit 3 on warnings too (never on skipped checks)
tripl status              # projects, events, scans, signals, coverage
```

`doctor` runs six checks, always in this order and always exactly once each:
`connectivity`, `auth`, `projects`, `data_sources`, `scans`, `drifts`.
Per-project results are findings *inside* a check, so a consumer selects by
`id` and gets one row.

```text
tripl doctor — https://tripl.example.com (from $TRIPL_BASE_URL)

PASS  connectivity  Reached https://tripl.example.com (from $TRIPL_BASE_URL); the API and its database are up.
PASS  auth          The API key authenticates as an instance-wide key (role: owner).
PASS  projects      1 project selected.
FAIL  data_sources  1 referenced data source(s); see below.
      - fail: data_source_probe_failed 'warehouse-prod'
        Data source 'warehouse-prod' (used by scan config 'prod events', 'checkout funnel') last failed its connection test at 2026-07-29T19:08:09Z: 'FATAL: password authentication failed for user "tripl"'.
FAIL  scans         1 of 2 scheduled scan configs is not collecting.
      - fail: scan_config_failing [prod] 'prod events'
        Scan config 'prod events' (1h) has failed 5 consecutive scheduled runs since 2026-07-31T14:08:09Z. Last error: 'Scan failed due to an internal error.' — that is the backend's generic fallback, not the real cause, so the cause is in the worker log for job job-0.
      - warn: scan_backoff_active [prod] 'prod events'
        The scheduler has deliberately deferred the next attempt to not before 2026-07-31T22:08:09Z (about 4h after the last failure): 3 or more consecutive failures trigger a backoff, so the worker is not stuck.
WARN  drifts        1 event type(s) examined; see below.
      - warn: schema_field_deleted_by_accept [prod] 'app.screen_view'
        Field 'user_id' was deleted from event type 'app.screen_view' on 2026-07-26T19:08:09Z when a missing_field drift was accepted (by user uid-7).
      - warn: schema_drift_open [prod]
        Project 'prod' has 1 untriaged schema drifts (oldest detected 2026-07-28T19:08:09Z): app.screen_view.cart_value (type_changed)

6 checks: 3 pass, 1 warn, 2 fail. Exit 3.
Re-run with --json for the machine-readable form of every finding.
```

Output is ASCII only and byte-identical whether stdout is a TTY or a pipe, so
`tripl doctor | tee incident.log` and the terminal view are the same artifact.
Two behaviours are worth knowing before you read a report: a **non-200 is never
treated as an empty list** (it becomes `endpoint_unexpected_status`, because a
404 read as "no drifts" is the class of mistake this tool exists to remove), and
the scheduler's **retry backoff is reported as expected behaviour** rather than
as a hang.

| Exit | Meaning |
|------|---------|
| 0 | Every check passed, or only warned and `--strict` was not given. `status`, whenever it completed. |
| 1 | The tool itself broke (doctor turns every API failure into a finding), or `status` could not complete a request — unreachable, or the API refused it. |
| 2 | Usage or configuration error. Resolved before any socket opens, so **no JSON is emitted**. |
| 3 | `doctor` only: at least one check failed, or `--strict` and at least one warning. |
| 130 | Interrupted (SIGINT). |

An unreachable instance therefore exits **3**, not 1 — that is what makes exit 1
a meaningful bug signal.

Within one `schema_version`, key names are never removed or retyped, and check
`id`s, finding `code`s and `status`/`severity` values are never renamed or
repurposed. New keys, ids and codes may appear in any release. `title`,
`summary` and `message` are prose. **Assert on `code` and `evidence`, never on
prose.**

Full reference — every check, every finding code with its `evidence` keys, and
what an operator should actually do about each one:
<https://vladenisov.github.io/tripl/run/cli> (source:
[`website/docs/run/cli.md`](../website/docs/run/cli.md)).

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

Create API keys in the tripl app under **Settings → API keys**.

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

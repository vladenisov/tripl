# Contributing to tripl

Thanks for working on **tripl** — an analytics tracking-plan and data-quality
monitoring service. This guide covers how to get a local environment running,
the day-to-day backend and frontend workflows, how database migrations work,
where new code belongs, and the conventions we expect on pull requests.

The agent-facing navigation map (domain model, API map, async pipeline map,
"where to look first") lives in
[AGENTS.md](https://github.com/vladenisov/tripl/blob/main/AGENTS.md). This file
is the human contributor guide. The repo's
[CLAUDE.md](https://github.com/vladenisov/tripl/blob/main/CLAUDE.md) links here
for build and test commands instead of duplicating them, so keep the command
sections below accurate.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | latest | Backend Python env, deps, and task runner |
| Python | 3.14 (pinned in `backend/.python-version`) | Backend runtime — `uv` will fetch it for you |
| Node.js | `>=26 <27` (pinned in `frontend/.node-version`) | Frontend build/test |
| [pnpm](https://pnpm.io/) | `11.6.0` (pinned via `packageManager`) | Frontend deps and scripts |
| Docker + Compose v2 | recent | Local dev stack |

The repo pins the package managers, so use **`uv`** for the backend and
**`pnpm`** for the frontend. Do **not** use `pip`, `poetry`, `npm`, or `yarn` —
they bypass `uv.lock` / `pnpm-lock.yaml` and CI will diverge from your machine.

Enable the pinned pnpm with Corepack (ships with Node):

```bash
corepack enable
corepack prepare pnpm@11.6.0 --activate
```

:::note ClickHouse / BigQuery / Postgres warehouses are external
tripl reads from *external* analytics warehouses (ClickHouse, BigQuery, and the
Postgres warehouse adapter). Compose does **not** start a warehouse for you. The
PostgreSQL container in the dev stack is tripl's own system-of-record database,
not a scan target. Scans and data-source connection tests need a reachable
external warehouse.
:::

## Local Development with Docker Compose

The dev stack builds from source, runs as root, and hot-reloads via Docker
Compose watch. It is defined in
[compose.dev.yaml](https://github.com/vladenisov/tripl/blob/main/compose.dev.yaml)
(this is **not** the deploy stack — production runs the published single-
container image via `compose.yaml`).

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --watch
```

Services started: `postgres` (pgvector, pg18), `rabbitmq`, `redis`, `api`,
`celery-worker`, `celery-beat`, and `frontend`.

| Surface | URL |
|---|---|
| Frontend (Vite dev server) | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |
| API health | http://localhost:8000/health |
| RabbitMQ management | http://localhost:15672 |

Useful facts about the dev stack:

- The `api` service runs `alembic upgrade head` before launching `uvicorn`, so
  the schema is migrated on startup.
- `DEBUG=true` is set for the dev `api`, which relaxes the production-readiness
  checks (see [Common dev failures](#common-dev-failures)).
- `celery-beat` polls for due metrics every 5 minutes (the `check-metrics-due`
  task; scans themselves fire on interval boundaries) and also schedules the
  daily/weekly maintenance and digest jobs. The actual scan/metrics/alert work
  runs on `celery-worker`.
- Watch uses file polling inside containers (`WATCHFILES_FORCE_POLLING` on the
  backend, `CHOKIDAR_USEPOLLING` on the frontend) so edits under `backend/src`
  and `frontend/src` sync automatically. Changing a lockfile, `pyproject.toml`,
  or a `Dockerfile` triggers a rebuild.

You can validate Compose wiring without bringing the stack up:

```bash
docker compose -f compose.dev.yaml config
```

## Backend Workflow

The backend lives in [`backend/`](https://github.com/vladenisov/tripl/blob/main/backend).
Run these from inside that directory.

```bash
cd backend
uv sync --extra dev                           # install deps from uv.lock, incl. dev extras
uv run pytest                                 # full test suite
uv run pytest src/tripl/tests/test_events.py -v   # single test file
uv run ruff check                             # lint
uv run ruff format --check                    # formatting check (drop --check to apply)
uv run mypy                                   # strict type check
```

`--extra dev` is not optional: uv does not install optional-dependency extras by
default, so a bare `uv sync` gives you the app's runtime deps and none of the
tooling above. `make install` does this for you, and installs the git hooks.

### Formatting is enforced, not suggested

`ruff format` runs automatically on staged backend files through the git
pre-commit hook. Point git at the versioned hooks once per clone:

```bash
make install-hooks   # bd hooks install --beads
```

The hook rewrites the files in place and then fails the commit, so you can see
what changed and `git add` it — formatting is applied for you, but nothing is
committed behind your back. CI runs `ruff format --check src/` too, so a
`--no-verify` commit still gets caught at the PR.

The hook itself lives in [`.beads/hooks/pre-commit`](.beads/hooks/pre-commit),
below beads' own section markers (beads preserves anything outside them). It is a
versioned file, so `make install-hooks` is the only setup step — it just points
`core.hooksPath` at `.beads/hooks`.

That path is stored in `.git/config` as an absolute, machine-specific value, so a
clone or a moved working copy can end up pointing at a directory that no longer
exists. When that happens **no hook runs at all** — beads' own sync included, and
silently. `bd hooks list` tells you; `make install-hooks` repairs it.

Notes:

- Tests run against an in-memory SQLite database (`aiosqlite`), so `uv run
  pytest` needs **no** Postgres, RabbitMQ, or warehouse running. `pytest-asyncio`
  is in `auto` mode and the loop scope is session-wide (see
  `[tool.pytest.ini_options]` in `backend/pyproject.toml`).
- Ruff is configured for `target-version = py314`, `line-length = 100`, rule set
  `E, F, I, UP, B, SIM`, and excludes generated migrations under
  `alembic/versions`.
- mypy runs in `strict` mode over `src/tripl` and excludes the test tree.
- Run the checks for the side you touched before opening a PR.

### Search relevance harness (needs a real PostgreSQL)

Because the suite runs on SQLite, search keeps a Python fallback and the
**production ranking SQL** — `ts_rank_cd`, the trigram/boost tiers,
`merge_results`, and the `tripl_search` text-search configuration — is executed by
nothing else in the repo. `src/tripl/tests/relevance/` ranks a fixed, readable
corpus with that real SQL on a real PostgreSQL (tripl-338u). Without a server it
SKIPS, so a plain `uv run pytest` is unaffected; CI runs it as its own job with
`TRIPL_RELEVANCE_REQUIRED=1`, which turns that skip into a failure.

```bash
docker run --rm -d --name tripl-relevance -p 55442:5432 \
  -e POSTGRES_USER=tripl -e POSTGRES_PASSWORD=tripl -e POSTGRES_DB=tripl_relevance \
  pgvector/pgvector:0.8.2-pg18-trixie

cd backend
TRIPL_RELEVANCE_PG_PORT=55442 \
  uv run pytest -q -m relevance src/tripl/tests/relevance
```

The pgvector image is required, not stock postgres: the harness migrates the
database to head with the real revision chain (so it tests the shipped
`tripl_search` configuration, not a hand-rolled copy of it), and one revision
creates the `vector` extension. It drops and recreates schema `public` on every
run, which is why the database name defaults to `tripl_relevance` and never
`tripl`.

Every case in `relevance/cases.py` passes, alongside a self-test that proves the
harness really is on PostgreSQL with the semantic leg off, and
`relevance/test_semantic_floor.py`, which covers the semantic leg's cosine floor
and confidence using hand-built vectors (no provider, no API key). Read the count
off the file rather than from here — this sentence has already been wrong once.

`RelevanceCase` carries an `xfail_ordering` field and `test_search_relevance.py`
turns it into `xfail(strict=True)`, so the workflow for a measured fault is:
write the case down with the marker first, fix it second, delete the marker as
the proof. **That has now happened once, end to end** —
`russian-phrase-finds-the-event-it-describes` was written with the marker, and
tripl-9t2s deleted it by adding the coverage term. Strict is what makes the last
step honest: an xfail that starts passing FAILS, so a marker cannot outlive the
fault it describes.

Only ORDERING may ever be xfailed, never retrieval — a ranking nuance must not
excuse a document vanishing from the results, which is why the two are separate
tests and only one of them reads the field.

Do not weaken an assertion to make a case pass.

**Which guarantees are PostgreSQL-only.** The rest of the backend suite runs on
in-memory SQLite against `_search_query.fallback_score`, a tier ladder with no
`ts_rank_cd`, no trigram similarity and **no stemmer**. So the SQLite suite does
**not** cover ranking: everything tripl-nh5s fixed (stemming, and the 3.25 boost
tier that depends on it — the `purchases` / `уловы` / `spots` / `экран спота`
cases) holds only on PostgreSQL and only this job executes it. What does hold on
both dialects is anything implemented at document-build time (tripl-gbxj's
keyword change, tripl-h9x2's spaced aliases and its query fold) and the rule that
only an exact title/keywords match may be reported at confidence 1.0. The
`fallback_score` docstring carries the same list next to the code.

## Frontend Workflow

The frontend lives in [`frontend/`](https://github.com/vladenisov/tripl/blob/main/frontend)
(React 19 + TypeScript + Vite, Tailwind 4, Radix UI, TanStack Query, Recharts).

```bash
cd frontend
pnpm install        # install deps from pnpm-lock.yaml
pnpm dev            # Vite dev server on :5173
pnpm test           # vitest run
pnpm lint           # eslint . --max-warnings 0  (zero-warning policy)
pnpm build          # tsc -b && vite build  (full type check + production build)
```

The typed API client is generated from the backend's OpenAPI schema. If you
change request/response contracts, regenerate it:

```bash
pnpm gen:api        # regenerates src/types/api.gen.ts from ../backend/openapi.json
```

`pnpm lint` enforces a zero-warning policy and `pnpm build` runs a full
type-check, so both must be clean before you push frontend changes.

## Database Migrations (Alembic)

Migrations live in `backend/alembic/`. The async `env.py` wires Alembic to
`tripl.config.settings.database_url` and `tripl.models.Base.metadata`, so a
migration run needs a reachable Postgres (`DATABASE_URL`) and the models
importable.

Typical dev loop after changing SQLAlchemy models:

```bash
cd backend
uv run alembic revision --autogenerate -m "describe the change"   # generate
# review the generated file under alembic/versions/, then:
uv run alembic upgrade head                                       # apply
```

:::tip alembic shebang fallback
If `uv run alembic` fails with a broken shebang (e.g. after a directory rename
left `.venv/bin/alembic` pointing at a stale path), call the module directly:

```bash
uv run python -m alembic revision --autogenerate -m "msg"
uv run python -m alembic upgrade head
```
:::

Always review autogenerated migrations — Alembic does not catch everything
(e.g. enum changes, server defaults, data backfills). The suite includes
`test_alembic_revisions.py`, which guards migration integrity, so run
`uv run pytest` after adding a revision.

## Architecture: where new code belongs

tripl is one codebase with two runtimes sharing a common core.

### Shared core kernel

Provider-agnostic, framework-agnostic logic lives in
[`backend/src/tripl/core/`](https://github.com/vladenisov/tripl/blob/main/backend/src/tripl/core):

- `core/adapters/` — warehouse connectors (`clickhouse.py`, `bigquery.py`,
  `postgres.py`) behind a shared `base.py` interface and a `registry.py`.
- `core/analyzers/` — scan and quality logic: cardinality analysis, event/
  variable generation, anomaly detection, distribution drift, release
  regression, and preview.
- `core/intervals.py` — shared time-bucket helpers.

The core kernel exists so both the API and the worker call the **same** scan,
metrics, and anomaly logic. Put analytics logic here (not in a router or a
Celery task) so it stays reusable and unit-testable in isolation. Add a new
warehouse by implementing the adapter `base` interface and registering it in
`core/adapters/registry.py` — extend the registry rather than branching on
warehouse type elsewhere.

### API runtime (async) vs worker runtime (sync)

- **API** (`api/`, `services/`, `models/`, `schemas/`, `main.py`) runs on
  FastAPI with **async** SQLAlchemy + `asyncpg` via `DATABASE_URL`. Keep request
  paths async — do not introduce blocking DB calls into a router.
- **Worker** (`worker/`) runs Celery tasks using **sync** SQLAlchemy + `psycopg`
  via `SYNC_DATABASE_URL`. Sync DB access is expected and acceptable inside
  worker tasks.

When adding an HTTP feature:

1. Add a **thin** router in `api/v1/<area>.py` — parse/validate, call a service,
   return a schema. No business rules here.
2. Put business logic in `services/<area>_service.py`.
3. Add SQLAlchemy models in `models/` and Pydantic request/response models in
   `schemas/`. Update both together when a payload changes, and regenerate the
   frontend types (`pnpm gen:api`) so `frontend/src/types` stays in sync.

When adding heavy, retryable, or scheduled work:

1. Add a Celery entrypoint under `worker/tasks/` (scan, metrics, alerts,
   maintenance, search).
2. Put the actual analysis in `core/analyzers/` and any warehouse access in a
   `core/adapters/` adapter.
3. Prefer extending an existing task/adapter/analyzer flow over adding a
   parallel implementation.

Operational invariants to preserve unless you are intentionally changing them:
RabbitMQ is the Celery broker; PostgreSQL is the system of record for catalog,
metrics, anomalies, and alert deliveries; warehouses are read-only external data
sources; and API, worker, and beat must all stay runnable together via Compose.

## Common dev failures

- **Scan / connection test fails with no warehouse reachable.** Warehouses are
  external and not started by Compose. Point a data source at a real ClickHouse,
  BigQuery, or Postgres warehouse you control.
- **App refuses to start in non-debug mode.** `Settings.assert_production_ready()`
  rejects an empty/invalid `ENCRYPTION_KEY`, an empty `SECRET_KEY`, CORS that
  resolves to nothing or to the wildcard `*`, or `SESSION_COOKIE_SECURE=false`
  (it also requires the database/broker URLs). The dev stack sets `DEBUG=true`
  so these are tolerated locally; if you run the API outside dev mode you must
  supply real values. Generation commands are documented inline in
  [`.env.example`](https://github.com/vladenisov/tripl/blob/main/.env.example).
- **`alembic` shebang errors.** Use `uv run python -m alembic ...` (see the
  migrations section).
- **Lockfile drift / CI mismatch.** Always use `uv` and `pnpm`. A stray `pip`,
  `npm`, or `yarn` install will desync the lockfiles.
- **Port already in use.** The dev stack binds `5173`, `8000`, `5432`, `5672`,
  `6379`, and `15672`. Stop conflicting services or remap ports.
- **Edits not hot-reloading.** Compose watch only syncs `backend/src`,
  `frontend/src`, and a few config files; changes to `pyproject.toml`,
  lockfiles, or a `Dockerfile` require a rebuild (re-run `up --watch`).

## Pull Request Conventions

- **Title format:** `[analytics] <Title>`.
- Keep PRs focused and run the checks for the side(s) you touched: backend
  (`pytest`, `ruff check`, `ruff format --check`, `mypy`) and/or frontend
  (`pnpm lint`, `pnpm test`, `pnpm build`). Run `docker compose -f
  compose.dev.yaml config` when you change Compose or env wiring.

Always call out in the PR description when a change touches:

- **API contracts** — request/response shapes (and regenerate `pnpm gen:api`).
- **Event/tracking-plan schema** — models or Pydantic schemas.
- **Queue, task, or schedule** behavior — Celery tasks or the beat schedule.
- **Metrics or anomaly semantics** — collection, bucketing, or detection logic.
- **Alerting** — channels, templates, or delivery behavior.
- **Environment variables** — and keep `.env.example`, the Compose env blocks,
  and `backend/src/tripl/config.py` synchronized.

For deeper area-by-area pointers (which service, schema, task, and test files
correspond to each feature), see
[AGENTS.md](https://github.com/vladenisov/tripl/blob/main/AGENTS.md).

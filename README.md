# tripl

Analytics tracking-plan, monitoring, and alerting service.

## What It Does

`tripl` gives product and analytics teams one place to define what should be tracked, branch and review changes to that plan like code, compare it against what's actually flowing through the data warehouse, and react when volume, shape, or schema changes look suspicious.

### Tracking plan

- Project-scoped catalog of event types, fields, relations, meta fields, and reusable variables.
- Event catalog with implementation, review, archive, and tag workflows.
- Optional photo / Figma attachments per event with threaded comments (local or GCS storage backend).
- Plan revisions + diff history.
- PII / sensitivity tagging on fields.

### Branch-based plan workflow

- Every project has a real `main` branch plus working branches that deep-copy the live plan (event types, fields, events, variables, meta fields, relations, photos, threaded comments).
- Review workflow: Draft → Ready for Review → Changes Requested → Approved → Merged / Closed.
- Reviewer assignment, per-branch threaded comments, approval tracking.
- Branch diff vs main, `behind_base` detection.
- 3-way merge engine preserves live event/event-type IDs by natural key (attached metrics, photos, alerts survive a merge).
- **Inline 3-way per-field merge** on event_type metadata: non-overlapping edits auto-merge; same-field conflicts are surfaced with base/ours/theirs payload and resolved through "Keep ours / Keep theirs" picks persisted per branch.
- **Stakeholder ownership gating**: assign owners to event types; merging a branch that touches an owned type requires an approval from at least one owner.
- Editor-level branch switcher threads a `?branch=` query param through every plan API and the React Query keys.

### Data ingestion & analysis

- Data source adapters for **ClickHouse**, **BigQuery**, and **PostgreSQL** warehouses.
- Async scan jobs via Celery + RabbitMQ.
- Cardinality analysis, JSON-path detection, auto-generation of event types and variables from observed columns.
- Metrics collection into PostgreSQL on a configurable interval (15m / 1h / 6h / 1d / 1w), with replay-by-chunk support.
- Per-event and scan-wide metric breakdown dimensions.

### Monitoring & detection

- Anomaly detection on project-total, event-type, and event scopes with z-score thresholds and seasonality (STL/MSTL).
- **Forecast preview**: next-bucket extrapolation rendered as a dashed line on the metric chart.
- **Schema drift** detector + sample values + retention cleanup; surfaces in the catalog and as a dedicated alert scope.
- **Distribution drift** (PSI) on event field values.
- **Top-movers** drill-down on breakdowns.
- Hour-of-day × weekday heatmap on monitoring detail.
- Chart annotations (deploy / release markers) overlaid on metric charts.

### Alerting

- Destinations: **Slack**, **Telegram**, **generic webhook**, **email (SMTP)**, **Jira** (REST v3 + ADF body), **Linear** (GraphQL).
- Rules with project-total / event-type / event scopes, spike / drop directions, percent + absolute deltas, cooldowns, message and item templates.
- Anomaly explainability: sparkline + top movers embedded in the delivery payload.
- Correlation-aware grouping so a single underlying cause produces one alert.
- Alert rule **simulator**: replay the last N days against current rule config; template preview + cooldown A/B.
- Delivery history with status, rendered message, and per-item context.
- Audit log of plan and alerting mutations with filters.

### Access & governance

- Session-based authentication (HTTP-only cookie), email validated via `email-validator` (RFC 5321 / 6531).
- **User-issued API keys** (Bearer tokens) for LLM agents and CLI scripts: `read` (GET only) or `write` (full editor) scope, optional `expires_in_days`, revocable from the Account page. Send as `Authorization: Bearer tk_…`; only the sha-256 hash is stored.
- **RBAC**: owner / editor / viewer roles.
- Audit log UI with filters (action, user, target type, email).

### Observability

- Prometheus `/metrics` endpoint (opt-in via `PROMETHEUS_METRICS_ENABLED`) exposing scan, anomaly, alert-delivery, schema-drift, and Celery task counters / histograms.
- OpenTelemetry tracing (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`) for FastAPI + SQLAlchemy + Celery — degrades to a logged no-op if the env is blank or the `opentelemetry-*` packages aren't installed.

### Frontend workspace

- React 19 + TypeScript + Vite + Tailwind 4 + shadcn UI.
- Pages: events catalog, project settings (event types, fields, meta fields, variables, relations, **branches**), monitoring + monitoring detail, data sources + scan configs, alerting (destinations / rules / deliveries / simulator), audit log.
- Per-page branch switcher with `localStorage` persistence per project slug.

## Architecture

- **Backend**: FastAPI, SQLAlchemy async, PostgreSQL, Alembic, Pydantic v2.
- **Worker**: Celery, RabbitMQ, multi-warehouse adapter (ClickHouse / BigQuery / Postgres), anomaly + scan + drift analyzers, alert dispatcher.
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query, Recharts, dnd-kit.
- **Storage**: PostgreSQL for plan + metrics + audit + alerts; configurable photo storage backend (local filesystem or GCS).
- **Observability**: Prometheus metrics + OpenTelemetry tracing (both opt-in via env).
- **Local runtime**: Docker Compose for `postgres`, `rabbitmq`, `api`, `celery-worker`, `celery-beat`, and `frontend`.

Important runtime notes:

- Data warehouses (ClickHouse / BigQuery / Postgres source DBs) are external and are not started by Compose.
- The API runs `alembic upgrade head` before serving requests.
- Metrics collection and schema-drift retention cleanup are scheduled by Celery beat.
- API health endpoint: `GET /health`.

## Quick Start

```bash
cp .env.example .env
docker compose up -d --build
```

Open the frontend, create the first account on the sign-in page, and the app will establish an HTTP-only session cookie for subsequent API access.

Endpoints:

- Frontend: http://localhost:5173
- API: http://localhost:8000
- API docs: http://localhost:8000/docs
- RabbitMQ management: http://localhost:15672
- Prometheus metrics (when enabled): http://localhost:8000/metrics

## Development

Backend:

```bash
cd backend
uv sync --extra dev
uv run pytest
uv run ruff check
uv run mypy
uv run alembic upgrade head           # apply migrations to dev DB
uv run alembic revision --autogenerate -m "msg"   # generate migration
```

Frontend:

```bash
cd frontend
pnpm install
pnpm test
pnpm build          # tsc -b && vite build
pnpm lint           # eslint . --max-warnings 0
```

Docker hot reload:

```bash
docker compose up --build --watch
```

What reloads automatically:

- frontend `src` and `public`: synced into the container and handled by Vite HMR;
- backend `src`: synced into the API container and reloaded by `uvicorn --reload`;
- Celery worker and beat: synced backend changes trigger container restart;
- `package.json`, `pnpm-lock.yaml`, `pyproject.toml`, `uv.lock`, and Dockerfiles: trigger image rebuild.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md): local setup, commands, and API overview
- [docs/agent-api-guide.md](docs/agent-api-guide.md): OpenAPI + Bearer-key guide for external LLM agents and CLI scripts
- [PLAN.md](PLAN.md): product scope, architecture map, and future roadmap
- [AGENTS.md](AGENTS.md): repo navigation map for coding agents

# Contributing

## Local Setup

```bash
cp .env.example .env
docker compose up -d --build
```

Services:

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs | http://localhost:8000/docs |
| RabbitMQ management | http://localhost:15672 |

Notes:

- ClickHouse is external and is not started by Compose.
- `api` runs migrations on startup.
- `celery-beat` is responsible for scheduling metrics collection checks.

## Backend Workflow

```bash
cd backend
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
uv run mypy
uv run alembic upgrade head
```

## Frontend Workflow

```bash
cd frontend
pnpm install
pnpm dev
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

## Project Structure

```text
tripl/
├── compose.yaml          # prod / deploy stack (runs the published image)
├── compose.dev.yaml      # local dev stack (build from source + hot-reload)
├── bin/release.sh        # cut a release: bump version, tag, push
├── README.md
├── PLAN.md
├── backend/
│   ├── alembic/
│   └── src/tripl/
│       ├── api/v1/           # FastAPI routers
│       ├── models/           # SQLAlchemy models
│       ├── schemas/          # Pydantic contracts
│       ├── services/         # Business logic
│       ├── tests/            # pytest coverage
│       ├── worker/adapters/  # ClickHouse integration
│       ├── worker/analyzers/ # scan + anomaly logic
│       └── worker/tasks/     # Celery entrypoints
└── frontend/
    └── src/
        ├── api/              # typed HTTP clients
        ├── components/       # layout + UI primitives
        ├── pages/            # MainPage, EventsPage, DataSourcesPage, MonitoringDetailPage, ProjectSettingsPage
        └── types/            # frontend domain contracts
```

## API Overview

All endpoints live under `/api/v1`.

Core resources:

- `/projects`
- `/projects/{slug}/event-types`
- `/projects/{slug}/event-types/{event_type_id}/fields`
- `/projects/{slug}/relations`
- `/projects/{slug}/meta-fields`
- `/projects/{slug}/variables`
- `/projects/{slug}/events`
- `/data-sources`
- `/projects/{slug}/scans`
- `/projects/{slug}/anomaly-settings`
- `/projects/{slug}/alert-destinations`
- `/projects/{slug}/alert-deliveries`

Metrics and monitoring endpoints:

- `GET /projects/{slug}/events-metrics`
- `POST /projects/{slug}/events/window-metrics`
- `GET /projects/{slug}/metrics/total`
- `GET /projects/{slug}/events/{event_id}/metrics`
- `GET /projects/{slug}/event-types/{event_type_id}/metrics`
- `GET /projects/{slug}/anomalies/signals`

## Change Expectations

- Keep FastAPI routers thin; push business rules into services.
- Update backend schemas and frontend types together when payloads change.
- Prefer extending existing worker/analyzer flows rather than adding parallel implementations.
- For scan, metrics, anomaly, or alerting changes, check both runtime behavior and UI assumptions.

## PR Guidelines

- Title format: `[analytics] <Title>`
- Call out API contract changes, event schema changes, queue/schedule changes, metrics/anomaly behavior changes, alerting changes, and environment variable changes.
- Before merging, run backend checks and frontend checks for the areas you touched.

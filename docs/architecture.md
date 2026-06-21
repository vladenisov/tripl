# Architecture

The technical picture of how tripl is built. If you want the *what* and the
*why* in plain language first, read **[concepts.md](concepts.md)**; this page is
the *how* for people working on the system.

For local setup, commands, and the source tree, see
**[../CONTRIBUTING.md](../CONTRIBUTING.md)**.

---

## System shape

tripl is three cooperating processes plus a database and a message broker:

```
                      ┌─────────────┐
   browser  ───────▶  │  frontend   │  React + Vite (static SPA)
                      └──────┬──────┘
                             │ HTTP /api/v1
                      ┌──────▼──────┐        ┌──────────────┐
                      │     api     │◀──────▶│  PostgreSQL  │  system of record
                      │  (FastAPI)  │        └──────▲───────┘
                      └──────┬──────┘               │
                             │ enqueue              │ read/write
                      ┌──────▼──────┐        ┌──────┴───────┐
                      │  RabbitMQ   │        │   workers    │
                      │  (broker)   │◀──────▶│   (Celery)   │
                      └─────────────┘        └──────┬───────┘
                                                    │ read-only queries
                                             ┌──────▼───────┐
                                             │  warehouses  │  ClickHouse /
                                             │  (external)  │  BigQuery / Postgres
                                             └──────────────┘
```

- **api** — FastAPI service. Owns all HTTP, auth, and business logic; reads and
  writes PostgreSQL; enqueues background work onto RabbitMQ.
- **celery-worker** — runs scans, collects metrics, detects anomalies and drift,
  and dispatches alerts. It is the only process that connects to the external
  warehouses.
- **celery-beat** — the scheduler. Triggers due metric-collection checks and the
  schema-drift retention cleanup.
- **PostgreSQL** — the system of record for the plan, metrics, anomalies, audit
  log, and alert deliveries.
- **RabbitMQ** — the broker between the api and the workers.
- The **warehouses are external** and are never started by tripl; the worker
  only ever issues read queries against them.

Locally, all of the above (except the warehouses) run under Docker Compose:
`postgres`, `rabbitmq`, `api`, `celery-worker`, `celery-beat`, and `frontend`.

---

## Backend (`backend/`)

- **FastAPI** with fully async request paths.
- **SQLAlchemy** (async) over **PostgreSQL**, migrations via **Alembic**.
- **Pydantic v2** schemas as the request/response contract.
- Routers live under `src/tripl/api/v1` and stay thin; business rules live in
  `src/tripl/services`.
- Shared compute that both the request path and the worker need — warehouse
  **adapters**, **analyzers** (anomaly/drift/scan logic), and interval helpers —
  lives in a neutral `src/tripl/core` kernel that imports neither `services` nor
  `worker`. This keeps `services` from importing `worker` at module level; the
  request path reaches the worker only via lazy, runtime Celery dispatch.
- DB engine and pool configuration is centralized in `src/tripl/db_config.py`
  (an async pooled engine for the API, a sync pooled engine for Celery; the
  worker→async bridge uses a throwaway NullPool engine — see
  `worker/search_reindex.py`).
- Migrations are applied by the deployment entrypoint (the Compose `api` command
  runs `alembic upgrade head`) before the API starts serving requests, so the
  schema is current. The app process itself does not run migrations on startup;
  its lifespan only configures logging and asserts production readiness.
- Health check: `GET /health`.

### Authentication & access

- **Session auth** via an HTTP-only cookie for interactive users. Emails are
  validated with `email-validator` (RFC 5321 / 6531).
- **API keys** (Bearer tokens, `Authorization: Bearer tk_…`) for scripts and
  agents. Only the SHA-256 hash of a key is stored. Keys carry a `read` or
  `write` scope, an optional project binding, and an optional expiry, and are
  revocable. See **[agent-api-guide.md](agent-api-guide.md)**.
- **RBAC** with three roles: owner / editor / viewer. Owner-only routes
  (security and instance administration) require an interactive owner session
  and are never reachable with an API key.

---

## Worker (`backend/src/tripl/worker/`)

- **Celery** app with a **RabbitMQ** broker.
- **Warehouse adapters** (`core/adapters`) provide a common interface over
  **ClickHouse**, **BigQuery**, and **PostgreSQL** source databases.
- **Analyzers** (`core/analyzers`) hold the scan, anomaly, and drift logic.
  (Both live in the shared `core` kernel — see the Backend section — so the
  request path can reuse them without importing the worker package.)
- **Tasks** (`worker/tasks`) are the Celery entrypoints for scans, metrics,
  anomalies, and alert delivery.

### Detection

- **Anomaly detection** runs at three scopes — project-total, event-type, and
  event. It combines **z-score** thresholds with **seasonality** decomposition
  (**STL / MSTL**) so it understands daily and weekly rhythms rather than just a
  flat baseline.
- **Forecast** — a next-bucket extrapolation, rendered as a dashed line on the
  metric chart.
- **Schema drift** — detects fields appearing, disappearing, or carrying new
  values; keeps sample values; and prunes old drift records on a retention
  schedule.
- **Distribution drift** — uses **PSI** (Population Stability Index) over event
  field values.
- **Correlation-aware grouping** collapses signals that share an underlying
  cause so one root problem yields one alert, not many.

### Metrics

- Counts are collected into PostgreSQL on a configurable interval
  (15m / 1h / 6h / 1d / 1w), with **replay-by-chunk** support for backfills.
- Bulk metric upserts are chunked to stay under PostgreSQL's 65535 bind-parameter
  limit.

---

## Frontend (`frontend/`)

- **React 19** + **TypeScript** + **Vite**.
- **Tailwind CSS 4** with **shadcn**-style UI primitives.
- **TanStack Query** for server state, **Recharts** for charts, **dnd-kit** for
  drag-and-drop reordering.
- The information architecture is four job-based groups — **Plan / Observe /
  Govern / Connect** — defined once in `src/lib/navigation.ts` and consumed by
  both the sidebar and the breadcrumbs so they never drift apart.
- **Serving.** In development the **Vite dev server** serves the SPA with HMR and
  proxies `/api` to the backend. In production there are two options: **(a)
  consolidated single container** — FastAPI serves the built SPA itself via
  `app.frontend()` (FastAPI 0.138+) when `SERVE_FRONTEND=true`, so one image
  serves API + SPA (root `Dockerfile` + `compose.prod.yaml`, **no nginx**); or
  **(b) standalone static tier** — `frontend/Dockerfile` serves the build through
  nginx (`frontend/nginx.conf`) next to the API. Consolidated mode routes the SPA
  through the API's `SecurityHeadersMiddleware`/`BrotliMiddleware`, so it inherits
  the same CSP/headers and compression; because the app is then the network edge,
  `rate_limit_trust_forwarded_for` stays `False` (don't trust client-sent
  forwarded headers) unless a trusted proxy is added in front.
- Plan branch context travels as a `?branch=` query parameter threaded through
  every plan API call and the React Query keys; the active branch is persisted
  in `localStorage` per project slug.

---

## Data model (core objects)

| Object | What it is |
|---|---|
| `Project` | A tracking-plan namespace — one product/world. |
| `EventType` | A folder grouping related events. |
| `Event` | A concrete tracked event. |
| `FieldDefinition` | A typed field on an event type. |
| `MetaFieldDefinition` | Project-level metadata carried by every event. |
| `Variable` | A reusable value list. |
| `Relation` | A declared connection between events. |
| `DataSource` | A connection to an external warehouse. |
| `ScanConfig` | A saved scan query + extraction rules. |
| `ScanJob` | One async execution of a scan config. |
| `EventMetric` | Time-bucketed counts for an event. |
| `MetricAnomaly` | A persisted anomaly bucket. |
| `AlertDestination` | A delivery channel (Slack, Telegram, …). |
| `AlertRule` | Filtering + delivery configuration for signals. |
| `AlertDelivery` | A record of one alert that was sent. |

Plan branches deep-copy the relevant objects (event types, fields, events,
variables, meta fields, relations, photos, comments) and merge back via a
3-way merge that preserves live IDs by natural key.

---

## Operational flows

### Scan flow

1. The api creates or updates a `ScanConfig`.
2. Running it creates a `ScanJob`.
3. A Celery task executes the query against the warehouse via the adapter.
4. Cardinality analysis decides whether observed values become event fields or
   variables.
5. Events and variables are created or updated in PostgreSQL.
6. `ScanJob.result_summary` is filled in for the UI.

### Metrics flow

1. Beat schedules due-checks.
2. Due scans dispatch metrics collection.
3. Counts are aggregated into `event_metrics`.
4. Anomalies are recalculated into `metric_anomalies`.
5. Matching alert rules enqueue deliveries.

### Alert flow

1. Anomaly items are matched against rule configuration.
2. `AlertDelivery` and `AlertDeliveryItem` rows are written.
3. A Celery task sends the formatted notification.
4. Delivery status becomes `pending`, `sent`, or `failed`.

---

## Storage & integrations

- **PostgreSQL** stores the plan, metrics, audit log, and alert deliveries.
- **Photo / attachment storage** is pluggable: local filesystem or **GCS**.
- **Alert destinations**: Slack, Telegram, generic webhook, email (SMTP),
  **Jira** (REST v3 with an ADF body), and **Linear** (GraphQL).

---

## Observability (both opt-in)

- **Prometheus** — a `/metrics` endpoint, enabled with
  `PROMETHEUS_METRICS_ENABLED`, exposing scan, anomaly, alert-delivery,
  schema-drift, and Celery task counters and histograms.
- **OpenTelemetry** — tracing for FastAPI + SQLAlchemy + Celery, enabled with
  `OTEL_EXPORTER_OTLP_ENDPOINT`. It degrades to a logged no-op when the env var
  is blank or the `opentelemetry-*` packages aren't installed.

---

## See also

- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — setup, commands, source tree,
  API surface.
- **[../PLAN.md](../PLAN.md)** — product scope and roadmap.
- **[agent-api-guide.md](agent-api-guide.md)** — the API contract for agents and
  scripts.
- **[concepts.md](concepts.md)** — the same system in plain language.

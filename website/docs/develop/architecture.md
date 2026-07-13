# Architecture

The technical picture of how tripl is built. If you want the *what* and the
*why* in plain language first, read **[concepts.md](../use/concepts.md)**; this page is
the *how* for people working on the system.

For local setup, commands, and the source tree, see
**[CONTRIBUTING.md](https://github.com/vladenisov/tripl/blob/main/CONTRIBUTING.md)**.

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
- **celery-beat** — the scheduler. Triggers due metric-collection checks — for
  both event counts and the **metric catalog** (a ~300 s due-check) — and the
  schema-drift retention cleanup. It also polls implementation tickets, chases
  stranded search embeddings, reaps stuck alert deliveries, and runs periodic
  alert/maintenance tasks.
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
  revocable. See **[agent-api-guide.md](../integrate/agent-api-guide.md)**.
- **RBAC** with three roles: owner / editor / viewer. Owner-only routes
  (security and instance administration) require an interactive owner session
  and are never reachable with an API key.

---

## Worker (`backend/src/tripl/worker/`)

- **Celery** app with a **RabbitMQ** broker.
- **Warehouse adapters** (`core/adapters`) provide a common interface over
  **ClickHouse**, **BigQuery**, and **PostgreSQL** source databases. A common
  interface is not the same as identical behavior, and it is emphatically not the
  same as an equally *verified* behavior:
  - **ClickHouse and PostgreSQL are executed** in CI. The `conformance` job stands
    up real `clickhouse-server` and `postgres` containers, runs the SQL the
    adapters generate, and compares the results against the reference
    implementation. Their bucket values, counts and contract counts are proven.
  - **BigQuery is analyzed, not executed.** CI posts every generated statement to
    an emulator embedding Google's real **ZetaSQL analyzer**, which is
    authoritative on whether the SQL is *valid* GoogleSQL — but not on what it
    *computes*. BigQuery bucket values and field-contract values remain believed
    rather than proven; a credentialed value-conformance job is specified but
    deliberately unwired.

  The gates live in `backend/src/tripl/tests/conformance/`. See the
  **[warehouse capability matrix](warehouse-parity.md)** for the per-capability
  proven/believed/bounded breakdown, which paths are still sampled or depth-capped,
  the supported time types per dialect, and the UTC / Monday-week bucket contract
  every adapter must honor.
- **Dialect awareness** (`core/adapters/measure_validator`) centralizes identifier
  quoting, string/number/timestamp literals and a pre-flight `lint_dialect_sql`
  check per `SqlDialect`, so a query that provably cannot resolve on the selected
  warehouse is rejected at preview time rather than inside a worker. The lint runs
  *after* the read-only gate and can only reject more, never admit more.
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
- **Variable value drift** — compares scan-observed values with a variable's
  effective documented list (per-event override, otherwise global) and keeps
  the review state independent from later evidence refreshes.
- **Distribution drift** — uses **PSI** (Population Stability Index) over event
  field values.
- **Release regression** — activation-gated comparison of the newest stable app
  version with the previous release, inert unless a scan names an app-version
  column.
- **Correlation-aware grouping** collapses signals that share an underlying
  cause so one root problem yields one alert, not many.
- **Metric anomalies** run the same detector at a dedicated **metric scope**.
  Metrics are classified **count-shaped** (counts/sums) or **fractional** (ratios,
  averages, raw SQL): count-shaped series keep zero-fill and the
  `min_expected_count` gate, while fractional series drop both (a missing bucket
  means "no data", not zero) so sub-unit ratios don't false-fire. Per-project
  `detect_metrics` enables the scope; per-rule `include_metrics` opts metric
  anomalies into alerting (off by default).

### Metrics

- Counts are collected into PostgreSQL on a configurable interval
  (15m / 1h / 6h / 1d / 1w), with **replay-by-chunk** support for backfills.
- Bulk metric upserts are chunked to stay under PostgreSQL's 65535 bind-parameter
  limit.

### Catalog metrics

- **`MetricDefinition`** is a user-defined, **project-scoped** metric (the
  catalog) — global rather than branched. Three kinds: **`sql`** (a user
  read-only `SELECT` or top-level `WITH ... SELECT` returning a per-bucket value
  against a data source on its own interval), **`fact`** (`count` /
  `sum` / `avg` / `min` / `max` / `count_distinct` over a measure column of a
  reusable fact table, with optional filters and breakdowns), and
  **`event_composition`** (a `single` event count, a `ratio` A/B, or an event
  `per_distinct_user`, derived from already-collected `event_metrics`).
- **Scheduling.** The `check_metric_definitions_due` beat task runs about every
  **300 s** and dispatches `collect_metric_definitions` for each **active** metric
  whose interval is due. `sql` / `fact` metrics query their own data
  source through the adapter; `event_composition` metrics read existing event
  series on the shared scan grid (no warehouse query).
- **Aggregations.** Adapter `_aggregate_value_sql` builds the per-kind SQL for
  ClickHouse / BigQuery / PostgreSQL; `core/adapters/measure_validator` checks the
  measure/distinct column against the source's real columns before it reaches a
  query. Fact row filters persist in metric `config` as named `row_filters`,
  free-text `filter_sql`, and structured `conditions`; collection compiles them
  into one `AND` expression for both per-metric and batched aggregate paths.
- **Storage.** Values land in `metric_values`, with per-split rows in
  `metric_value_breakdowns` (platform / app-version / …, like event breakdowns).
  A **divide-by-zero** in a `ratio` bucket produces **no value** — a gap, not a
  `0` — so the row is dropped rather than written as zero. Fact-ratio breakdowns
  are supported when numerator and denominator use the same fact table; each
  breakdown row stores that dimension value's numerator / denominator ratio, not
  a component that sums to the top-line ratio.
- **Surface.** Catalog CRUD lives at `/projects/{slug}/metrics`; a series read
  service feeds the frontend **MetricsPage** (list + kind-aware create/edit form)
  and the metric **drilldown**, which reuses the monitoring detail tabs.

---

## Frontend (`frontend/`)

- **React 19** + **TypeScript** + **Vite**.
- **Tailwind CSS 4** with **shadcn**-style UI primitives.
- **TanStack Query** for server state, **Recharts** for charts, **dnd-kit** for
  drag-and-drop reordering.
- The project information architecture is three job-based groups — **Plan /
  Observe / Govern** — defined once in `src/lib/navigation.ts` and consumed by
  both the sidebar and breadcrumbs. Data sources, members, API keys, personal
  security, and instance controls live in the separate Settings surface.
- **Serving.** In development the **Vite dev server** serves the SPA with HMR and
  proxies `/api` to the backend. In production there are two options: **(a)
  consolidated single container** — FastAPI serves the built SPA itself via
  `app.frontend()` (FastAPI 0.138+) when `SERVE_FRONTEND=true`, so one image
  serves API + SPA (root `Dockerfile` + the default `compose.yaml`, **no nginx**;
see [RELEASE.md](../run/release.md)); or
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
| `Variable` | A typed `${placeholder}` with documented values, source bindings, and scan exclusion state. |
| `VariableValue` | One scan-observed variable context for an event/field. |
| `VariableEventValueOverride` | A complete per-event replacement for a variable's global documented list. |
| `VariableValueDrift` | Novel observed values plus their review/resolution state. |
| `Relation` | A declared connection between events. |
| `DataSource` | A connection to an external warehouse. |
| `ScanConfig` | A saved scan query + extraction rules. |
| `ScanJob` | One async execution of a scan config. |
| `EventMetric` | Time-bucketed counts for an event. |
| `MetricDefinition` | A user-defined metric (the metrics catalog); project-scoped, not branched. |
| `FactTable` | A reusable safe query, timestamp/column schema, and named filters for fact metrics. |
| `MetricValue` | Time-bucketed values for a `MetricDefinition`. |
| `MetricValueBreakdown` | Per-breakdown metric values (platform / app-version / …). |
| `MetricAnomaly` | A persisted anomaly bucket. |
| `AlertDestination` | A delivery channel (Slack, Telegram, …). |
| `AlertRule` | Filtering + delivery configuration for signals. |
| `AlertDelivery` | A record of one alert that was sent. |
| `ProjectTrackerConfig` | Owner-managed Jira settings for post-merge implementation tickets. |
| `ImplementationTicket` | A branch-merge ticket and the events it covers. |

Plan branches deep-copy the relevant objects (event types, fields, events,
variables, documented values/overrides/exclusions, meta fields, relations,
photos, comments) and merge back via a
3-way merge that preserves live IDs by natural key. Metrics are deliberately
**not** branched — they are project-scoped and shared across every branch.

---

## Operational flows

### Scan flow

1. The api creates or updates a `ScanConfig`.
2. Running it creates a `ScanJob`.
3. A Celery task executes the query against the warehouse via the adapter.
4. Cardinality analysis decides whether observed values become event fields or
   variables; bindings adopt existing variables and naming/group rules produce
   stable event identities.
5. Events and variables are created or updated in PostgreSQL. Scan writes do
   not overwrite user-authored field values or recreate excluded variables.
6. `ScanJob.result_summary` is filled in for the UI.

### Metrics flow

1. Beat schedules due-checks.
2. Due scans dispatch metrics collection.
3. Counts are aggregated into `event_metrics`.
4. Anomalies are recalculated into `metric_anomalies`.
5. Matching alert rules enqueue deliveries.

### Catalog metric flow

1. Beat (`check_metric_definitions_due`, ~300 s) finds active, due metrics.
2. `collect_metric_definitions` evaluates each — querying the warehouse
   (`sql` / `fact`) or composing event series (`event_composition`). Compatible
   fact aggregates are batched by fact table.
3. Values upsert into `metric_values` / `metric_value_breakdowns`.
4. Metric-scope anomalies are recalculated into `metric_anomalies`.
5. Alert rules with `include_metrics` enqueue deliveries.

### Alert flow

1. Anomaly items are matched against rule configuration.
2. `AlertDelivery` and `AlertDeliveryItem` rows are written.
3. A Celery task sends the formatted notification.
4. Delivery status becomes `pending`, `sent`, or `failed`.

Separately, the weekly plan-digest beat task sends directly to every enabled
Slack/email destination; it does not evaluate routing rules or create a normal
anomaly delivery.

### Branch and implementation-ticket flow

1. A branch snapshots plan objects and records review approvals against a plan
   hash; edits make older approvals stale.
2. Merge policy and event-type owner gates are checked before the three-way
   merge applies changes to `main`.
3. Search is reindexed after merge. If a project tracker is enabled, creating a
   Jira implementation ticket is best-effort and cannot roll back the merge.
4. A periodic worker polls open tickets; a Done issue promotes its covered
   events to `implemented` without downgrading a later lifecycle state.

### Search flow

Plan changes, scans, branch merges, and metric/fact-table CRUD refresh
`search_documents`. Reindexing diffs content hashes so unchanged embeddings are
preserved. PostgreSQL full-text/trigram ranking is always available; optional
provider embeddings add semantic ranking, and a periodic chaser requeues old
pending documents.

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

- **[CONTRIBUTING.md](https://github.com/vladenisov/tripl/blob/main/CONTRIBUTING.md)** — setup, commands, source tree,
  API surface.
- **[agent-api-guide.md](../integrate/agent-api-guide.md)** — the API contract for agents and
  scripts.
- **[concepts.md](../use/concepts.md)** — the same system in plain language.

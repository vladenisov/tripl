# AGENTS.md

_Last updated: 2026-07-10._

## What This Repo Is

`tripl` is an analytics tracking-plan and monitoring service.

Use it to:
- manage projects and tracking plans;
- define event types, fields, relations, meta fields, and reusable variables;
- store concrete catalog events with lifecycle, review, ownership, media, and
  change history;
- connect external analytics DBs — ClickHouse, BigQuery, or PostgreSQL;
- run scan jobs that infer events and variables from real data;
- collect time-bucketed event and user-defined business metrics;
- detect anomalies, schema/distribution/value drift, and release regressions;
- review plan changes on branches and reconcile the plan with live data;
- route alerts to chat, email, webhook, and issue-tracker destinations.

An optional local [PLAN.md](PLAN.md) contains the internal product plan and is
intentionally gitignored. Public product/architecture documentation lives under
[website/docs](website/docs). This file is the fast navigation map for agents
working in the codebase.

## Agent Workflow

If `mem0` MCP is available in the current session, use it for every task.
- search or list relevant memories before making assumptions, especially for ongoing work, prior decisions, and user preferences;
- save durable decisions, preferences, and important implementation findings to `mem0` when they are likely to matter in future sessions;
- do not start a separate memory service; this project uses the configured `mem0` MCP.

## Current Product Scope

Already implemented in code:
- session auth, owner/editor/viewer RBAC, and scoped API keys;
- event catalog CRUD, lifecycle, bulk triage, owners, history, photos/specs, and
  comments;
- plan branches, review policy, conflicts, merge, revisions, and optional Jira
  implementation tickets;
- typed variables with documented values, source bindings, per-event overrides,
  drift review, and scan exclusion;
- ClickHouse, BigQuery, and PostgreSQL data sources and scan configs;
- async scan pipeline via Celery + RabbitMQ;
- auto-generated events/variables from cardinality and JSON-path analysis;
- event metrics plus a SQL/fact/event-composition metrics catalog;
- anomaly detection for project total, event type, event, and metric scopes;
- schema, distribution, variable-value, and app-version regression detection;
- reconciliation, coverage, monitoring, search/AI, and audit surfaces;
- alerting with six destination types, rules, simulation, inbox, retries,
  delivery history, and message templating;
- workspace/project/instance settings and production hardening.

Not a safe assumption unless you verify:
- import/export;
- per-project membership separate from workspace-wide roles;
- automatic rollback of a merged branch;
- any local analytics warehouse container.

## Stack And Runtime

Backend:
- Python `3.14`
- `uv`
- FastAPI
- SQLAlchemy async + `asyncpg`
- Alembic
- PostgreSQL
- Celery `5.x`
- RabbitMQ
- `clickhouse-connect`
- `statsmodels` for anomaly logic

Frontend:
- `pnpm`
- React `19`
- TypeScript
- Vite `8`
- Tailwind CSS `4`
- Radix UI primitives
- TanStack Query
- Recharts

Local dev runtime in [compose.dev.yaml](compose.dev.yaml) (prod runs the
published image via [compose.yaml](compose.yaml); see [website/docs/run/release.md](website/docs/run/release.md)):
- `postgres`
- `rabbitmq`
- `api`
- `celery-worker`
- `celery-beat`
- `frontend`

Important runtime facts:
- Warehouses (ClickHouse, BigQuery, PostgreSQL) are external. The repo does not run them in Compose.
- `api` runs `alembic upgrade head` before `uvicorn`.
- Celery beat schedules event/catalog metric due-checks every 5 minutes (300s),
  implementation-ticket sync every 5 minutes, and stranded embedding recovery
  every 15 minutes.
- API health endpoint is `GET /health`.
- CORS is open in dev app setup.

## Environment Variables

Primary backend settings are in [backend/src/tripl/config.py](backend/src/tripl/config.py).

Connectivity:
- `DATABASE_URL`, `SYNC_DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`

Identity and secrets:
- `ENCRYPTION_KEY` — Fernet key for at-rest secrets. **Required** in non-debug mode.
- `SECRET_KEY` — session-cookie signing key. **Required** in non-debug mode.
- `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE`.
- `APP_BASE_URL` — used for alert links and as the default CORS origin.

Edge / hardening:
- `CORS_ALLOW_ORIGINS` — comma-separated origins. Empty + DEBUG=true → `*`; empty + DEBUG=false derives from `APP_BASE_URL`, else denies all.
- `SECURITY_HEADERS_ENABLED`, `HSTS_ENABLED`, `HSTS_MAX_AGE_SECONDS`, `CONTENT_SECURITY_POLICY`.
- `RATE_LIMIT_ENABLED`, `RATE_LIMIT_LOGIN_PER_MINUTE`, `RATE_LIMIT_REGISTER_PER_HOUR`.

Observability:
- `LOG_LEVEL`, `LOG_JSON`, `REQUEST_ID_HEADER`.

Frontend:
- `VITE_API_URL`

Practical notes:
- `SYNC_DATABASE_URL` is used by Celery tasks and other sync SQLAlchemy code paths.
- The app refuses to start in non-debug mode with an empty/invalid `ENCRYPTION_KEY`, no resolvable CORS origin, or `SESSION_COOKIE_SECURE=false`. See `Settings.assert_production_ready()`.
- Keep `.env.example`, Compose env, and app settings synchronized.

## Repo Layout

Top level:
- [PLAN.md](PLAN.md): optional, gitignored internal product notes.
- [README.md](README.md): quick start and user-facing overview.
- [website/docs](website/docs): public product, operations, API, and architecture
  documentation.
- [compose.yaml](compose.yaml): production stack (published image); [compose.dev.yaml](compose.dev.yaml): local dev topology.
- [backend](backend): Python service.
- [frontend](frontend): React app.

Backend entrypoints:
- [backend/src/tripl/main.py](backend/src/tripl/main.py): FastAPI app, middleware stack, lifespan, and `/health`.
- [backend/src/tripl/api/v1/router.py](backend/src/tripl/api/v1/router.py): all API router registration.
- [backend/src/tripl/worker/celery_app.py](backend/src/tripl/worker/celery_app.py): Celery app and beat schedule.

Backend layers:
- `backend/src/tripl/models`: SQLAlchemy models.
- `backend/src/tripl/schemas`: Pydantic request/response models.
- `backend/src/tripl/services`: business logic used by routers.
- `backend/src/tripl/api/v1`: thin HTTP layer.
- `backend/src/tripl/middleware`: request-id, security headers, rate limiting.
- `backend/src/tripl/crypto.py`: Fernet-based at-rest encryption (one source of truth for all callers).
- `backend/src/tripl/logging_config.py`: log handler/formatter wiring.
- `backend/src/tripl/worker/tasks`: async task entrypoints.
- `backend/src/tripl/core/analyzers`: scan/anomaly analysis logic.
- `backend/src/tripl/core/adapters`: analytics DB (warehouse) adapters — ClickHouse, BigQuery, PostgreSQL.
- `backend/src/tripl/tests`: backend tests.

Frontend layers:
- `frontend/src/App.tsx`: route table.
- `frontend/src/pages`: screen-level UI.
- `frontend/src/api`: typed HTTP client wrappers.
- `frontend/src/components`: layout and shared UI.
- `frontend/src/types/index.ts`: frontend domain types.
- `frontend/src/**/*.test.*`: Vitest coverage.

## Domain Model Cheat Sheet

Core planning entities:
- `Project`: tracking-plan namespace.
- `EventType`: schema bucket like page view or click.
- `FieldDefinition`: typed field under an event type.
- `EventTypeRelation`: relation between event types via fields.
- `MetaFieldDefinition`: project-level metadata schema.
- `Variable`: typed `${placeholder}` with documented values, warehouse bindings,
  per-event overrides, observed contexts, and scan-exclusion state.
- `PlanBranch`, `PlanBranchApproval`, `PlanBranchReviewer`,
  `PlanBranchComment`, `PlanBranchMergeResolution`, `PlanRevision`: reviewable
  plan-change workflow.

Catalog entities:
- `Event`: concrete expected event instance in the plan.
- `EventFieldValue`: field value attached to an event.
- `EventMetaValue`: meta value attached to an event.
- `EventTag`: freeform event tag.
- `EventChange`: field-level event history.
- `EventPhoto`, `EventPhotoComment`: images/Figma specs and threaded discussion.

Analytics and monitoring entities:
- `DataSource`: external analytics DB connection — ClickHouse, BigQuery, or PostgreSQL.
- `ScanConfig`: saved scan definition. Important fields include `base_query`,
  event/time/name mapping, JSON paths, grouping rules, breakdown/drift columns,
  row/lookback/replay limits, app-version/platform roles, and interval.
- `ScanJob`: async execution record for a scan config.
- `EventMetric`, `EventMetricBreakdown`: aggregated event-count buckets.
- `FactTable`: reusable safe source query and named filters for fact metrics.
- `MetricDefinition`, `MetricValue`, `MetricValueBreakdown`: the project-wide
  SQL/fact/event-composition metrics catalog and collected series.
- `MetricAnomaly`, `MetricBreakdownAnomaly`: persisted anomaly buckets.
- `SchemaDrift`, `DistributionDrift`, `VariableValueDrift`,
  `ReleaseRegression`: non-volume detection records.
- `ProjectAnomalySettings`: anomaly detector thresholds and scope toggles.

Alerting entities:
- `AlertDestination`: Slack, Telegram, webhook, email, Jira, or Linear channel
  config.
- `AlertRule`: filters, thresholds, cooldown, include/exclude scope, and message templates.
- `AlertRuleState`: cooldown/state tracking.
- `AlertDelivery`: one queued/sent/failed delivery attempt.
- `AlertDeliveryItem`: matched anomaly items included in a delivery.
- `ProjectTrackerConfig`, `ImplementationTicket`: separate Jira automation for
  branch-to-implementation workflow.

## API Map

Base prefix: `/api/v1`

Routers currently registered:
- `/auth`, `/users`, `/me/api-keys`, `/settings`
- `/activity`, `/audit`
- `/projects`
- `/projects/{slug}/event-types`
- `/projects/{slug}/event-types/{event_type_id}/fields`
- `/projects/{slug}/relations`
- `/projects/{slug}/meta-fields`
- `/projects/{slug}/variables`
- `/projects/{slug}/events`
- `/data-sources`
- `/projects/{slug}/scans`
- `/projects/{slug}/search`
- `/projects/{slug}/metrics` (catalog plus series)
- `/projects/{slug}/fact-tables`
- `/projects/{slug}/branches`, `/projects/{slug}/revisions`
- `/projects/{slug}/reconciliation`
- `/projects/{slug}/anomaly-settings`
- `/projects/{slug}/alert-destinations`
- `/projects/{slug}/alert-deliveries`
- `/projects/{slug}/annotations`, `/projects/{slug}/tracker-config`
- event-volume metric routes under project, event, and event-type paths

Useful endpoint groups:
- Events: list/filter/create/update/delete, bulk create/update/delete,
  reorder/move, tags, history, photos/specs/comments.
- Variables: CRUD, bulk update/delete, observed contexts, per-event overrides,
  drift list/actions.
- Data sources: CRUD, connection test, stats, and schema browse.
- Scans: CRUD, async preview, run/cancel, groups, replay, version/platform and
  monitoring insight endpoints, job history.
- Metrics:
  - `GET /projects/{slug}/events-metrics`
  - `POST /projects/{slug}/events/window-metrics`
  - `GET /projects/{slug}/metrics/total`
  - `GET /projects/{slug}/events/{event_id}/metrics`
  - `GET /projects/{slug}/event-types/{event_type_id}/metrics`
  - `GET /projects/{slug}/anomalies/signals`
- Catalog metrics/fact tables: CRUD, preview, collect, series, breakdowns,
  versions, reorder/bulk status.
- Branches: lifecycle, reviewers, comments, diff/conflicts/resolutions/merge;
  revisions snapshot/list/diff.
- Reconciliation: shadow/dead events and coverage.
- Alerting:
  - destinations CRUD
  - rules CRUD nested under a destination
  - rule simulation, monitor mute/unmute
  - deliveries list/detail/retry and Inbox actions

If you need exact request/response shapes, open the corresponding file in `backend/src/tripl/schemas` before digging into services.

## Frontend Route Map

Defined in [frontend/src/App.tsx](frontend/src/App.tsx):
- `/`: single-project redirect or workspace project list
- `/workspace`
- `/settings/{members|api-keys|profile|security|data-sources}`
- `/settings/project/{general|plan-rules}`
- `/settings/instance/:instSection`
- `/p/:slug/overview`
- `/p/:slug/events`
- `/p/:slug/events/:tab`
- `/p/:slug/events/:tab/{new|:eventId|:eventId/edit}`
- `/p/:slug/monitoring/:scope/:id`
- `/p/:slug/monitors[/:monitorId]`
- `/p/:slug/metrics` and `/p/:slug/metrics/:metricId/edit`
- `/p/:slug/metrics/fact-tables[/:factTableId/edit]`
- `/p/:slug/reconciliation`, `/p/:slug/anomalies`, `/p/:slug/coverage`
- `/p/:slug/settings`
- `/p/:slug/settings/:tab[/:itemId]`

Main pages:
- `ProjectsPage`: project portfolio, create/demo, health rollups.
- `EventsPage` / `EventForm`: catalog, lifecycle/review triage, bulk flows,
  template-aware create/edit.
- `OverviewPage`, `MonitorsPage`, `MonitoringDetailPage`, `AnomaliesPage`:
  observation surfaces.
- `MetricsPage`, `MetricForm`, `FactTableForm`: metrics catalog and fact tables.
- `ReconciliationPage`, `CoveragePage`: governance surfaces.
- `ProjectSettingsPage`: event types, meta fields, relations, variables,
  monitoring, alerting, scans, branches, history, audit.
- `SettingsArea`: workspace, project-general, data-source, account, and instance
  configuration.

Settings tabs currently include:
- `event-types`
- `meta-fields`
- `relations`
- `variables`
- `monitoring`
- `alerting`
- `scans`
- `branches`
- `history`
- `audit`

## Async Pipeline Map

Scan flow:
1. A `ScanConfig` points to a `DataSource` and query.
2. API creates a `ScanJob`.
3. Celery task `tripl.worker.tasks.scan.run_scan` executes.
4. Adapter connects to the configured warehouse (ClickHouse, BigQuery, or PostgreSQL).
5. Cardinality/JSON-path analysis decides low-cardinality vs variable-like
   fields; bindings and name/group rules resolve stable identities.
6. Event generation creates or updates plan objects without overwriting authored
   field values or recreating excluded variables.
7. Job summary is written back to `ScanJob.result_summary`.

Metrics flow:
1. Beat schedules `tripl.worker.tasks.metrics.check_metrics_due` every 5 minutes (300s).
2. Due scan configs trigger collection.
3. Metrics are collected into `event_metrics`.
4. Anomalies are recalculated and persisted.
5. Alert deliveries may be created for matched rules.

Catalog metrics flow:
1. Beat schedules `check_metric_definitions_due` every 5 minutes.
2. SQL metrics query their source; fact metrics batch compatible aggregates by
   fact table; event-composition metrics reuse event series.
3. Values/breakdowns are written to `metric_values` tables.
4. Metric-scope anomalies are recalculated and can alert when a rule opts in.

Branch flow:
1. Branch changes are reviewed against a plan hash; later edits stale approvals.
2. Merge policy, ownership approvals, conflicts, and explicit resolutions gate
   the three-way merge.
3. Merge refreshes search and can best-effort create a Jira implementation
   ticket; beat polls ticket completion every 5 minutes.

Search flow:
1. Plan/metric/fact-table mutations incrementally refresh `search_documents`.
2. Keyword search is always available; optional embeddings add semantic rank.
3. Beat requeues stranded embedding batches every 15 minutes.

Alert flow:
1. Metrics/anomaly pipeline identifies matched alert-rule conditions.
2. `AlertDelivery` and `AlertDeliveryItem` records are created.
3. Celery task `tripl.worker.tasks.alerts.send_alert_delivery` sends to destination.
4. Delivery status becomes `pending`, `sent`, or `failed`.

Current alert channel support:
- Slack webhook
- Telegram bot/chat
- Generic webhook
- Email via SMTP
- Jira issue
- Linear issue

Current message formats exposed in frontend/backend types:
- `plain`
- `slack_mrkdwn`
- `telegram_html`
- `telegram_markdownv2`

## Where To Look First

If the task is about event catalog CRUD:
- `backend/src/tripl/api/v1/events.py`
- `backend/src/tripl/services/event_service.py`
- `backend/src/tripl/schemas/event.py`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/api/events.ts`
- `backend/src/tripl/tests/test_events.py`

If the task is about event types, fields, relations, meta fields, or variables:
- matching files in `backend/src/tripl/api/v1`
- matching service and schema files
- `backend/src/tripl/services/variable_value_drift_service.py`
- `backend/src/tripl/core/analyzers/_event_generator_variables.py`
- `frontend/src/pages/ProjectSettingsPage.tsx`
- `frontend/src/pages/settings/VariablesTab.tsx`
- backend tests: `test_event_types.py`, `test_fields.py`, `test_relations.py`,
  `test_meta_fields.py`, `test_variables.py`, `test_variable_value_drift.py`

If the task is about data sources or scans:
- `backend/src/tripl/api/v1/data_sources.py`
- `backend/src/tripl/api/v1/scans.py`
- `backend/src/tripl/services/datasource_service.py`
- `backend/src/tripl/services/scan_service.py`
- `backend/src/tripl/worker/tasks/scan.py`
- `backend/src/tripl/core/adapters/clickhouse.py`
- `backend/src/tripl/tests/test_data_sources.py`
- `backend/src/tripl/tests/test_scans.py`
- `frontend/src/pages/DataSourcesPage.tsx`
- `frontend/src/pages/ProjectSettingsPage.tsx`

If the task is about metrics or anomaly detection:
- `backend/src/tripl/api/v1/metrics.py`
- `backend/src/tripl/api/v1/metrics_catalog.py`
- `backend/src/tripl/api/v1/fact_tables.py`
- `backend/src/tripl/services/metrics_service.py`
- `backend/src/tripl/services/metric_definition_service.py`
- `backend/src/tripl/services/metric_series_service.py`
- `backend/src/tripl/worker/tasks/metrics/`
- `backend/src/tripl/core/analyzers/anomaly_detector.py`
- `backend/src/tripl/models/event_metric.py`
- `backend/src/tripl/models/metric_anomaly.py`
- `backend/src/tripl/tests/test_metrics_api.py`
- `backend/src/tripl/tests/test_metrics_tasks.py`
- `backend/src/tripl/tests/test_anomaly_detector.py`
- `backend/src/tripl/tests/test_project_anomaly_settings.py`
- `frontend/src/pages/MonitoringDetailPage.tsx`
- `frontend/src/pages/metrics/`
- `frontend/src/pages/fact-tables/`
- `frontend/src/lib/metrics.ts`

If the task is about alerting:
- `backend/src/tripl/api/v1/alerting.py`
- `backend/src/tripl/services/alerting_service.py`
- `backend/src/tripl/schemas/alerting.py`
- `backend/src/tripl/worker/tasks/alerts*.py`
- `backend/src/tripl/worker/tasks/alerts_*.py`
- `backend/src/tripl/alert_templates.py`
- `backend/src/tripl/alerting_validation.py`
- `backend/src/tripl/models/alert_*.py`
- `backend/src/tripl/tests/test_alerting.py`
- `frontend/src/pages/alerting/`
- `frontend/src/api/alerting.ts`

If the task is about branches, revisions, or implementation tracking:
- `backend/src/tripl/api/v1/plan_branches.py`
- `backend/src/tripl/services/plan_branch_*.py`
- `backend/src/tripl/api/v1/project_tracker_config.py`
- `backend/src/tripl/worker/tasks/implementation_tickets.py`
- `frontend/src/pages/settings/BranchesTab.tsx`
- backend tests: `test_plan_branches.py`, `test_implementation_tickets.py`

If the task is about search or AI:
- `backend/src/tripl/api/v1/search.py`, `backend/src/tripl/api/v1/ai.py`
- `backend/src/tripl/services/search_service.py`,
  `backend/src/tripl/services/_search_documents.py`
- `backend/src/tripl/worker/tasks/search.py`
- `frontend/src/components/command-palette.tsx`
- backend tests: `test_search.py`, `test_search_incremental_reindex.py`,
  `test_search_embed_task.py`

## Practical Coding Guidance

Project-specific expectations:
- keep FastAPI routers thin; business rules go in services;
- use Celery for heavy, retryable, or scheduled analytics work;
- prefer extending existing adapters/analyzers/tasks rather than inventing parallel paths;
- preserve async request paths; sync DB access is already used inside worker tasks and is acceptable there;
- keep frontend API wrappers typed through `frontend/src/types/index.ts`;
- when changing schemas or payloads, update both backend Pydantic models and frontend TS types;
- if you change alert message variables or formats, update both backend template logic and `ProjectAlertingTab` helper UI;
- if you change scan or metrics summaries, check any frontend assumptions around `ScanJob.result_summary`.
- **update the docs when you change files**: any change to behavior, the HTTP API, config/env, or a user-facing feature must update the documentation site under `website/docs/` in the SAME change; regenerate the OpenAPI spec with `./bin/dump-openapi.sh` when the HTTP API changed.

Operational assumptions to preserve unless intentionally changing them:
- RabbitMQ is the Celery broker.
- PostgreSQL is the system of record for catalog, metrics, anomalies, and alert deliveries.
- Warehouses (ClickHouse, BigQuery, PostgreSQL) are read from external data sources and are not the app database.
- API, worker, and beat should all be runnable together via Compose.

## Commands

Prefer the root `Makefile` — run `make` (or `make help`) for the grouped list.
It wraps the underlying uv/pnpm/compose commands so common flows are one keystroke
from the repo root. The ones you'll reach for most:
- `make check` — every gate (lint + typecheck + tests), CI parity
- `make sync-types` — regenerate `backend/openapi.json` + `frontend/src/types/api.gen.ts` after any HTTP API change (guarded by `test_openapi_contract`)
- `make test-be ARGS="-k diff -v"` / `make test-fe ARGS=BranchesTab` — scoped tests
- `make dev` — full stack via `compose.dev.yaml` (watch mode)

The raw commands the targets wrap (still the source of truth):

Backend:
- `uv sync`
- `uv run pytest`
- `uv run ruff check`
- `uv run ruff format --check`
- `uv run mypy`

Frontend:
- `pnpm install`
- `pnpm lint`
- `pnpm test`
- `pnpm exec tsc --noEmit`

Compose:
- `docker compose up -d --build`
- `docker compose config`

Useful when changing DB schema:
- `uv run alembic upgrade head`

## Validation Expectations

Minimum checks before finishing:
- backend tests for touched backend domains;
- frontend tests for touched frontend domains;
- lint/type checks for the side you changed;
- `docker compose config` when Compose or env wiring changes.
- **docs updated**: behavior / API / config / feature changes are reflected in `website/docs/` (and `./bin/dump-openapi.sh` re-run if the HTTP API changed). Docs are not optional follow-up — they ship with the change.
- **API types synced**: any change to the HTTP API surface (routes, request/response models, status codes) must regenerate `backend/openapi.json` + `frontend/src/types/api.gen.ts` via `make sync-types` — `test_openapi_contract` fails on a stale snapshot, and the frontend types drift silently otherwise.

Extra checks expected for specific areas:
- scan/data-source changes: verify connection test or scan execution path;
- metrics/anomaly changes: verify at least one real collection path and anomaly output path;
- alerting changes: verify at least one delivery path and relevant template/validation behavior;
- schema contract changes: verify both backend schema and frontend type/client usage.

## PR Notes

Use PR title format:
- `[analytics] <Title>`

Always call out:
- API contract changes;
- event schema changes;
- queue/task/schedule changes;
- metrics or anomaly semantics changes;
- alerting channel/template changes;
- environment variable changes.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

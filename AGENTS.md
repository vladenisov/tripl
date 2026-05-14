# AGENTS.md

## What This Repo Is

`tripl` is an analytics tracking-plan and monitoring service.

Use it to:
- manage projects and tracking plans;
- define event types, fields, relations, meta fields, and reusable variables;
- store concrete catalog events with implementation/review/archive state;
- connect external analytics DBs, currently ClickHouse;
- run scan jobs that infer events and variables from real data;
- collect time-bucketed metrics;
- detect anomalies;
- route alert deliveries to notification channels.

The long-form product and architecture spec is in [PLAN.md](PLAN.md). This file is the fast navigation map for agents working in the codebase.

## Agent Workflow

If `agentmemory` MCP is available in the current session, use it for every task.
- if it's not started, start with `npx @agentmemory/agentmemory`
- recall relevant prior context before making assumptions, especially for ongoing work, prior decisions, and user preferences;
- save durable decisions, preferences, and important implementation findings when they are likely to matter in future sessions.

## Current Product Scope

Already implemented in code:
- event catalog CRUD;
- data sources and scan configs;
- async scan pipeline via Celery + RabbitMQ;
- auto-generated events from cardinality analysis;
- variable detection for high-cardinality values;
- metrics collection into PostgreSQL;
- anomaly detection for project total, event type, and event scopes;
- alerting with destinations, rules, delivery history, and message templating;
- frontend pages for catalog, settings, data sources, monitoring, and alerting.

Not a safe assumption unless you verify:
- auth and roles;
- tracking plan versioning;
- import/export;
- any local ClickHouse container.

## Stack And Runtime

Backend:
- Python `3.13`
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

Local runtime in [compose.yaml](compose.yaml):
- `postgres`
- `rabbitmq`
- `api`
- `celery-worker`
- `celery-beat`
- `frontend`

Important runtime facts:
- ClickHouse is external. The repo does not run it in Compose.
- `api` runs `alembic upgrade head` before `uvicorn`.
- Celery beat currently schedules metrics due-checks every 60 seconds.
- API health endpoint is `GET /health`.
- CORS is open in dev app setup.

## Environment Variables

Primary backend settings are in [backend/src/tripl/config.py](backend/src/tripl/config.py).

Connectivity:
- `DATABASE_URL`, `SYNC_DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`

Identity and secrets:
- `ENCRYPTION_KEY` — Fernet key for at-rest secrets. **Required** in non-debug mode.
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
- [PLAN.md](PLAN.md): product scope and longer architecture notes.
- [README.md](README.md): quick start and user-facing overview.
- [compose.yaml](compose.yaml): local runtime topology.
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
- `backend/src/tripl/worker/analyzers`: scan/anomaly analysis logic.
- `backend/src/tripl/worker/adapters`: analytics DB adapters.
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
- `Variable`: reusable placeholder such as `${user_id}`.

Catalog entities:
- `Event`: concrete expected event instance in the plan.
- `EventFieldValue`: field value attached to an event.
- `EventMetaValue`: meta value attached to an event.
- `EventTag`: freeform event tag.

Analytics and monitoring entities:
- `DataSource`: external analytics DB connection, currently ClickHouse.
- `ScanConfig`: saved scan definition. Important fields include `base_query`, `event_type_id`, `event_type_column`, `time_column`, `event_name_format`, `json_value_paths`, `cardinality_threshold`, `interval`.
- `ScanJob`: async execution record for a scan config.
- `EventMetric`: aggregated count buckets.
- `MetricAnomaly`: persisted anomaly bucket.
- `ProjectAnomalySettings`: anomaly detector thresholds and scope toggles.

Alerting entities:
- `AlertDestination`: channel config. Current supported types are `slack` and `telegram`.
- `AlertRule`: filters, thresholds, cooldown, include/exclude scope, and message templates.
- `AlertRuleState`: cooldown/state tracking.
- `AlertDelivery`: one queued/sent/failed delivery attempt.
- `AlertDeliveryItem`: matched anomaly items included in a delivery.

## API Map

Base prefix: `/api/v1`

Routers currently registered:
- `/projects`
- `/projects/{slug}/event-types`
- `/projects/{slug}/event-types/{event_type_id}/fields`
- `/projects/{slug}/relations`
- `/projects/{slug}/meta-fields`
- `/projects/{slug}/variables`
- `/projects/{slug}/events`
- `/projects/{slug}/data-sources`
- `/projects/{slug}/scans`
- `/projects/{slug}/anomaly-settings`
- `/projects/{slug}/alert-destinations`
- `/projects/{slug}/alert-deliveries`
- metrics routes under project, event, and event-type paths

Useful endpoint groups:
- Events: list/filter/create/update/delete, bulk create, bulk delete, reorder/move, tags.
- Data sources: CRUD plus connection test.
- Scans: CRUD, preview, run, list jobs, get job.
- Metrics:
  - `GET /projects/{slug}/events-metrics`
  - `POST /projects/{slug}/events/window-metrics`
  - `GET /projects/{slug}/metrics/total`
  - `GET /projects/{slug}/events/{event_id}/metrics`
  - `GET /projects/{slug}/event-types/{event_type_id}/metrics`
  - `GET /projects/{slug}/anomalies/signals`
- Alerting:
  - destinations CRUD
  - rules CRUD nested under a destination
  - deliveries list/detail

If you need exact request/response shapes, open the corresponding file in `backend/src/tripl/schemas` before digging into services.

## Frontend Route Map

Defined in [frontend/src/App.tsx](frontend/src/App.tsx):
- `/`: projects list
- `/data-sources`
- `/data-sources/:dsId`
- `/p/:slug`
- `/p/:slug/events`
- `/p/:slug/events/:tab`
- `/p/:slug/events/:tab/:eventId`
- `/p/:slug/events/detail/:eventId`
- `/p/:slug/monitoring/:scope/:id`
- `/p/:slug/settings`
- `/p/:slug/settings/:tab`

Main pages:
- `ProjectsPage`: project list/create.
- `EventsPage`: main catalog table, review/archive flows, metrics snippets, monitoring signals.
- `EventDetailPage` and `MonitoringDetailPage`: metric drilldowns.
- `ProjectSettingsPage`: event types, meta fields, relations, variables, monitoring, alerting, scans.
- `ProjectAlertingTab`: destinations, rules, templates, delivery history.
- `DataSourcesPage`: global data-source management.

Settings tabs currently include:
- `event-types`
- `meta-fields`
- `relations`
- `variables`
- `monitoring`
- `alerting`
- `scans`

## Async Pipeline Map

Scan flow:
1. A `ScanConfig` points to a `DataSource` and query.
2. API creates a `ScanJob`.
3. Celery task `tripl.worker.tasks.scan.run_scan` executes.
4. Adapter connects to ClickHouse.
5. Cardinality analysis decides low-cardinality vs variable-like fields.
6. Event generation creates or updates tracking-plan events and variables.
7. Job summary is written back to `ScanJob.result_summary`.

Metrics flow:
1. Beat schedules `tripl.worker.tasks.metrics.check_metrics_due` every 60s.
2. Due scan configs trigger collection.
3. Metrics are collected into `event_metrics`.
4. Anomalies are recalculated and persisted.
5. Alert deliveries may be created for matched rules.

Alert flow:
1. Metrics/anomaly pipeline identifies matched alert-rule conditions.
2. `AlertDelivery` and `AlertDeliveryItem` records are created.
3. Celery task `tripl.worker.tasks.alerts.send_alert_delivery` sends to destination.
4. Delivery status becomes `pending`, `sent`, or `failed`.

Current alert channel support:
- Slack webhook
- Telegram bot/chat

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
- `frontend/src/pages/ProjectSettingsPage.tsx`
- backend tests: `test_event_types.py`, `test_fields.py`, `test_relations.py`, `test_meta_fields.py`, `test_variables.py`

If the task is about data sources or scans:
- `backend/src/tripl/api/v1/data_sources.py`
- `backend/src/tripl/api/v1/scans.py`
- `backend/src/tripl/services/datasource_service.py`
- `backend/src/tripl/services/scan_service.py`
- `backend/src/tripl/worker/tasks/scan.py`
- `backend/src/tripl/worker/adapters/clickhouse.py`
- `backend/src/tripl/tests/test_data_sources.py`
- `backend/src/tripl/tests/test_scans.py`
- `frontend/src/pages/DataSourcesPage.tsx`
- `frontend/src/pages/ProjectSettingsPage.tsx`

If the task is about metrics or anomaly detection:
- `backend/src/tripl/api/v1/metrics.py`
- `backend/src/tripl/services/metrics_service.py`
- `backend/src/tripl/worker/tasks/metrics.py`
- `backend/src/tripl/worker/analyzers/anomaly_detector.py`
- `backend/src/tripl/models/event_metric.py`
- `backend/src/tripl/models/metric_anomaly.py`
- `backend/src/tripl/tests/test_metrics_api.py`
- `backend/src/tripl/tests/test_metrics_tasks.py`
- `backend/src/tripl/tests/test_anomaly_detector.py`
- `backend/src/tripl/tests/test_project_anomaly_settings.py`
- `frontend/src/pages/EventDetailPage.tsx`
- `frontend/src/pages/MonitoringDetailPage.tsx`
- `frontend/src/lib/metrics.ts`

If the task is about alerting:
- `backend/src/tripl/api/v1/alerting.py`
- `backend/src/tripl/services/alerting_service.py`
- `backend/src/tripl/schemas/alerting.py`
- `backend/src/tripl/worker/tasks/alerts.py`
- `backend/src/tripl/alert_templates.py`
- `backend/src/tripl/alerting_validation.py`
- `backend/src/tripl/models/alert_*.py`
- `backend/src/tripl/tests/test_alerting.py`
- `frontend/src/pages/ProjectAlertingTab.tsx`
- `frontend/src/api/alerting.ts`

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

Operational assumptions to preserve unless intentionally changing them:
- RabbitMQ is the Celery broker.
- PostgreSQL is the system of record for catalog, metrics, anomalies, and alert deliveries.
- ClickHouse is read from external data sources and is not the app database.
- API, worker, and beat should all be runnable together via Compose.

## Commands

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

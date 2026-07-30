---
title: Troubleshooting & FAQ
sidebar_position: 90
---

# Troubleshooting & FAQ

This page collects the failures people actually hit when running tripl, written
as **symptom → likely cause → fix** playbooks. Each cause is grounded in how the
worker, adapters, and startup checks actually behave — not guesswork.

Before you dig into a specific symptom, two facts explain most "nothing is
happening" reports:

- **The background worker and scheduler do the work, not the API.** Scans,
  metric collection, anomaly detection, and alert delivery all run as Celery
  tasks on the `celery-worker` container, dispatched on a schedule by
  `celery-beat`. If either container is down, the UI stays up but nothing
  progresses.
- **Scanning the catalog and collecting metrics are two different jobs.** A
  scan (`run_scan`) discovers events and fills the tracking plan. Metrics,
  anomalies, and alerts come from a separate, scheduled `collect_metrics` job.
  Running a scan does **not** produce time-series metrics by itself.

A quick health check for a Docker deployment:

```bash
docker compose ps
docker compose logs -f celery-worker
docker compose logs -f celery-beat
```

You want to see `postgres`, `rabbitmq`, `redis`, `app`, `celery-worker`, and
`celery-beat` healthy/running, and the `migrate` one-shot already exited
successfully (`Exited (0)` in `docker compose ps`).

---

## The browser repeatedly logs a realtime stream protocol error

**Symptom.** Project pages keep working, but Chrome repeatedly logs
`ERR_QUIC_PROTOCOL_ERROR 200 (OK)` for
`/api/v1/projects/{slug}/events/stream`.

**Cause.** The request is a long-lived Server-Sent Events stream. A `200`
means the response started successfully; the protocol error means an HTTP/3
edge or proxy then rejected or reset that stream. Make sure no intermediary
adds or forwards connection-specific headers such as `Connection` or
`Keep-Alive` on HTTP/2 or HTTP/3 responses.

**Fix.** Upgrade tripl to a version whose realtime endpoint does not emit
connection-specific headers, and verify the edge preserves
`Content-Type: text/event-stream`, disables response buffering, and allows a
streaming response to remain open without applying response compression. The
endpoint sends a heartbeat every 15 seconds, so an edge idle timeout comfortably
above that value should not close healthy streams. While disconnected, the
frontend falls back to polling and reconnects with exponential backoff.

---

## No metrics appear after a scan

**Symptom.** A scan finished and the catalog filled with events, but the
monitoring charts stay empty and no anomalies or alerts ever show up.

**Likely causes.**

1. **The scan config has no `interval` or no `time_column`.** The dispatcher
   (`check_metrics_due`) only ever selects configs where **both**
   `interval` and `time_column` are set. A config missing either is silently
   skipped — it will never collect metrics, only catalog events.
2. **`celery-beat` is not running.** Metric collection is triggered by the
   beat schedule entry `check-metrics-due`, which fires every 300 seconds. With
   no beat container, `collect_metrics` is never dispatched.
3. **The first complete bucket hasn't closed yet.** On the very first run (no
   prior metric bucket) the dispatcher collects immediately; after that it only
   fires once a *new complete* interval bucket exists — the latest complete
   bucket is `floor(now) - interval`. For a 6h interval you may wait up to 6
   hours for the next point to appear.
4. **The time column doesn't actually constrain the window.** Metrics are
   bucketed on `time_column`. If the column isn't a usable timestamp in the
   warehouse, the windowed query returns nothing to bucket.
5. **The worker can't reach the warehouse.** `collect_metrics` connects to your
   data source the same way a scan does; a broken connection fails the job (see
   [A scan job fails](#a-scan-job-fails--a-data-source-connection-test-fails)).

**Fix.**

- Open the scan config and confirm both an **interval** and a **time column**
  are set. Save, then wait one beat cycle (≤ 5 minutes) or trigger a collection
  manually from the UI.
- Confirm beat is alive:

  ```bash
  docker compose logs --tail=50 celery-beat
  docker compose logs --tail=100 celery-worker | grep check_metrics_due
  ```

  You should see lines like `check_metrics_due: N configs checked, M dispatched`
  and `Dispatching collect_metrics for '<name>' (interval=...)`.
- If you just created the config and it's a long interval, give it one full
  interval before expecting a second data point.

:::note
Each scan config runs at most one active collection job at a time. If a previous
job is genuinely stuck (worker OOM/redeploy with no heartbeat), the dispatcher
marks it failed after **75 minutes** without progress and lets the next run
proceed — so a wedged job self-heals within that window rather than blocking
collection forever.
:::

---

## Alerts never fire

**Symptom.** Anomalies show up in the monitoring view (or you expect them to),
but no Slack/Telegram/email/webhook/Jira/Linear notification ever arrives.

The delivery chain is: `collect_metrics` → recalculate anomalies → match rules
and create `AlertDelivery` rows (`pending`) → `send_alert_delivery` actually
sends. A break anywhere in that chain produces silence.

**Likely causes & fixes.**

1. **No anomaly was detected.** Detection is statistical, not a fixed
   threshold. A series needs enough history before the seasonal (phase) baseline
   engages — until then it falls back to a rolling baseline that itself needs
   `min_history_buckets` of data, and low-volume series below `min_expected_count`
   are skipped entirely so noise doesn't flood you. Brand-new scans, sparse data,
   or a too-high `sigma_threshold` all legitimately produce zero anomalies.
   Review the project's anomaly settings (baseline window, sigma threshold,
   minimum expected count) and let more history accumulate.
2. **No enabled alert destination.** If the project has no destinations, or
   none are enabled, no deliveries are created. Add and enable a destination.
3. **No enabled rule, or the rule doesn't match.** A destination with no
   enabled rules is skipped. A rule only fires for anomalies it matches
   (by scope/direction/etc.). Check the rule is enabled and its scope covers the
   anomaly you expect.
4. **Cooldown or correlation suppression.** A rule won't re-notify the same
   scope until its `cooldown_minutes` elapses. Correlation groups you've marked
   **resolved**, **false positive**, or **muted** are suppressed; a mute auto-
   expires at its `muted_until` time. If you muted/resolved a group, that's why.
5. **Email destination but SMTP isn't configured.** Email sends fail with:
   *"Email destination is configured but SMTP is not — set SMTP_HOST (and
   SMTP_USERNAME/SMTP_PASSWORD if your relay requires auth)."* Set `SMTP_HOST`,
   plus `SMTP_FROM_ADDRESS` or a per-destination From: address. The worker reads
   SMTP settings at send time, so a config change takes effect without
   recreating the destination.
6. **Destination credentials are invalid.** Slack/Telegram/webhook/Jira/Linear
   each re-validate their secret at send time; on failure the delivery is marked
   `failed` with a message like *"Slack destination configuration is invalid.
   Update the webhook URL."* Check the failed delivery's error in the UI/logs.
7. **The delivery was stranded.** If the worker died between creating the
   `pending` delivery and dispatching it, or the broker was down at dispatch, a
   maintenance task (`requeue_stranded_alert_deliveries`, every 5 minutes)
   re-enqueues deliveries still `pending` after 15 minutes, up to 5 attempts,
   then marks them `failed`. A permanently failing delivery will eventually stop
   cycling and show as failed.

**Fix workflow.**

```bash
# collect_metrics logs its result, including how many deliveries it queued:
docker compose logs --tail=200 celery-worker | grep -iE "collect_metrics|alerts_queued"
# Why did a specific send fail? The error is persisted on the delivery and logged:
docker compose logs --tail=200 celery-worker | grep "Failed to send alert delivery"
```

:::tip
Use the in-app rule simulator to confirm a rule matches a given anomaly before
blaming delivery — the simulator and the live pipeline share the same matcher
(`tripl.alerting_matching`), so if it doesn't match in the simulator it won't
match live either.
:::

---

## A scan job fails / a data-source connection test fails

**Symptom.** A scan job ends in `failed`, or the **Test connection** button on a
data source returns an error.

**How errors are surfaced.** Raw driver/ORM exceptions embed hostnames, ports,
and library names, so tripl never shows them verbatim. User-facing fields get a
sanitized summary instead:

- *"Scan failed: the data source did not respond in time."* — a timeout.
- *"Scan failed: could not connect to the data source."* — connection refused,
  DNS failure, network unreachable, reset, etc.
- *"Scan failed due to an internal error."*
  — anything else.

The full exception (with host/port/driver detail) is only in the **worker
logs**, so always check there first:

```bash
docker compose logs --tail=200 celery-worker | grep -iE "scan failed|connection"
```

A handful of conditions are surfaced **verbatim** because they're actionable:

- **Row limit reached.** *"Scan query reached configured row limit (50000);
  increase scan_row_limit to avoid partial generation."* The default cap is
  50,000 rows for scans (100,000 for metrics). Narrow the base query, set a
  time column + lookback so less data is scanned, or raise the per-config row
  limit. Catalog-metric collection reports the same condition as *"… reached the
  metric query row limit (100000) for chunk …"* and **fails the chunk on
  purpose**: collection replaces a window by deleting it and re-inserting, so
  writing a capped result would erase the tail of the window rather than leave
  it as it was. Narrow the metric's breakdown or replay in shorter chunks.
- **Misconfigured event typing.** *"Either event_type_id or event_type_column
  must be specified."* Pick a single event type for the config, or set the
  column that splits rows into event types.

**Likely causes & fixes for connection failures.**

| Adapter | Common cause | Fix |
| --- | --- | --- |
| **PostgreSQL** | TLS negotiation or unreachable host. Non-local hosts default to **`sslmode=require`**, so a remote server with no TLS fails loudly rather than silently falling back to plaintext; localhost defaults to `prefer`. | Confirm host/port reachable from the worker container; check the server's TLS settings. A remote server that genuinely has no TLS needs `sslmode` set explicitly to `prefer`/`disable` on the data source. |
| **ClickHouse** | Wrong host/port/secure flag, or a probe query that returns no rows. | Verify connection params; *"Connection probe returned no rows"* means it connected but the probe was empty — check the query/permissions. |
| **BigQuery** | Missing project id or invalid service-account JSON: *"BigQuery: host (project_id) is required"* / *"BigQuery: service-account JSON credentials are required"* / *"BigQuery: invalid service-account JSON"*. | Set the project id in the host field and paste valid service-account JSON. |

The async **Test connection** persists `last_test_status` and a sanitized
`last_test_message` on the data source and invalidates the cached list, so the
result you see in the UI is the worker's actual probe — not a stale value.

The scan detail shows this curated error beside the failed run. Identical recent
failures collapse into a **failed last N runs** streak; expand it when you need
the individual attempts. After fixing the source/query/configuration, use **Run
again** on the failed config. This creates a new job and preserves the earlier
failure history.

:::note A config that keeps failing slows down on its own
Scheduled collection is due whenever a new complete bucket exists, and a run that
fails writes no bucket — so a broken config used to be retried on every dispatcher
tick (every five minutes) no matter what its interval said. After three
consecutive failures it now waits instead, roughly doubling the gap each time,
never longer than 24 hours and never shorter than the config's own interval.

Two consequences worth knowing: a fixed config can take up to that wait before it
retries by itself — press **Run again** if you don't want to wait — and the
backoff only counts *scheduled* runs, so your manual runs neither trigger it nor
clear it.
:::

:::note
Scan tasks have a hard time limit of 60 minutes (the worker's default) and do
**not** retry automatically (`max_retries=0`). Metrics collection gets a much
longer hard limit (25 hours) so a long historical replay isn't killed mid-run —
but it also doesn't retry. A genuinely slow warehouse query is killed at the
limit rather than retried; shrink the window or row count instead of waiting it
out.
:::

---

## A branch merge is blocked

**Symptom.** Merging a plan branch returns an error instead of merging.

**Likely causes** (each maps to a specific API error):

| Error | Meaning | Fix |
| --- | --- | --- |
| `400 Branch is already merged` | The branch was merged previously. | Nothing to do; open a new branch for further changes. |
| `409 Branch must be approved before merging` | The branch isn't in the approved state. | Get the required approvals first. |
| `409 incomplete_base_snapshot` | The branch was created before complete merge baselines were available, so a safe three-way merge is impossible. | Recreate the branch from current main and reapply the intended changes. |
| `409 conflicts` | Both sides changed the same state differently, or one side deleted a parent while the other added/changed a child. These are **hard blockers** unless listed as field-level resolutions. | Reconcile manually: recreate the branch from current main, or remove the conflicting change. |
| `409 unresolved_field_conflicts` | An event-type **field** was changed on both branch and main relative to the base. | Resolve each field inline (choose **ours**/**theirs**) in the conflict view, then merge again. |
| `409 missing_owner_approvals` | The branch touches an **owned** event type without that owner's approval. | Request approval from the listed owner(s) before merging. |

**Fix.** Field-level (modify/modify) conflicts on event types are resolvable
through the inline resolution flow. Entity-level add/remove conflicts and
conflicts on other entity kinds are not covered by inline resolution — rebase
the branch onto current main and redo the change, or drop it.

---

## Migration or startup failure

**Symptom.** The `app` (or `migrate`) container exits on boot, or the API
refuses to start.

### Production startup checks failed

In non-debug (production) mode the API runs `assert_production_ready()` during
startup and **refuses to boot** with `RuntimeError: Production startup checks
failed:` followed by a bulleted list. Each bullet is a missing/unsafe setting:

- **`ENCRYPTION_KEY` is empty or not a valid Fernet key.** Data-source and
  alert secrets would be stored as plaintext. Generate one:

  ```bash
  python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
  ```

- **`SECRET_KEY` is empty.** Session token hashes would be unkeyed. Generate:

  ```bash
  python -c 'import secrets; print(secrets.token_urlsafe(32))'
  ```

- **`SESSION_COOKIE_SECURE=false` in production.** Set it `true` when serving
  over HTTPS (the production compose stack already does).
- **CORS resolves to empty or to the wildcard `*`.** Set `CORS_ALLOW_ORIGINS`
  or `APP_BASE_URL` to your explicit frontend origin. A wildcard breaks
  cookie-based auth because browsers reject credentialed requests against `*`.
- **A connection URL still uses the dev defaults** (`tripl:tripl` or
  `guest:guest`). Set real credentials for `DATABASE_URL`, `SYNC_DATABASE_URL`,
  and `RABBITMQ_URL`.

The production compose file wires these from `.env` and will refuse to even
render if `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`, `ENCRYPTION_KEY`,
`SECRET_KEY`, or `APP_BASE_URL` are unset. See
[Configuration](../run/configuration) and [Deployment](../run/deployment).

### Schema migration failed

In production, schema upgrades run **once** via the `migrate` one-shot
(`alembic upgrade head`) *before* the app and workers start — `app`,
`celery-worker`, and `celery-beat` all wait for
`migrate: service_completed_successfully`. If `migrate` fails, the app never
starts. Inspect it:

```bash
docker compose logs migrate
```

Common causes: the database isn't reachable yet (`migrate` waits for
`postgres` to be healthy), or a migration can't apply against the existing
schema. Fix the underlying DB/connection issue and re-run
`docker compose up -d` — the one-shot retries the upgrade.

:::warning
Running multiple app/worker replicas never races the upgrade because the
one-shot `migrate` gate runs first. Don't add `alembic upgrade` to the app or
worker start command in production — that reintroduces the race the one-shot
exists to prevent.
:::

For local development the `api` service runs `alembic upgrade head` itself before
starting uvicorn. If a script shebang is broken after a directory rename, call
the module directly: `uv run python -m alembic upgrade head`.

---

## RabbitMQ or PostgreSQL connection errors

**Symptom.** The worker/beat logs show repeated broker connection errors, tasks
never run, or the API logs database connection errors.

### RabbitMQ (the Celery broker)

- The broker URL comes from `RABBITMQ_URL` (e.g.
  `amqp://tripl:<password>@rabbitmq:5672//`). In production it must **not** use
  the `guest:guest` dev default — the startup check rejects it.
- Celery is configured to **retry the broker connection on startup**
  (`broker_connection_retry_on_startup = True`), so a worker that boots before
  RabbitMQ is ready keeps trying rather than crashing. Persistent failures mean
  the broker is genuinely unreachable or the credentials are wrong.
- In compose, `celery-worker` and `celery-beat` wait for
  `rabbitmq: service_healthy` (a `rabbitmq-diagnostics ping` health check). If
  RabbitMQ never becomes healthy, those services won't start.

```bash
docker compose ps rabbitmq
docker compose logs --tail=80 rabbitmq
docker compose logs --tail=80 celery-worker | grep -i amqp
```

:::note
The broker's `consumer_timeout` in
[`infra/rabbitmq/rabbitmq.conf`](https://github.com/vladenisov/tripl/blob/main/infra/rabbitmq/rabbitmq.conf)
is raised to 26 hours — above the `collect_metrics` hard time limit (25 hours) —
so a long metrics replay that holds its delivery unacked for the whole run isn't
force-requeued mid-run. If you replace that config, keep the consumer timeout
above the `collect_metrics` time limit or long replays will be redelivered and
run twice as duplicate, competing executions.
:::

### PostgreSQL (application database)

- The async API uses `DATABASE_URL`
  (`postgresql+asyncpg://...`); Celery workers use `SYNC_DATABASE_URL`
  (`postgresql+psycopg://...`). **Both** must point at the same database with
  real credentials. A worker that can't reach Postgres can't claim jobs or write
  results, even if the API is fine.
- The connection pools use pre-ping, so a connection dropped by the DB
  (restart, idle timeout) is detected and replaced transparently — you don't
  normally need to restart workers after a brief Postgres blip.
- In compose, services wait for `postgres: service_healthy`
  (`pg_isready -U tripl`).

```bash
docker compose ps postgres
docker compose logs --tail=80 postgres
docker compose exec postgres pg_isready -U tripl
```

If the API starts but the worker errors, double-check that **both** URLs are
set and use the right driver prefix (`+asyncpg` for the API, `+psycopg` for the
worker).

:::tip
Redis is optional. `REDIS_URL` being empty disables caching (every read falls
through to the database) but does not break anything — so Redis connection
problems degrade performance, they don't stop scans, metrics, or alerts.
:::

---

## FAQ

**Do I need to run scans on a schedule to get metrics?**
No. A scan fills the catalog. Metrics, anomalies, and alerts come from the
scheduled `collect_metrics` job, which runs automatically for any scan config
that has both an interval and a time column — driven by `celery-beat`, no manual
trigger needed.

**Why is my brand-new scan config not flagging any anomalies?**
Anomaly detection needs history. Until enough buckets accumulate, the detector
uses a rolling fallback and skips low-volume series; with very little data it
will correctly report nothing. Give it time, and check the project's anomaly
settings (sigma threshold, minimum expected count, baseline window).

**A scan failed with a generic "internal error" — where's the real reason?**
User-facing fields are sanitized to avoid leaking host/port/driver details. The
full exception is in the worker logs:
`docker compose logs celery-worker`.

**My alert never arrived but the UI shows an anomaly. What now?**
Walk the delivery chain in [Alerts never fire](#alerts-never-fire): destination
enabled? rule enabled and matching? cooldown/mute? (email) SMTP set? Then check
the worker logs for `Failed to send alert delivery` — the failure reason is
persisted on the delivery.

**The app won't start after I set `DEBUG` off.**
That's the production readiness gate. Read the `Production startup checks
failed` bullet list in the logs and set each missing secret/origin. See
[Migration or startup failure](#migration-or-startup-failure).

**Can I retry a failed scan automatically?**
No. Scan, metrics, and connection-test tasks use `max_retries=0` — a failure is
final for that run. Fix the underlying cause (connection, row limit, query) and
click **Run again**. Stranded *alert deliveries* are the exception: those are
re-enqueued automatically by the maintenance reaper.

**Why did a deleted variable come back after the next scan?**
The scan rediscovered its warehouse column or JSON-path binding. Delete removes
the plan row, while **Exclude from scans** keeps a tombstone that prevents
recreation and stops new contexts/drift. Open **Plan → Variables**, exclude the
variable, and use **Restore** if the decision changes later.

**Why does a variable show value drift?**
The scan observed values outside the effective documented list (the event
override when present, otherwise the global list). Review it from Variables or
the event detail: accept globally, accept for that event, snooze, or mark false
positive. See [Variables & templates](./variables-and-templates.md).

**Where do I configure SMTP, encryption keys, and connection URLs?**
All via environment variables / `.env`. See [Configuration](../run/configuration)
for the full list and [Deployment](../run/deployment) for the compose stack.
The authoritative defaults live in
[`backend/src/tripl/config.py`](https://github.com/vladenisov/tripl/blob/main/backend/src/tripl/config.py).

**How do I run the database migration by hand?**
In the running stack: `docker compose run --rm migrate`. Locally in the backend:
`uv run alembic upgrade head` (or `uv run python -m alembic upgrade head` if the
console script shebang is broken).

---

## Still stuck?

Collect the relevant logs and open an issue on
[GitHub](https://github.com/vladenisov/tripl/issues). Useful context to include:

```bash
docker compose ps
docker compose logs --tail=300 celery-worker
docker compose logs --tail=100 app
docker compose logs --tail=100 migrate
```

Redact any secrets before sharing. tripl already keeps host/port/credential
detail out of user-facing fields, but raw logs may contain connection strings.

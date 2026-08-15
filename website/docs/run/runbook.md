---
title: Operations Runbook
sidebar_position: 4
---

# Operations Runbook

Operational procedures for running the self-hosted tripl stack defined in
[`compose.yaml`](https://github.com/vladenisov/tripl/blob/main/compose.yaml):
backups and restore, disaster recovery, horizontal scaling, health checks,
rollback, and post-deploy verification.

For first-time install and the full service/env reference, see
[Deployment](./deployment.md). For symptom-driven debugging, see
[Troubleshooting](../use/troubleshooting.md).

## Stack at a glance

The production stack runs the single published image
(`${TRIPL_IMAGE:-ghcr.io/vladenisov/tripl}:${TRIPL_VERSION:-latest}`) in
several roles — only the command differs:

| Service | Image / command | Persistence | Docker healthcheck |
| --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:0.8.2-pg18-trixie` | **Durable** — named volume `pgdata18` | `pg_isready -U tripl` |
| `rabbitmq` | `rabbitmq:3.13-management` | **Ephemeral** — no data volume | `rabbitmq-diagnostics -q ping` |
| `redis` | `redis:8.6.2-alpine` (`--maxmemory 256mb --maxmemory-policy allkeys-lru --save ""`) | **Ephemeral** — no volume, no RDB/AOF | `redis-cli ping` |
| `migrate` | `alembic upgrade head` (one-shot) | — | — |
| `app` | API + built SPA on `:8000` | — | **None** (probe externally — see [Health checks](#health-checks)) |
| `celery-worker` | `celery -A tripl.worker.celery_app worker --loglevel=info` | — | **Disabled** (`healthcheck.disable: true`) |
| `celery-beat` | `celery -A tripl.worker.celery_app beat --loglevel=info --schedule /tmp/celerybeat-schedule` | — | **Disabled** (`healthcheck.disable: true`) |

`migrate` runs once before `app`, `celery-worker`, and `celery-beat` start: they
all declare `depends_on: migrate: condition: service_completed_successfully`, so
a multi-worker deploy never races the schema upgrade.

:::note
PostgreSQL is the **only** stateful service with a durable volume (`pgdata18`,
mounted at `/var/lib/postgresql`, with `PGDATA=/var/lib/postgresql/18/docker`).
Redis is a cache and RabbitMQ has no data volume in `compose.yaml` — both are
intentionally ephemeral. Your backup strategy only needs to cover PostgreSQL.
:::

## PostgreSQL backup & restore

The `postgres` service runs as user `tripl` with database `tripl`. All commands
below run against the running container; run them from the directory containing
`compose.yaml`.

### Logical backup (recommended)

Custom-format dump (compressed, supports selective restore). `-T` disables
pseudo-TTY allocation so the stream pipes cleanly to a file:

```bash
docker compose exec -T postgres \
  pg_dump -U tripl -Fc tripl > tripl-$(date +%F).dump
```

Plain-SQL alternative, gzipped:

```bash
docker compose exec -T postgres \
  pg_dump -U tripl tripl | gzip > tripl-$(date +%F).sql.gz
```

### Restore

For a custom-format (`-Fc`) dump, into the existing `tripl` database, dropping
objects first so the restore is idempotent:

```bash
docker compose exec -T postgres \
  pg_restore -U tripl -d tripl --clean --if-exists --no-owner < tripl-2026-06-27.dump
```

For a plain-SQL dump:

```bash
gunzip -c tripl-2026-06-27.sql.gz | \
  docker compose exec -T postgres psql -U tripl -d tripl
```

:::warning
Restoring into a live database can conflict with the app and workers. For a
clean restore, stop the application tier first and bring it back afterwards:

```bash
docker compose stop app celery-worker celery-beat
# ... run pg_restore / psql ...
docker compose start app celery-worker celery-beat
```
:::

### Cold volume backup (alternative)

To snapshot the raw `pgdata18` volume instead of a logical dump, stop PostgreSQL
first so the data files are consistent, then archive the volume:

```bash
docker compose stop postgres
docker run --rm \
  -v tripl_pgdata18:/var/lib/postgresql \
  -v "$PWD":/backup alpine \
  tar czf /backup/pgdata18-$(date +%F).tar.gz -C /var/lib/postgresql .
docker compose start postgres
```

The Compose project prefixes the volume name (commonly `tripl_pgdata18`); confirm
with `docker volume ls`.

## Disaster recovery

Recovery hinges on the durable/ephemeral split:

- **PostgreSQL (`pgdata18`) — durable, must be restored.** This holds tracking
  plans, data sources, scan history, metrics, alerts, and user accounts. Restore
  it from your latest dump (above) on a fresh host before starting the app tier.
- **Redis — ephemeral cache, rebuilds itself.** It runs with `--save ""` and no
  volume, so a restart starts empty. The app degrades gracefully: reads fall
  through to PostgreSQL and the cache repopulates. (In `compose.yaml`,
  `REDIS_URL` points at the `redis` service; an empty `REDIS_URL` disables
  caching entirely, with every read going to the DB.)
- **RabbitMQ — ephemeral broker.** With no data volume, queued messages do not
  survive a broker restart. Celery is configured with `task_acks_late=True` and
  `task_reject_on_worker_lost=True` (see
  [`celery_app.py`](https://github.com/vladenisov/tripl/blob/main/backend/src/tripl/worker/celery_app.py)),
  which re-queues a task when a **worker** crashes mid-execution — but that does
  not protect messages already sitting in the broker if **RabbitMQ itself** is
  lost. Recurring work is self-healing: `celery-beat` re-enqueues scheduled jobs
  (metric checks every 5 minutes, stranded-delivery requeue every 5 minutes,
  schema-drift cleanup daily, weekly plan digest), so a missed tick is picked up
  on the next interval.
- **`celery-beat` schedule file** lives at `/tmp/celerybeat-schedule` inside the
  beat container and is regenerated on start — nothing to back up.

### Recovery procedure (fresh host)

```bash
# 1. Restore .env (secrets: POSTGRES_PASSWORD, RABBITMQ_PASSWORD,
#    ENCRYPTION_KEY, SECRET_KEY, APP_BASE_URL) and compose.yaml.
# 2. Pull the same image tag that produced the backup.
docker compose pull
# 3. Bring up only PostgreSQL and restore the dump.
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U tripl -d tripl --clean --if-exists --no-owner < tripl-LATEST.dump
# 4. Start the rest (migrate runs alembic upgrade head, then app + workers).
docker compose up -d
```

:::danger
`ENCRYPTION_KEY` is the Fernet key that decrypts stored data-source and
alert-destination secrets. If it is lost, those encrypted columns are
**unrecoverable** even with a perfect database backup. Store it with the same
care as the database backups themselves.
:::

## Horizontal scaling

### Scaling Celery workers

Each worker process opens one shared sync SQLAlchemy engine + connection pool on
first use (see
[`worker/db.py`](https://github.com/vladenisov/tripl/blob/main/backend/src/tripl/worker/db.py)),
and runs with `worker_prefetch_multiplier=1` so one slow task can't hoard the
queue while peers idle. Scale out by adding replicas:

```bash
docker compose up -d --scale celery-worker=3
```

Account for the extra database connections (each worker process holds a pool)
when sizing PostgreSQL `max_connections`. Long tasks are bounded by a 55-minute
soft limit (`SoftTimeLimitExceeded`, allows cleanup) and a 60-minute hard limit.

### Scaling the app tier — rate-limit caveat

The auth rate limiter (`/auth/login`, `/auth/register`) is an **in-memory
token-bucket, per worker process**, keyed on `(client_ip, route)` — see
[`middleware/rate_limit.py`](https://github.com/vladenisov/tripl/blob/main/backend/src/tripl/middleware/rate_limit.py).
Defaults are 5 login attempts/minute and 3 registrations/hour
(`rate_limit_login_per_minute`, `rate_limit_register_per_hour`).

:::warning Per-replica limits do not aggregate
Because the buckets live in process memory, running **N** app replicas (or
multiple Uvicorn workers) multiplies the effective limit: with `--scale app=N`
the practical login ceiling is roughly `N × 5/min`, since each replica enforces
its own bucket. To enforce a true global limit, terminate rate limiting at a
fronting load balancer / reverse proxy, or replace the in-memory bucket with a
shared (e.g. Redis-backed) store.
:::

If you do put a trusted proxy in front, set `RATE_LIMIT_TRUST_FORWARDED_FOR=true`
(default `false`) so the limiter keys on the real client IP. It prefers
`X-Real-IP`, falling back to the leftmost `X-Forwarded-For` entry. Enable this
**only** behind a proxy that overwrites `X-Real-IP` on every request — a raw
`X-Forwarded-For` on a directly-exposed API is attacker-controlled and lets a
caller rotate the header to land each request in a fresh bucket. When the app is
the edge (the default single-container deploy), leave it at `false` so the
direct socket peer (`request.client.host`) is used.

## Health checks

The app exposes `GET /health` — an unauthenticated liveness + DB-reachability
probe. It runs `SELECT 1` against PostgreSQL with a 1-second timeout:

- **Healthy:** HTTP `200` with body `{"status":"ok"}`.
- **DB unreachable:** HTTP `503` with body `{"status":"error","component":"database"}`.

```bash
curl -fsS http://localhost:8000/health
# {"status":"ok"}
```

:::note
The `app` service has **no Docker healthcheck** in `compose.yaml`, and the
`celery-worker` / `celery-beat` healthchecks are explicitly disabled. Wire
`GET /health` into your external monitor or orchestrator probe rather than
relying on `docker compose ps` health status for the app. `/health`,
`/api/v1/*`, `/metrics`, and `/docs` take precedence over the SPA fallback, so
the probe path is always served by the API.
:::

Worker and beat liveness are best checked from logs and broker state:

```bash
docker compose logs --tail=50 celery-worker
docker compose logs --tail=50 celery-beat
```

The Prometheus `/metrics` endpoint is only mounted when
`PROMETHEUS_METRICS_ENABLED=true` (off by default); expose it behind an
internal-only path.

## Rollback / downgrade

Releases are image-tagged. To roll back the application, pin `TRIPL_VERSION` to a
prior released tag in `.env`, pull, and recreate:

```bash
# .env
TRIPL_VERSION=1.3.0

docker compose pull
docker compose up -d
```

:::danger Migrations are forward-only
The `migrate` one-shot runs `alembic upgrade head` — it **never downgrades**.
Pulling an older image does **not** revert schema changes that a newer release
applied. If the version you are rolling back to predates a migration, the old
code may be incompatible with the upgraded schema.

If you must reverse a schema change, run the Alembic downgrade explicitly with a
one-off container **before** starting the older app (override the `migrate`
service's command):

```bash
docker compose run --rm migrate alembic downgrade <target_revision>
```

Take a fresh backup first (see [Backup & restore](#postgresql-backup--restore))
— for non-trivial rollbacks, restoring a pre-upgrade dump is often safer than a
downgrade migration. Validate the rollback in staging where possible.
:::

## Post-deploy verification

After any `docker compose up -d` (deploy, rollback, or recovery):

1. **Migration completed.** The one-shot must have exited cleanly:

   ```bash
   docker compose ps -a migrate          # State should be "Exited (0)"
   docker compose logs migrate           # ends with the upgrade head output
   ```

2. **Core services up and healthy.**

   ```bash
   docker compose ps
   # postgres / rabbitmq / redis: Up (healthy)
   # app / celery-worker / celery-beat: Up
   ```

3. **API health probe passes.**

   ```bash
   curl -fsS http://localhost:8000/health   # {"status":"ok"}
   ```

4. **Workers are processing.** Confirm the worker connected to the broker and
   beat is emitting ticks:

   ```bash
   docker compose logs --tail=30 celery-worker   # "celery@... ready"
   docker compose logs --tail=30 celery-beat     # "Scheduler: Sending due task ..."
   ```

5. **App logs are clean.** No repeated tracebacks or production-startup-check
   failures (`assert_production_ready` refuses to boot with missing secrets or
   dev-default credentials):

   ```bash
   docker compose logs --tail=50 app
   ```

If any step fails, see [Troubleshooting](../use/troubleshooting.md) for
symptom-driven diagnosis, or roll back per the section above.

### One-off: rebuild the search index after the ranking release

:::warning Required once, per project **and** per plan branch
The release that fixed search ranking changed **what text is indexed** for a
document — harvested field values left a variable's keywords, and every
snake_case / dotted identifier gained a spaced alias. The migration that ships
with it re-tokenizes the text already stored, but it does **not** rebuild that
text. Until a branch is rebuilt, its documents are ranked on the old text, and a
branch where some rows have been rebuilt and others have not is ranked on both
at once.
:::

Most branches repair themselves: **any** write to an event, event type, field,
meta field, variable, relation, metric or fact table rebuilds that branch's
whole index, as do a plan-branch merge, a demo reset, and the scan/catalog
refresh the Celery worker runs. An actively used project needs nothing from you.

Branches nobody writes to — archived plan branches, projects kept for reference
— keep the old documents indefinitely. Rebuild those explicitly:

```bash
# Editor role or above. Once per project AND per plan branch.
# $TRIPL_API_KEY is a write-scoped personal API key (tk_w_…), see Security.
curl -fsS -X POST \
  -H "Authorization: Bearer $TRIPL_API_KEY" \
  "http://localhost:8000/api/v1/projects/<slug>/search/reindex?branch_id=<branch_id>"
# -> {"documents_indexed": N, "embeddings_scheduled": true|false}
```

This is intentionally **not** done for you by the migration. Rebuilding drops
and re-inserts the affected rows, which discards their stored embeddings — with
`SEARCH_EMBEDDINGS_ENABLED=true` that means the catalog is re-embedded against
your provider, at your cost. Deciding when to pay that is an operator call, not
a side effect of `alembic upgrade head`. With embeddings disabled (the default)
a rebuild is free apart from the CPU it takes.

Verify by searching for an entity whose name contains an underscore, using a
space instead (`screen spot` for `screen_spot`): the entity itself should come
back first rather than the variables that merely mention it.

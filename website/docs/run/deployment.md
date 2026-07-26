---
title: Self-hosting & Deployment
sidebar_position: 1
---

# Self-hosting & Deployment

tripl ships as **one image** that serves the JSON API and the built React SPA from a single process. The same image is reused for the API, a one-shot database migration, and the Celery worker and beat scheduler — only the launch command differs. The default `compose.yaml` runs the **published release image**; there is no source build on the deploy host.

This page covers running that stack in production: prerequisites, generating secrets, the services in `compose.yaml`, connecting a warehouse, and upgrades.

:::note
For tuning individual settings (logging, rate limits, metrics, AI/search features), see [configuration](./configuration). When something does not come up, see [troubleshooting](../use/troubleshooting).
:::

## Prerequisites

- **Docker Engine** with the Compose v2 plugin (`docker compose`, not the legacy `docker-compose`).
- **A TLS terminator in front of the app.** The production stack forces secure session cookies on and refuses dev-default credentials, so it expects to sit behind HTTPS. Terminate TLS in front of port `8000` (reverse proxy, load balancer, or platform ingress) and use an `https://` `APP_BASE_URL`. To preview the app over plain HTTP locally, use the dev stack instead (see [Local preview](#local-preview)).
- **Files on the deploy host:** `compose.yaml`, your `.env`, and the `infra/rabbitmq/` directory (the RabbitMQ service mounts `infra/rabbitmq/rabbitmq.conf`).
- **Outbound access to GHCR** (`ghcr.io`) to pull the image. If the package is private you must `docker login ghcr.io` first; see [Registry access](#registry-access).
- **A data warehouse to monitor** — ClickHouse, BigQuery, or PostgreSQL. This is connected from the UI after the stack is up, not via environment variables (see [Connecting a warehouse](#connecting-a-warehouse)).

### Rough resource sizing

`compose.yaml` defines **seven services**: `postgres`, `rabbitmq`, `redis`, the one-shot `migrate`, `app`, `celery-worker`, and `celery-beat`. The `migrate` service runs once and exits, leaving six long-running containers. The `app` container runs **4 uvicorn workers by default** (`UVICORN_WORKERS=4`, baked into the image).

A modest single-host deployment is comfortable at roughly **2 vCPU / 4 GB RAM** for trials and small teams. Give it more headroom (4+ vCPU, 8 GB+) if you connect large warehouses or run frequent scans, since warehouse queries and scans execute on `celery-worker`. Redis is capped at 256 MB (`--maxmemory 256mb`, `allkeys-lru`) and runs without persistence (`--save ""`), so it is a pure cache — losing it costs nothing but a cache warm-up. PostgreSQL holds all durable application state and is the volume you must back up (`pgdata18`).

## Registry access

The image lives at `ghcr.io/vladenisov/tripl`. The first publish to a new GHCR package creates it as **private**, so anonymous pulls fail until it is made public (in the repo's *Packages → tripl → Package settings*). Until then, authenticate on the deploy host with a GitHub personal access token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
```

The image and tag are configurable via `.env`:

| Variable | Default | Notes |
|---|---|---|
| `TRIPL_IMAGE` | `ghcr.io/vladenisov/tripl` | Registry/repo of the image. |
| `TRIPL_VERSION` | `latest` | **Pin** to a released tag (e.g. `1.4.0`) in production; `latest` is fine for trials. |

Released tags are `X.Y.Z`, `X.Y`, `latest` (stable only), and `sha-<short>`. Multi-arch images are published for **`linux/amd64` and `linux/arm64`**, so the same tag runs on both architectures.

## Generate the required secrets

The production stack refuses to start without real secrets. The app's `assert_production_ready()` check (run from the FastAPI lifespan when `DEBUG` is off) rejects an empty or invalid `ENCRYPTION_KEY`, an empty `SECRET_KEY`, insecure session cookies, an unusable CORS origin, and any connection string still carrying the dev-default `tripl:tripl` / `guest:guest` credentials.

Start from the example file and append generated values (appended lines win over the blanks in `.env.example`):

```bash
cp .env.example .env
{
  echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')"  # Fernet key
  echo "SECRET_KEY=$(openssl rand -hex 48)"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "RABBITMQ_PASSWORD=$(openssl rand -hex 24)"
  echo "APP_BASE_URL=https://tripl.example.com"   # your public https URL
  echo "TRIPL_VERSION=1.4.0"                       # pin the release you want
} >> .env
```

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | **Fernet** key used to encrypt data-source and alert-destination secrets at rest. Must be a valid Fernet key or the app refuses to start. |
| `SECRET_KEY` | Yes | Keys the HMAC over session tokens. Rotating it invalidates all sessions (everyone re-logs in once). |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password for the `tripl` user. Must **not** be `tripl`. |
| `RABBITMQ_PASSWORD` | Yes | RabbitMQ password for the `tripl` user. Must **not** be `guest`. |
| `APP_BASE_URL` | Yes | Public base URL of the app. Drives CORS in production and must be your real `https://` origin. |

The `ENCRYPTION_KEY` is specifically a Fernet key. The `tr '+/' '-_'` above produces the url-safe base64 alphabet Fernet expects; the canonical generator is also valid:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

:::danger Treat ENCRYPTION_KEY as irreplaceable
Warehouse credentials and alert-destination secrets are encrypted with `ENCRYPTION_KEY`. If you lose or change it, those stored secrets can no longer be decrypted and must be re-entered. Back it up alongside (but separately from) your PostgreSQL data.
:::

## URLs, CORS, TLS, and cookies

The production stack hard-codes the security posture that `assert_production_ready()` enforces. In `compose.yaml` these are set for every app/worker container:

- `SESSION_COOKIE_SECURE=true` — cookies are only sent over HTTPS. This is why the stack must sit behind TLS. With it on and no HTTPS in front, browsers will not store the session cookie and login will appear to silently fail.
- `SECURITY_HEADERS_ENABLED=true`, `HSTS_ENABLED=true` (overridable via `HSTS_ENABLED`), `RATE_LIMIT_ENABLED=true`.
- `APP_BASE_URL` drives CORS. When `CORS_ALLOW_ORIGINS` is empty (the default), production derives the allow-list from `APP_BASE_URL`. If both are empty, **no browser can call the API** and startup fails. A wildcard `*` is also rejected in production, because browsers refuse credentialed (cookie) requests against a wildcard origin. Set `APP_BASE_URL` to your exact frontend origin, or set an explicit `CORS_ALLOW_ORIGINS` list if the API is reached from more than one origin.

### Running behind a proxy

The single container is normally the network edge, so the image does **not** pass uvicorn `--forwarded-allow-ips`, and the auth rate limiter keys on the real socket peer (`rate_limit_trust_forwarded_for` defaults to `false`). This is correct when nothing trusted sits in front rewriting client-IP headers.

If you put a trusted reverse proxy or load balancer in front that overwrites `X-Real-IP` / `X-Forwarded-For` with the real client address on every request, set `RATE_LIMIT_TRUST_FORWARDED_FOR=true` and run uvicorn with `--proxy-headers --forwarded-allow-ips=<proxy>`. Never trust forwarded headers on a directly-exposed API — a raw `X-Forwarded-For` is attacker-controlled and lets a caller rotate it per request to bypass the rate limit.

## The compose stack

`compose.yaml` defines the following services, all from the same `${TRIPL_IMAGE}:${TRIPL_VERSION}` image except the infrastructure images:

| Service | Image | Role |
|---|---|---|
| `postgres` | `pgvector/pgvector:0.8.2-pg18-trixie` | Durable application state (also provides pgvector for hybrid search). Data lives in the `pgdata18` volume. Health-checked with `pg_isready`. |
| `rabbitmq` | `rabbitmq:3.13-management` | Celery broker (user `tripl`). Mounts `infra/rabbitmq/rabbitmq.conf`. Health-checked with `rabbitmq-diagnostics ping`. |
| `redis` | `redis:8.6.2-alpine` | Cache only — 256 MB cap, `allkeys-lru`, no persistence. Health-checked with `redis-cli ping`. |
| `migrate` | tripl image | One-shot. Runs `alembic upgrade head`, then exits. App and workers wait for it to complete successfully. |
| `app` | tripl image | The single API + SPA process on port `8000`. Runs uvicorn with `UVICORN_WORKERS` (default 4). |
| `celery-worker` | tripl image | Runs `celery -A tripl.worker.celery_app worker`. Executes scans, warehouse queries, monitor evaluation, and alert delivery. Its container healthcheck is disabled. |
| `celery-beat` | tripl image | Runs `celery -A tripl.worker.celery_app beat` with the schedule at `/tmp/celerybeat-schedule`. Enqueues periodic jobs. Its container healthcheck is disabled. |

Only `app` publishes a port: `8000:8000`. The `app`, `celery-worker`, and `celery-beat` services all `depends_on` the `migrate` service completing, so workers never start against an un-migrated schema. `app` additionally waits for `postgres`, `rabbitmq`, and `redis` to be healthy.

The frontend is **not** a separate service — `SERVE_FRONTEND=true` and `FRONTEND_DIST_DIR=/app/frontend_dist` are baked into the image, and FastAPI serves the built SPA itself as a low-priority fallback behind the API routes.

The SPA shell is returned for unknown paths only on **navigation requests** — ones whose `Accept` header admits `text/html`. Every other unknown path gets a real `404`, so a broken asset URL or a mistyped `fetch()` fails loudly instead of receiving HTML under a `200`. Worth knowing when probing by hand: `curl https://host/some/deep/route` sends `Accept: */*` and returns `404`, while the same URL in a browser loads the app. Add `-H 'Accept: text/html'` to reproduce what the browser sees. Point uptime checks at `/health`, never at a client-side route.

### Bring it up

```bash
docker compose pull
docker compose up -d
```

Watch the `migrate` job and then the app come up:

```bash
docker compose logs -f migrate
docker compose logs -f app
```

## Migrations

Schema upgrades are applied by the dedicated **`migrate`** one-shot, which runs `alembic upgrade head` before `app` or the workers start. Because all of them wait on `migrate` completing successfully, a multi-worker deploy never races the schema upgrade. You do not run migrations by hand in the normal flow — they run automatically on every `docker compose up -d` after a version bump.

To run them manually (for example, to inspect output), invoke the same command in a one-off container:

```bash
docker compose run --rm migrate
```

## Health check

The `app` container exposes an unauthenticated health probe at **`GET /health`** on port `8000`, returning JSON. The image's Docker `HEALTHCHECK` polls it directly:

```bash
curl -fsS https://tripl.example.com/health
```

The interactive API reference is served at `/docs` (and `/api/v1/*` for the API itself). API routes take precedence over the SPA fallback, so `/health`, `/docs`, and `/metrics` keep their meaning even though the same process serves the frontend.

## Connecting a warehouse

tripl reads from your existing warehouse — it never writes to it. You connect a warehouse **from the UI** after the stack is up, not via environment variables:

1. Open the app at your `APP_BASE_URL` and create the first account on the sign-in page.
2. Optionally click **Generate demo project** to explore with synthetic data and no warehouse at all.
3. Go to **Settings → Data sources** (under the Workspace group) and add a data source: **ClickHouse**, **BigQuery**, or **PostgreSQL**. The credentials you enter are encrypted at rest with `ENCRYPTION_KEY`.

Warehouse queries and scans run on `celery-worker`, so make sure that container has network access to your warehouse. Adapter-specific details live in the [warehouse adapters](https://github.com/vladenisov/tripl/tree/main/backend/src/tripl/core/adapters) source.

## Upgrading

Upgrades are a version bump plus a pull-and-up:

```bash
# 1. Edit .env: bump the pinned tag, e.g.
#    TRIPL_VERSION=1.5.0
docker compose pull
docker compose up -d
```

The `migrate` one-shot applies any new Alembic migrations before the new `app` and workers come up, so a rolling deploy never races the upgrade. Pin `TRIPL_VERSION` to an explicit released tag in production rather than tracking `latest`, so upgrades are deliberate and reproducible. Releases are cut from git tags via `bin/release.sh`; the full release machinery is documented in [the release guide](./release.md).

After upgrading, confirm everything is healthy:

```bash
docker compose ps
curl -fsS https://tripl.example.com/health
```

## Local preview

The production stack is hardened for HTTPS and will not run comfortably over plain HTTP. To just try tripl on your laptop, use the dev stack, which builds from source with hot-reload and needs no secrets:

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --watch
```

The dev stack serves the SPA from Vite on `:5173` (proxying to the API on `:8000`). This is **not** a deployment path — use `compose.yaml` for anything real.

## Related

- [Configuration reference](./configuration) — every environment variable and what it does.
- [Troubleshooting](../use/troubleshooting) — startup failures, CORS/cookie issues, worker problems.
- [the release guide](./release.md) — cutting and publishing release images.

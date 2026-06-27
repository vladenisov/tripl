# Releasing & deploying tripl

tripl ships as **one image** that serves the JSON API and the built SPA in a
single process. Releases are driven entirely by **git tags**: bump the version,
push a `vX.Y.Z` tag, and GitHub Actions builds a multi-arch image, pushes it to
GHCR, and cuts a GitHub Release.

```
bin/release.sh        git tag vX.Y.Z        .github/workflows/release.yml
  bump version  ───▶   push to origin  ───▶   CI gate ─▶ buildx (amd64+arm64)
                                                       └─▶ push ghcr.io/.../tripl:X.Y.Z, :X.Y, :latest
                                                       └─▶ GitHub Release
```

## Cut a release

From a clean `main` that's green on CI:

```bash
bin/release.sh patch     # 0.1.0 -> 0.1.1   (bug fixes)
bin/release.sh minor     # 0.1.0 -> 0.2.0   (features, back-compatible)
bin/release.sh major     # 0.1.0 -> 1.0.0   (breaking changes)
bin/release.sh 1.4.0     # set an explicit version
bin/release.sh -n patch  # dry-run: show the plan, change nothing
```

The script:

1. Reads the current version from `backend/pyproject.toml` (`[project].version`).
2. Computes and writes the new version to `backend/pyproject.toml` **and**
   `frontend/package.json` (kept in sync).
3. Commits `chore(release): vX.Y.Z`.
4. Creates an annotated tag `vX.Y.Z` and pushes the branch + tag.

It refuses to run on a dirty tree or if the tag already exists, and warns if
you're not on `main`. The **git tag is the source of truth** for the version.

## What the tag triggers

`.github/workflows/release.yml` runs on any `v*` tag push:

1. **CI gate** — reuses `ci.yml` (ruff + mypy + pytest, lint + build + vitest).
   No image is published from red code.
2. **Build & push** — `docker buildx` builds the root `Dockerfile` `runtime`
   stage for **`linux/amd64` and `linux/arm64`** and pushes to
   `ghcr.io/vladenisov/tripl` with tags `X.Y.Z`, `X.Y`, `latest` (stable only),
   and `sha-<short>`.
3. **GitHub Release** — created from the tag with auto-generated notes.

Auth uses the built-in `GITHUB_TOKEN` (no extra secrets). The first publish to a
new package creates it as **private**; make it public in the repo's
*Packages → tripl → Package settings* if you want anonymous pulls.

> **arm64 is cross-built via QEMU** on the amd64 runner, so release builds are
> slower than a native build (the `pnpm build` + `uv sync` steps especially).
> This is fine for tagged releases; for faster builds later, switch to a native
> arm64 runner.

To re-run a build for an existing tag (e.g. a transient failure), use the
**Run workflow** button on the *Release* workflow and pass the tag (e.g.
`v1.4.0`).

## Deploy

The default `compose.yaml` runs the **published image** — no source build:

```bash
cp .env.example .env
# generate the required secrets (appended values win over the .env.example blanks):
{
  echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')"  # Fernet key
  echo "SECRET_KEY=$(openssl rand -hex 48)"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "RABBITMQ_PASSWORD=$(openssl rand -hex 24)"
  echo "APP_BASE_URL=https://tripl.example.com"   # your public https URL
  echo "TRIPL_VERSION=1.4.0"                       # pin the release you want
} >> .env

docker compose pull
docker compose up -d
```

The stack: `postgres`, `rabbitmq`, `redis`, a one-shot `migrate` (runs
`alembic upgrade head` before anything starts), the `app` (API + SPA on
`:8000`), and `celery-worker` / `celery-beat` — all from the same image.

| Variable | Default | Notes |
|---|---|---|
| `TRIPL_IMAGE` | `ghcr.io/vladenisov/tripl` | Registry/repo of the image. |
| `TRIPL_VERSION` | `latest` | **Pin** to a released tag in production. |
| `POSTGRES_PASSWORD` | — | **Required.** DB password (must not be `tripl`). |
| `RABBITMQ_PASSWORD` | — | **Required.** Broker password (user is `tripl`). |
| `ENCRYPTION_KEY` | — | **Required.** Fernet key for secrets at rest. |
| `SECRET_KEY` | — | **Required.** Session cookie signing key. |
| `APP_BASE_URL` | — | **Required.** Public base URL (use your `https://` URL). |

Upgrading is just: bump `TRIPL_VERSION`, then `docker compose pull && docker
compose up -d`. The `migrate` one-shot applies any new Alembic migrations before
the new `app`/workers come up, so a multi-worker deploy never races the upgrade.

> The prod stack enforces production hardening: it forces secure session cookies
> on and refuses dev-default DB/broker credentials, so it expects to sit behind
> TLS — terminate it in front of `:8000` and use an `https://` `APP_BASE_URL`.
> To just preview the app locally over plain HTTP, use the dev stack instead
> (`docker compose -f compose.dev.yaml up --watch`). The deploy host needs
> `compose.yaml`, `.env`, and `infra/rabbitmq/` present.

## Local development

This is **not** the deploy path. For hot-reload development (Vite on `:5173`
proxying to the API on `:8000`), use the dev stack which builds from source:

```bash
docker compose -f compose.dev.yaml up --watch
```

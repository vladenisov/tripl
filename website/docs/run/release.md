---
title: Release Process
sidebar_position: 3
---

# Release Process

This page is for **maintainers** cutting a release. tripl ships as **one image**
that serves the JSON API and the built SPA in a single process. Releases are
driven entirely by **git tags**: bump the version, push a `vX.Y.Z` tag, and
GitHub Actions runs CI, builds a multi-arch image, pushes it to GHCR, and cuts a
GitHub Release.

```
bin/release.sh        git tag vX.Y.Z        .github/workflows/release.yml
  bump version  ───▶   push to origin  ───▶   CI gate ─▶ buildx (amd64 + arm64)
                                                       ├─▶ push ghcr.io/.../tripl:X.Y.Z, :X.Y, :latest
                                                       └─▶ GitHub Release
```

The **git tag is the single source of truth** for the version.
`backend/pyproject.toml` and `frontend/package.json` are kept in sync by the
release script, not the other way around.

## Versioning & tags

tripl follows semver, and the tag is always `v` + the version:

| Bump | Meaning | Example |
|---|---|---|
| `patch` | Bug fixes, no API change | `0.1.0` → `0.1.1` |
| `minor` | New, backward-compatible features | `0.1.0` → `0.2.0` |
| `major` | Breaking changes | `0.1.0` → `1.0.0` |

You can also pass an explicit `X.Y.Z`. The script validates that both the
current and target versions are strict `X.Y.Z` (no pre-release suffixes), so
pre-releases are not part of this flow.

## Cut a release

From a clean `main` that is green on CI:

```bash
bin/release.sh patch     # 0.1.0 -> 0.1.1   (bug fixes)
bin/release.sh minor     # 0.1.0 -> 0.2.0   (features, back-compatible)
bin/release.sh major     # 0.1.0 -> 1.0.0   (breaking changes)
bin/release.sh 1.4.0     # set an explicit version
bin/release.sh -n patch  # dry-run: print the plan, change nothing
bin/release.sh -y minor  # skip the confirmation prompt
```

What [`bin/release.sh`](https://github.com/vladenisov/tripl/blob/main/bin/release.sh)
does:

1. Reads the current version from `backend/pyproject.toml` (the `[project]`
   `version` line).
2. Computes the new version and writes it to **both**
   `backend/pyproject.toml` and `frontend/package.json`.
3. Commits `chore(release): vX.Y.Z` (skipped if the files are already at the
   target version — it then just tags the current `HEAD`).
4. Creates an **annotated** tag `vX.Y.Z` and pushes the branch **and** the tag
   to `origin`.

It runs from the repo root regardless of where you invoke it, and requires GNU
`sed`.

:::warning Preconditions
The script **refuses to run** if the working tree is dirty (uncommitted or
staged changes) or if the tag already exists. It **warns** (but does not stop)
if you are not on `main`. Unless you pass `-n`/`--dry-run` or `-y`/`--yes`, it
prompts for confirmation before pushing.
:::

Use `-n` first if you are unsure — it prints exactly which version it would set
and what it would commit, tag, and push, without changing anything.

## What the tag triggers

Pushing a `v*` tag starts the
[Release workflow](https://github.com/vladenisov/tripl/blob/main/.github/workflows/release.yml),
which has two jobs:

1. **CI gate (`ci`)** — reuses
   [`ci.yml`](https://github.com/vladenisov/tripl/blob/main/.github/workflows/ci.yml)
   via `workflow_call`: the backend job (`ruff` + `mypy` + `pytest`) and the
   frontend job (`pnpm lint` + `pnpm build` + `pnpm test`). The image job
   `needs: ci`, so **no image is ever published from red code**.
2. **Build & push image (`image`)** — after CI is green:
   - Sets up QEMU + Buildx and logs in to GHCR.
   - Builds the root `Dockerfile` `runtime` stage for **`linux/amd64` and
     `linux/arm64`** and pushes to `ghcr.io/<owner>/tripl`.
   - Creates a **GitHub Release** from the tag with auto-generated notes.

Authentication uses the built-in `GITHUB_TOKEN` (`packages: write` to push to
GHCR, `contents: write` to create the Release) — no extra secrets to manage.

### Image tags produced

Tags are computed by `docker/metadata-action`:

| Tag | Source | Notes |
|---|---|---|
| `X.Y.Z` | full semver | the exact release |
| `X.Y` | major.minor | floats to the latest patch |
| `latest` | `flavor latest=auto` | **stable releases only** (no pre-releases) |
| `sha-<short>` | commit | the exact build commit |

:::note arm64 is cross-built via QEMU
arm64 is emulated on the amd64 runner, so release builds are slower than a
native build (`pnpm build` and `uv sync` especially). This is acceptable for
tagged releases. For faster builds later, move to a native arm64 runner.
:::

:::note First publish is private
The first push to a brand-new GHCR package creates it as **private**. Make it
public under *Packages → tripl → Package settings* if you want anonymous pulls.
:::

## Re-running a build for an existing tag

If a push-triggered build fails transiently (e.g. a flaky network step), you do
not need to re-tag. The Release workflow also accepts **`workflow_dispatch`**:

1. Open the **Release** workflow in the GitHub Actions tab.
2. Click **Run workflow** and pass the existing tag, e.g. `v1.4.0`.

On `workflow_dispatch` the workflow checks out the requested tag and passes it
into the metadata action, so `X.Y.Z` / `X.Y` / `latest` still resolve
correctly. This re-runs the full CI gate before rebuilding.

## Post-release smoke check

After the workflow goes green:

```bash
# 1. Watch / confirm the run finished
gh run watch

# 2. Confirm the Release was cut
gh release view v1.4.0

# 3. Confirm the multi-arch image is published (should list amd64 + arm64)
docker buildx imagetools inspect ghcr.io/vladenisov/tripl:1.4.0

# 4. Confirm the floating tags point at it
docker buildx imagetools inspect ghcr.io/vladenisov/tripl:latest
```

Then do a real pull-and-run on a throwaway host or locally, pinning the new tag:

```bash
TRIPL_VERSION=1.4.0 docker compose pull
TRIPL_VERSION=1.4.0 docker compose up -d
docker compose ps        # migrate one-shot Completed; app/workers healthy/Up
```

The stack from [`compose.yaml`](https://github.com/vladenisov/tripl/blob/main/compose.yaml)
is `postgres`, `rabbitmq`, `redis`, a one-shot `migrate` (`alembic upgrade head`
before anything starts), the `app` (API + SPA on `:8000`), and
`celery-worker` / `celery-beat` — all from the same image. The `migrate`
one-shot must reach **Completed** before `app`/workers start, so a multi-worker
deploy never races the schema upgrade.

## Rollback & upgrade path

There is no separate rollback workflow — versions are immutable image tags, so
rolling back is just re-pinning `TRIPL_VERSION` to the previous release and
re-deploying. The full upgrade/downgrade procedure, required `.env` secrets, and
the production-hardening notes live on the deployment page:

➡️ See [Deployment](./deployment) for the upgrade and rollback steps.

:::danger Migrations are not auto-reversed
Downgrading the image does **not** roll back Alembic migrations. If a release
applied a schema change, rolling the image back to a version that predates that
migration can break against the upgraded schema. Treat schema changes as
forward-only and verify on a staging stack before relying on rollback.
:::

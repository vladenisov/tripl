# syntax=docker/dockerfile:1
#
# Consolidated single-container image: FastAPI serves the JSON API AND the built
# SPA in one process via app.frontend() (FastAPI 0.138+), replacing the separate
# nginx/frontend container. Build from the repo ROOT:
#
#     docker build -t tripl .
#
# The standalone backend/Dockerfile + frontend/Dockerfile (two containers, with
# nginx) remain as an alternative deploy.

# ---- frontend build -> dist/ ----
FROM node:26-trixie-slim AS frontend-build
ARG PNPM_VERSION=11.6.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm build

# ---- backend deps + source ----
FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim AS backend-base
WORKDIR /app
ENV UV_LINK_MODE=copy
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
COPY backend/alembic.ini ./alembic.ini
COPY backend/alembic ./alembic
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

# ---- runtime: API + SPA in one process ----
FROM python:3.14-slim-trixie AS runtime
WORKDIR /app
COPY --from=backend-base /app/.venv /app/.venv
COPY --from=backend-base /app/src /app/src
COPY --from=backend-base /app/alembic.ini /app/alembic.ini
COPY --from=backend-base /app/alembic /app/alembic
# Bake the built SPA in and point the app at it; app.frontend() serves it.
COPY --from=frontend-build /app/dist /app/frontend_dist

ENV PATH="/app/.venv/bin:$PATH"
ENV UVICORN_WORKERS=4
ENV SERVE_FRONTEND=true
ENV FRONTEND_DIST_DIR=/app/frontend_dist

RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid 1000 --no-create-home app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

# This single container is the network edge, so we do NOT pass uvicorn
# --forwarded-allow-ips='*': request.client.host is the real peer and the rate
# limiter keys on it (rate_limit_trust_forwarded_for defaults False). If you add
# a trusted proxy/LB in front, add --proxy-headers --forwarded-allow-ips=<proxy>
# and set RATE_LIMIT_TRUST_FORWARDED_FOR=true.
CMD ["sh", "-c", "exec uvicorn tripl.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-4}"]

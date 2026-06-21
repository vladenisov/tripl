# syntax=docker/dockerfile:1

FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim AS base

WORKDIR /app
ENV UV_LINK_MODE=copy

COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY src ./src
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM base AS dev

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "tripl.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM python:3.14-slim-trixie AS runtime

WORKDIR /app
COPY --from=base /app/.venv /app/.venv
COPY --from=base /app/src /app/src
COPY --from=base /app/alembic.ini /app/alembic.ini
COPY --from=base /app/alembic /app/alembic

ENV PATH="/app/.venv/bin:$PATH"
ENV UVICORN_WORKERS=4

# Drop privileges: run as a non-root system user in the runtime image. The
# venv and source were copied as root and stay read-only to this user.
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid 1000 --no-create-home app
USER app

EXPOSE 8000

# Liveness/readiness probe hitting the app's /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

# Production: multi-worker, proxy-aware. Override UVICORN_WORKERS at deploy time.
CMD ["sh", "-c", "exec uvicorn tripl.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-4} --proxy-headers --forwarded-allow-ips='*'"]

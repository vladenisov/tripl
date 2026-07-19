FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"

# stdio by default; compose sidecars typically override with:
#   tripl-mcp --transport streamable-http --host 0.0.0.0 --port 8848
EXPOSE 8848
ENTRYPOINT ["tripl-mcp"]

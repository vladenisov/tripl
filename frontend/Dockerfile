# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY . .

FROM base AS dev

EXPOSE 5173

CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

FROM base AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm build

# Install nginx AND the brotli module from the same alpine repo so their
# versions match. The official `nginx:*-alpine` image compiles nginx itself,
# which diverges from the community `nginx-mod-http-brotli` build → nginx
# fails at load with "module version X instead of Y". Pinning the alpine
# release keeps nginx (1.28.3) and the brotli module in lockstep.
FROM alpine:3.22 AS runtime

RUN apk add --no-cache nginx nginx-mod-http-brotli

COPY --from=build /app/dist /usr/share/nginx/html
# Our nginx.conf has top-level load_module directives for brotli and fully
# replaces the packaged config.
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]

# syntax=docker/dockerfile:1
#
# One image, three services. The workspace has a shared package that all three
# depend on, so building them separately would mean either duplicating the build
# or shipping three near-identical layers. Instead the whole monorepo is built
# once and the entrypoint is selected per container in docker-compose.yml.
#
#   docker build --build-arg SERVICE=user-service .

# ── Stage 1: dependencies ────────────────────────────────────────────────────
# Manifests are copied before source, so a source-only change reuses the cached
# npm install layer — the slowest step by a wide margin.
FROM node:24-alpine AS deps

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms, but Alpine (musl)
# is not always among them, so keep a toolchain available for the fallback build.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api-gateway/package.json ./services/api-gateway/
COPY services/user-service/package.json ./services/user-service/
COPY services/notification-service/package.json ./services/notification-service/

RUN npm ci --no-audit --no-fund

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS build

WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY services ./services
# The migration job runs infra/scripts/migrate.ts, so it has to be in the image.
# .dockerignore already excludes infra/nats/certs and infra/keys, so no key
# material is copied here — those are mounted at runtime.
COPY infra ./infra

# Project references compile in dependency order: shared first, then services.
RUN npx tsc --build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ARG SERVICE
ENV SERVICE=${SERVICE}
ENV NODE_ENV=production

WORKDIR /app

# tini reaps zombies and, more importantly here, forwards SIGTERM to node.
# Without an init process, `docker stop` sends the signal to PID 1 which may
# ignore it — and the graceful shutdown path (drain the broker, finish in-flight
# messages, close the database) would never run.
RUN apk add --no-cache tini

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services ./services
COPY --from=build /app/infra ./infra
COPY --from=build /app/package.json ./package.json

# Drop root. `node` (uid 1000) ships with the base image.
# The data directory is created and owned here so a mounted volume is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4001 4002 8080

# The healthcheck hits the service's own /health, which is exempt from the
# gateway-only internal-token guard precisely so orchestrators can reach it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p={'api-gateway':8080,'user-service':4001,'notification-service':4002}[process.env.SERVICE];require('http').get('http://127.0.0.1:'+p+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node services/${SERVICE}/dist/main.js"]

# NEXUS API + web app (FR-OPS-01). Built by Compose (infra/compose/docker-compose.yml) from the repo root:
#   docker build -f infra/api/Dockerfile -t nexus-api:local .
# Node 24 runs the API's .ts sources directly, so only the web app is compiled. No Docker socket, no secrets baked in.
# node:24-alpine, pinned by index digest (multi-arch); same base as infra/sandbox.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
RUN corepack enable
WORKDIR /app
# Manifests first, so dependency layers stay cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
COPY packages/contracts/package.json packages/contracts/

FROM base AS web
RUN pnpm install --frozen-lockfile --filter nexus --filter "@nexus/web..."
COPY packages/contracts/src packages/contracts/src
COPY apps/web apps/web
RUN pnpm --filter @nexus/web build

FROM base AS prod-deps
# Not `pnpm deploy`: it copies @nexus/contracts into node_modules, where Node refuses to strip TypeScript types.
# A filtered prod install keeps the workspace package as a symlink to packages/contracts.
RUN pnpm install --frozen-lockfile --prod --filter "@nexus/api..."

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules packages/contracts/node_modules
COPY packages/contracts/package.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
COPY --from=web /app/apps/web/dist apps/web/dist
# Compose runs it as the host user (NEXUS_UID) so the mounted 0600 github-app.json stays readable; this is the fallback.
USER 10001:10001
WORKDIR /app/apps/api
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.ts"]

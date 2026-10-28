# NEXUS job sandbox (FR-RUN-03, FR-SEC-04): one fresh container per run, started by apps/runner.
# Build: pnpm --filter @nexus/runner sandbox:build  (tag must match SANDBOX_IMAGE in apps/runner/src/sandbox.ts;
# bump both when this file or agent/ changes). No secrets, no credentials, nothing copied from the host.
# Also runs the per-job egress proxy (agent/nexus-proxy.mjs) and the Claude entrypoint (`nexus-agent`).
# node:24-alpine, pinned by index digest (multi-arch).
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# shortcut: apk packages float within the pinned Alpine release, pin versions once builds must be reproducible bit-for-bit.
# libstdc++/libgcc: the Agent SDK's native (musl) Claude Code binary links against them.
RUN apk add --no-cache git coreutils libstdc++ libgcc \
  && addgroup -S -g 10001 nexus \
  && adduser -S -D -H -u 10001 -G nexus -h /tmp -s /sbin/nologin nexus

# Agent SDK pinned by package-lock.json; the version must match apps/runner's devDependency (sandbox.test.ts checks).
WORKDIR /opt/nexus
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY agent/nexus-agent.mjs agent/nexus-proxy.mjs ./
RUN chmod 0755 nexus-agent.mjs nexus-proxy.mjs && ln -s /opt/nexus/nexus-agent.mjs /usr/local/bin/nexus-agent

ENV HOME=/tmp
USER 10001:10001
WORKDIR /workspace

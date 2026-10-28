# NEXUS job sandbox (FR-RUN-03, FR-SEC-04): one fresh container per run, started by apps/runner.
# Build: pnpm --filter @nexus/runner sandbox:build  (tag must match SANDBOX_IMAGE in apps/runner/src/sandbox.ts;
# bump both when this file changes). No secrets, no credentials, nothing copied from the host.
# node:24-alpine, pinned by index digest (multi-arch).
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# shortcut: apk packages float within the pinned Alpine release, pin versions once builds must be reproducible bit-for-bit.
RUN apk add --no-cache git coreutils \
  && addgroup -S -g 10001 nexus \
  && adduser -S -D -H -u 10001 -G nexus -h /tmp -s /sbin/nologin nexus

ENV HOME=/tmp
USER 10001:10001
WORKDIR /workspace

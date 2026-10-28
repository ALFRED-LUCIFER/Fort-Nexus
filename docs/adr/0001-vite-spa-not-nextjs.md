# ADR-0001: React 19 + Vite SPA served by the API, not Next.js

- Status: Accepted (2026-10-28) · PRD: Part A, C-01, DEC-15

## Context
v1.0/CR-001 named Next.js. NEXUS is a private, single-owner, tailnet-only app whose main surface is a client-side pan/zoom board with live streams. No SEO, no public pages.

## Decision
Build `apps/web` as a React 19 + Vite SPA. `apps/api` (Fastify) serves the built files and `/v1`, so the browser talks to one origin with one cookie session.

## Consequences
- One server process and auth surface; no CORS; simpler Tailscale Serve setup.
- No SSR/RSC. Acceptable: the first paint after login is data-bound anyway.
- Revisit only if public, indexable pages are ever needed.

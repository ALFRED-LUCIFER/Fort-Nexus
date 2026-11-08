import { z } from "zod";

// Settings → Remote access (FR-ACC-03). The runner lives on the home machine, so it reports what Tailscale says there;
// the API runs in a container and can't ask. Read-only by design: changes stay in the home machine's terminal.
export const REMOTE_ACCESS_REPORT_INTERVAL_MS = 60_000;
export const REMOTE_ACCESS_STALE_AFTER_MS = 3 * REMOTE_ACCESS_REPORT_INTERVAL_MS;

export const RemoteAccessState = z.enum([
  "NOT_INSTALLED",
  "UNAVAILABLE",
  "STOPPED",
  "NEEDS_LOGIN",
  "RUNNING",
]);
export type RemoteAccessState = z.infer<typeof RemoteAccessState>;

// Names and online state only: never tailnet addresses, keys or account details.
export const RemoteAccessDevice = z.strictObject({
  name: z.string().min(1).max(128),
  os: z.string().max(32),
  online: z.boolean(),
  self: z.boolean(),
});
export type RemoteAccessDevice = z.infer<typeof RemoteAccessDevice>;

export const RemoteAccessReport = z.strictObject({
  state: RemoteAccessState,
  /** The https address Tailscale Serve answers on; null when nothing is served. */
  url: z
    .url({ protocol: /^https$/ })
    .max(512)
    .nullable(),
  /** Tailscale Serve proxies to this NEXUS. */
  serving: z.boolean(),
  /** Tailscale Funnel publishes it to the public internet, which NEXUS must never be (runbook: remote access). */
  funnel: z.boolean(),
  devices: z.array(RemoteAccessDevice).max(64),
});
export type RemoteAccessReport = z.infer<typeof RemoteAccessReport>;

export const RemoteAccessStatus = z.object({
  publicOrigin: z.string(),
  /** The runner whose report this is; null when no active runner has reported. */
  runnerName: z.string().nullable(),
  reportedAt: z.iso.datetime().nullable(),
  /** The report is older than REMOTE_ACCESS_STALE_AFTER_MS, so it may no longer be true. */
  stale: z.boolean(),
  report: RemoteAccessReport.nullable(),
});
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatus>;

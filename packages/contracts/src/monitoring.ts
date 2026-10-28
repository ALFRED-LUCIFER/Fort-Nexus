import { z } from "zod";
import { ConnectorEnvironment } from "./business.ts";
import { RepoId } from "./github.ts";
import { AiConfidence } from "./research.ts";

// EPIC MON (FR-MON-01/02/04/06/09, MON-G01/G02). Checks run on the home host: when it is offline, external health is
// UNKNOWN, never assumed healthy (FR-MON-09).

// https only, public hosts only (the checker refuses loopback/private/link-local/CGNAT targets), no credentials.
export const HealthUrl = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((u) => {
    const url = new URL(u);
    return url.username === "" && url.password === "";
  }, "No credentials in the URL");

export const AppHealth = z.enum(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"]);
export type AppHealth = z.infer<typeof AppHealth>;

export const CheckError = z.enum([
  "TIMEOUT",
  "DNS",
  "CONNECT",
  "TLS",
  "HTTP_STATUS",
  "REDIRECT",
  "BLOCKED_TARGET",
]);
export type CheckError = z.infer<typeof CheckError>;

export const CreateMonitoredAppRequest = z.strictObject({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  environment: ConnectorEnvironment,
  healthUrl: HealthUrl,
  repositoryId: RepoId.optional(), // FR-MON-01 / FR-MON-05 link to the code
  intervalSeconds: z.int().min(60).max(3600).default(300),
  timeoutMs: z.int().min(1000).max(10_000).default(5000),
  // Consecutive failures before an incident opens.
  failureThreshold: z.int().min(1).max(10).default(3),
});
export type CreateMonitoredAppRequest = z.infer<typeof CreateMonitoredAppRequest>;

export const UpdateMonitoredAppRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    healthUrl: HealthUrl,
    intervalSeconds: z.int().min(60).max(3600),
    timeoutMs: z.int().min(1000).max(10_000),
    failureThreshold: z.int().min(1).max(10),
    disabled: z.boolean(),
  })
  .partial()
  .refine((u) => Object.keys(u).length > 0, "Nothing to update");
export type UpdateMonitoredAppRequest = z.infer<typeof UpdateMonitoredAppRequest>;

export const MonitoredApp = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  environment: ConnectorEnvironment,
  healthUrl: z.string(),
  repositoryId: RepoId.nullable(),
  intervalSeconds: z.int(),
  timeoutMs: z.int(),
  failureThreshold: z.int(),
  disabled: z.boolean(),
  // UNKNOWN when never checked, disabled, or the last check is older than 2 × interval (observer was offline).
  health: AppHealth,
  consecutiveFailures: z.int().nonnegative(),
  lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
  openIncidentId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type MonitoredApp = z.infer<typeof MonitoredApp>;

export const MonitoredAppList = z.object({ items: z.array(MonitoredApp) });
export type MonitoredAppList = z.infer<typeof MonitoredAppList>;

export const HealthCheck = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  checkedAt: z.iso.datetime({ offset: true }),
  ok: z.boolean(),
  statusCode: z.int().nullable(),
  latencyMs: z.int().nonnegative().nullable(),
  error: CheckError.nullable(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const HealthCheckList = z.object({ items: z.array(HealthCheck) });
export type HealthCheckList = z.infer<typeof HealthCheckList>;

export const IncidentStatus = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

// FR-MON-06: one active incident per fingerprint (app + environment + check kind); repeats add evidence (MON-G01).
export const Incident = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  appId: z.uuid(),
  fingerprint: z.string(),
  severity: z.enum(["SEV1", "SEV2", "SEV3"]),
  status: IncidentStatus,
  title: z.string(),
  openedAt: z.iso.datetime({ offset: true }),
  acknowledgedAt: z.iso.datetime({ offset: true }).nullable(),
  // Set when checks pass again; the owner still resolves explicitly.
  recoveredAt: z.iso.datetime({ offset: true }).nullable(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  evidenceCount: z.int().positive(),
  // Newest first, capped at 50.
  evidence: z.array(HealthCheck),
});
export type Incident = z.infer<typeof Incident>;

export const IncidentList = z.object({ items: z.array(Incident) });
export type IncidentList = z.infer<typeof IncidentList>;

export const ListIncidentsQuery = z.object({
  projectId: z.uuid().optional(),
  status: IncidentStatus.optional(),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuery>;

export const SetIncidentStatusRequest = z.strictObject({ status: IncidentStatus.exclude(["OPEN"]) });
export type SetIncidentStatusRequest = z.infer<typeof SetIncidentStatusRequest>;

// FR-MON-07 agent-assisted triage: hypotheses only, each citing the incident's own checks; never a remediation.
// POST /v1/incidents/:id/triage creates it once (cached); GET …/triage returns it or 404.
export const IncidentTriage = z.object({
  incidentId: z.uuid(),
  hypotheses: z
    .array(
      z.object({
        text: z.string().max(500),
        confidence: AiConfidence,
        evidenceCheckIds: z.array(z.uuid()).min(1),
      }),
    )
    .min(1)
    .max(5),
  suggestedNextStep: z.string().max(500),
  model: z.string(),
  profileVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type IncidentTriage = z.infer<typeof IncidentTriage>;

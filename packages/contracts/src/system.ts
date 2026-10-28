import { z } from "zod";

// Owner-level safety controls (FR-INB-04, FR-CSP-09, FR-SEC-08, FR-ACC-04, GATE-09).

export const SystemControls = z.object({
  // Engaged: no new leases, active runs cancelled, approvals can't execute, until the owner releases it.
  emergencyStop: z.object({ engaged: z.boolean(), changedAt: z.iso.datetime().nullable() }),
  budget: z.object({
    dailyCapUsd: z.number().positive(),
    spentTodayUsd: z.number().nonnegative(),
    timezone: z.string(),
    resetsAt: z.iso.datetime(),
    exhausted: z.boolean(),
  }),
});
export type SystemControls = z.infer<typeof SystemControls>;

export const SetEmergencyStopRequest = z.strictObject({ engaged: z.boolean() });
export type SetEmergencyStopRequest = z.infer<typeof SetEmergencyStopRequest>;

export const SetDailyBudgetRequest = z.strictObject({ dailyCapUsd: z.number().positive().max(1000) });
export type SetDailyBudgetRequest = z.infer<typeof SetDailyBudgetRequest>;

export const OwnerSession = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  current: z.boolean(),
});
export type OwnerSession = z.infer<typeof OwnerSession>;

export const OwnerSessionList = z.object({ items: z.array(OwnerSession) });
export type OwnerSessionList = z.infer<typeof OwnerSessionList>;

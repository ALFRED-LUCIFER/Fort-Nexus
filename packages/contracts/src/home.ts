import { z } from "zod";
import { AgentKey } from "./agent-key.ts";
import { RunStage } from "./events.ts";
import { JobStatus } from "./jobs.ts";

// Cofounder home (PRD §D.4): one read of the owner's day built by the server from NEXUS's own records only. Nothing
// here is model text: the headline is assembled from counts, KPIs from jobs/approvals/verification, results from
// GitHub-confirmed outcomes. Business KPIs come from the existing business metric endpoints, not from here.

// GET /v1/home — projectId omitted = the read-only "All" aggregate of the owner's projects.
export const HomeQuery = z.object({ projectId: z.uuid().optional() });
export type HomeQuery = z.infer<typeof HomeQuery>;

// A record the UI can open: run:<id> (a pending push approval is its JOB: the run drawer holds the gate), plan:<id>,
// opp:<id>, research:<deepDiveId>, jobdraft:<id>, incident:<id>.
export const HomeRef = z.object({
  kind: z.enum(["JOB", "PLAN", "OPPORTUNITY", "DEEP_DIVE", "JOB_DRAFT", "INCIDENT"]),
  id: z.uuid(),
});
export type HomeRef = z.infer<typeof HomeRef>;

// The headline is a few segments; `emphasis` marks the key phrase the design highlights.
export const HomeHeadline = z.object({
  segments: z
    .array(z.object({ text: z.string().max(300), emphasis: z.boolean() }))
    .min(1)
    .max(6),
  // "prepared HH:MM · N sources · N decisions waiting on you"
  sources: z.int().nonnegative(),
  decisionsWaiting: z.int().nonnegative(),
});
export type HomeHeadline = z.infer<typeof HomeHeadline>;

// What waits on the owner, by kind; their sum is `headline.decisionsWaiting`.
export const HomeDecisions = z.object({
  approvals: z.int().nonnegative(), // PENDING push/PR approvals, unexpired
  plans: z.int().nonnegative(), // DRAFT plans: steps to approve, or only gaps to start as new jobs
  jobDrafts: z.int().nonnegative(), // READY or NEEDS_REPO job drafts
  opportunities: z.int().nonnegative(), // OPEN opportunities
  incidents: z.int().nonnegative(), // OPEN incidents (not yet acknowledged or resolved)
  // The most urgent few for "Waiting on you".
  top: z
    .array(z.object({ ref: HomeRef, title: z.string().max(300), expiresAt: z.iso.datetime().nullable() }))
    .max(5),
});
export type HomeDecisions = z.infer<typeof HomeDecisions>;

export const HomeKpiKey = z.enum(["REVIEW_READY_MEDIAN", "TESTS_PASS_RATE", "RUNS_TODAY", "WAITING_ON_YOU"]);
export type HomeKpiKey = z.infer<typeof HomeKpiKey>;

export const HomeKpi = z.object({
  key: HomeKpiKey,
  label: z.string(),
  // null = no data in the window (shown as "—", never as 0).
  value: z.number().nonnegative().nullable(),
  unit: z.enum(["minutes", "ratio", "count"]),
  // Same KPI over the previous window; null when it had no data.
  previous: z.number().nonnegative().nullable(),
  // Which direction is good, so the delta chip is coloured AND worded correctly.
  better: z.enum(["UP", "DOWN"]),
  // Oldest → newest daily values for the sparkline (7 local days ending today); null = no data that day.
  series: z.array(z.number().nonnegative().nullable()).length(7),
  // Where the number comes from, e.g. "jobs + approvals · 7 days".
  source: z.string().max(120),
});
export type HomeKpi = z.infer<typeof HomeKpi>;

export const HomeAgentActivity = z.object({
  agent: AgentKey,
  state: z.enum(["WORKING", "WAITING_ON_YOU", "IDLE"]),
  // Server-built from the record it points at, e.g. "#42 cart rounding · test"; null when idle.
  doing: z.string().max(200).nullable(),
  ref: HomeRef.nullable(),
  // Estimates (FR-OBS-03): jobs' estimatedCostUsd + ai_spend created today (local day), like the performance view.
  costTodayUsd: z.number().nonnegative(),
});
export type HomeAgentActivity = z.infer<typeof HomeAgentActivity>;

export const HomeExecution = z.object({
  jobId: z.uuid(),
  title: z.string().max(300),
  agent: AgentKey,
  status: JobStatus,
  // The latest stage the run reported; null before it reported one (QUEUED, PREPARING).
  stage: RunStage.nullable(),
  needsYou: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type HomeExecution = z.infer<typeof HomeExecution>;

export const HomeResultKind = z.enum([
  "PULL_REQUESTS", // EXECUTED approvals with a GitHub result
  "ISSUES_CREATED", // job drafts + opportunities with a GitHub-confirmed issue
  "TESTS_VERIFIED", // jobs whose NEXUS-run verification passed
  "DEEP_DIVES", // COMPLETED deep dives
  "AI_SPEND", // jobs' estimates + ai_spend, USD (estimate)
]);
export type HomeResultKind = z.infer<typeof HomeResultKind>;

export const HomeResult = z.object({
  kind: HomeResultKind,
  value: z.number().nonnegative(),
  // e.g. "draft PRs GitHub confirmed"
  label: z.string().max(160),
  // e.g. "GitHub · 7 days"
  source: z.string().max(120),
});
export type HomeResult = z.infer<typeof HomeResult>;

export const HomeSummary = z.object({
  // Local date and time in the owner's timezone, for "TUESDAY 27 OCTOBER · 14:32".
  date: z.iso.date(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string(),
  headline: HomeHeadline,
  decisions: HomeDecisions,
  kpis: z.array(HomeKpi).length(4),
  // Every AgentKey, in AgentKey order.
  agents: z.array(HomeAgentActivity),
  // Non-terminal jobs, newest first, at most 8.
  execution: z.array(HomeExecution).max(8),
  // The last 7 local days; every kind, zeros included.
  results: z.array(HomeResult),
  asOf: z.iso.datetime(),
});
export type HomeSummary = z.infer<typeof HomeSummary>;

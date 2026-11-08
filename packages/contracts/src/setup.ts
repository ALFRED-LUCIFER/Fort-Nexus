import { z } from "zod";

// What NEXUS still needs before it can do work, checked live on the home machine (no secret ever leaves it).
// GITHUB: the app exists and is installed. REPOSITORIES: the project (or any Dev project) has a bound repository.
// AI_PROVIDER: ~/.nexus/ai.json is usable. RUNNER: a paired runner is online. WEB_SEARCH (optional): search.json.
// CLAUDE_CLOUD (optional): ~/.nexus/claude-cloud.json names at least one routine for issue handoff.

export const SetupStepKey = z.enum([
  "GITHUB",
  "REPOSITORIES",
  "AI_PROVIDER",
  "RUNNER",
  "WEB_SEARCH",
  "CLAUDE_CLOUD",
]);
export type SetupStepKey = z.infer<typeof SetupStepKey>;

export const SetupStep = z.object({
  key: SetupStepKey,
  done: z.boolean(),
  /** Optional steps don't hold `ready` back. */
  optional: z.boolean(),
  /** One owner-facing sentence: what is there, or what to do. Never a file's content. */
  detail: z.string(),
  /** A runbook path on the home machine, when the step is done there. */
  runbook: z.string().nullable(),
});
export type SetupStep = z.infer<typeof SetupStep>;

// GET /v1/setup?projectId=
export const SetupQuery = z.object({ projectId: z.uuid().optional() });
export type SetupQuery = z.infer<typeof SetupQuery>;

export const SetupStatus = z.object({
  steps: z.array(SetupStep),
  /** Every required step is done: NEXUS can take a job from words to a draft PR. */
  ready: z.boolean(),
  checkedAt: z.iso.datetime(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

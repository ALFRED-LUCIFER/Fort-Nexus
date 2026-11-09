import { z } from "zod";

// Self-healing runs: the bounded repair loop, the QA reviewer's findings, and owner feedback sent mid-run.

export const REPAIR_ROUNDS = 3;
export const FEEDBACK_MAX = 2000;

export const QaDefect = z.strictObject({
  severity: z.enum(["blocking", "minor"]),
  file: z.string().max(4096).nullable(),
  evidence: z.string().max(1000),
});
export type QaDefect = z.infer<typeof QaDefect>;

// "could_not_run": the reviewer didn't finish; that is shown as such, never as a pass.
export const QaReview = z.strictObject({
  status: z.enum(["reviewed", "could_not_run"]),
  verdict: z.enum(["pass", "defects"]).nullable(),
  defects: z.array(QaDefect).max(20),
  reason: z.string().max(500).nullable(),
});
export type QaReview = z.infer<typeof QaReview>;

// What the runner reports when it stops without a passing result: what was tried and what to do next.
export const StuckReport = z.strictObject({
  rounds: z
    .array(
      z.strictObject({
        round: z.int().positive(),
        tried: z.string().max(1000),
        result: z.string().max(1000),
      }),
    )
    .max(REPAIR_ROUNDS + 1),
  stillFailing: z.string().max(2000),
  rootCauseGuess: z.string().max(1000).nullable(),
  nextStep: z.string().max(1000),
});
export type StuckReport = z.infer<typeof StuckReport>;

export const JobFeedbackRequest = z.strictObject({ text: z.string().trim().min(1).max(FEEDBACK_MAX) });
export type JobFeedbackRequest = z.infer<typeof JobFeedbackRequest>;

export const JobFeedback = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  text: z.string(),
  createdAt: z.iso.datetime(),
  // The repair round that picked it up; null while still waiting.
  deliveredRound: z.int().nonnegative().nullable(),
});
export type JobFeedback = z.infer<typeof JobFeedback>;

export const JobFeedbackList = z.object({ items: z.array(JobFeedback) });
export type JobFeedbackList = z.infer<typeof JobFeedbackList>;

// Owner asks a stopped run to keep going from its saved changes, optionally with a note.
export const KeepFixingRequest = z.strictObject({ note: z.string().trim().min(1).max(FEEDBACK_MAX).optional() });
export type KeepFixingRequest = z.infer<typeof KeepFixingRequest>;

// Runner pulls the feedback waiting for the round it is about to start.
export const ClaimFeedbackRequest = z.strictObject({
  fencingToken: z.int().positive(),
  round: z.int().nonnegative(),
});
export type ClaimFeedbackRequest = z.infer<typeof ClaimFeedbackRequest>;

export const ClaimFeedbackResponse = z.object({
  items: z.array(z.object({ id: z.uuid(), text: z.string() })),
});
export type ClaimFeedbackResponse = z.infer<typeof ClaimFeedbackResponse>;

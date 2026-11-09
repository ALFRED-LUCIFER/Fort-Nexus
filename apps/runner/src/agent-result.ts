import { z } from "zod";
import type { QaDefect } from "@nexus/contracts";

// What the agent reports in its output. Display and control input from a model, never authority for a pass:
// tests and NEXUS's own checks decide that.

const PHASE_TEXT_MAX = 2_000;
const MAX_DEFECTS = 20; // the upload contract's cap (QaReview.defects)
const EVIDENCE_MAX = 1_000;
const FILE_MAX = 4_096;
const MAX_QUESTIONS = 10;
const QUESTION_MAX = 1_000;

export const PHASES = ["understand", "spec", "grill", "red", "green", "review"] as const;
export type Phase = (typeof PHASES)[number];

const PhaseLine = z.object({ phase: z.enum(PHASES), text: z.string() });

const parseJsonAfter = (line: string, tag: string): unknown => {
  if (!line.startsWith(`${tag} `)) return undefined;
  try {
    return JSON.parse(line.slice(tag.length + 1));
  } catch {
    return undefined;
  }
};

export function parsePhaseLine(line: string): { phase: Phase; text: string } | null {
  const r = PhaseLine.safeParse(parseJsonAfter(line.trim(), "NEXUS_PHASE"));
  return r.success ? { phase: r.data.phase, text: r.data.text.slice(0, PHASE_TEXT_MAX) } : null;
}

const Done = z.object({ status: z.literal("done") });
const NeedsInfo = z.object({
  status: z.literal("needs_info"),
  questions: z.array(z.string().trim().min(1)).min(1),
});
const Qa = z.object({
  status: z.literal("qa"),
  verdict: z.enum(["pass", "defects"]),
  defects: z
    .array(
      z.object({
        severity: z.enum(["blocking", "minor"]),
        file: z.string().nullish(),
        evidence: z.string(),
      }),
    )
    .default([]),
});
const Result = z.discriminatedUnion("status", [Done, NeedsInfo, Qa]);

export type AgentResult =
  | { status: "done" }
  | { status: "needs_info"; questions: string[] }
  | { status: "qa"; verdict: "pass" | "defects"; defects: QaDefect[] };

/** Only the last non-empty line counts, so text quoted earlier (issue data, tool output) can't forge it. */
export function parseResult(finalText: string): AgentResult | null {
  const last = finalText
    .split("\n")
    .map((l) => l.trim())
    .findLast(Boolean);
  if (!last) return null;
  const r = Result.safeParse(parseJsonAfter(last, "NEXUS_RESULT"));
  if (!r.success) return null;
  const v = r.data;
  switch (v.status) {
    case "done":
      return { status: "done" };
    case "needs_info":
      return {
        status: "needs_info",
        questions: v.questions.slice(0, MAX_QUESTIONS).map((q) => q.slice(0, QUESTION_MAX)),
      };
    case "qa":
      // Truncate to the upload contract, never rejecting a review for length. Blocking defects go first
      // so the cap can't drop one.
      return {
        status: "qa",
        verdict: v.verdict,
        defects: [
          ...v.defects.filter((d) => d.severity === "blocking"),
          ...v.defects.filter((d) => d.severity !== "blocking"),
        ]
          .slice(0, MAX_DEFECTS)
          .map((d) => ({
            severity: d.severity,
            file: d.file ? d.file.slice(0, FILE_MAX) : null,
            evidence: d.evidence.slice(0, EVIDENCE_MAX),
          })),
      };
  }
}

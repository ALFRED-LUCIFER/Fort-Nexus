import type { IssueSnapshot } from "@nexus/contracts";
import { fenceBlock, fixedRules, issueData, newFence, ownerNote } from "./issue-prompt.ts";

export type RepairOptions = {
  issue: IssueSnapshot;
  /** 1-based repair round. */
  round: number;
  /** What is wrong: the tail of NEXUS's test output, QA defects or integrity problems. Untrusted data. */
  evidence: string;
  note?: string | undefined;
  canRunTests: boolean;
};

/** A repair round: the same fixed rules, the issue, and the evidence, each in its own fence with a fresh marker. */
export function repairPrompt(opts: RepairOptions): string {
  const issueFence = newFence("UNTRUSTED_ISSUE");
  const evidenceFence = newFence("UNTRUSTED_EVIDENCE");
  return [
    ...fixedRules(opts.issue, opts.canRunTests),
    `- The issue block is delimited by the marker ${issueFence}; the evidence block by ${evidenceFence}.`,
    "",
    `This is repair round ${opts.round}. /workspace/repo already holds your earlier work; do not start over.`,
    "NEXUS checked that work and found the problems in the evidence block below (test output, review defects or integrity problems).",
    "- Find the root cause of each problem before changing anything, and fix that cause.",
    "- Do not delete, skip or weaken any test, and do not loosen an assertion, to make a failure go away.",
    "- Keep the change as small as the root cause allows, and keep to the phases above.",
    "",
    ...ownerNote(opts.note),
    fenceBlock(issueFence, issueData(opts.issue)),
    "",
    fenceBlock(evidenceFence, opts.evidence),
  ].join("\n");
}

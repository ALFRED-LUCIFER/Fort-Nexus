import { useId, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, ApprovalDecisionRequest } from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { shortHash, until, useNow } from "../lib/queries.ts";
import { TEST_WORD } from "./runEvents.ts";
import { decisionBlocked, useScope } from "./scope.tsx";

// The API answers 409 when the hash no longer matches, the approval was already decided or expired, or the job moved on.
const CHANGED =
  "This approval changed after you opened it (new details, already decided, expired or withdrawn), so nothing was decided. The latest state is shown now: check it before deciding again.";

const pushTitle = (a: Approval) => `Push ${a.action.headBranch} and open a draft PR?`;

/**
 * Deny / Approve for one approval. Approve asks for confirmation first; both post the actionHash of the
 * approval as it was shown (the API rejects it with 409 if the action changed since).
 */
export function DecisionButtons({
  approval,
  approveLabel,
  context,
}: {
  approval: Approval;
  approveLabel: string;
  /** Screen-reader context when several approvals are listed together. */
  context?: string;
}) {
  const sr = context && (
    <>
      {" "}
      <span className="sr-only">{context}</span>
    </>
  );
  const queryClient = useQueryClient();
  // Approvals are decided inside their own project only; "All" is read-only (FR-WKS-02, C-05).
  const blocked = decisionBlocked(useScope(), approval);
  const blockedId = useId();
  const [confirming, setConfirming] = useState<Approval | null>(null);
  const decide = useMutation({
    mutationFn: ({ a, decision }: { a: Approval; decision: ApprovalDecisionRequest["decision"] }) =>
      api.decide(a.id, { decision, actionHash: a.actionHash }),
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
    },
  });
  const error =
    decide.error instanceof ApiRequestError &&
    decide.error.status === 409 &&
    decide.error.code !== "EMERGENCY_STOP"
      ? CHANGED
      : decide.error?.message;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={decide.isPending || !!blocked}
          aria-describedby={blocked ? blockedId : undefined}
          onClick={() => decide.mutate({ a: approval, decision: "deny" })}
          className="flex-1 rounded-xl border border-hair px-3 py-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink2 disabled:opacity-60"
        >
          Deny{sr}
        </button>
        <button
          type="button"
          disabled={decide.isPending || !!blocked}
          aria-describedby={blocked ? blockedId : undefined}
          onClick={() => setConfirming(approval)}
          className="flex-1 rounded-xl bg-amber px-3 py-2.5 text-[12.5px] font-medium whitespace-nowrap text-onacc disabled:opacity-60"
        >
          {decide.isPending ? "Sending…" : approveLabel}
          {sr}
        </button>
      </div>
      {blocked && (
        <p id={blockedId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {blocked}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
          {error}
        </p>
      )}
      {confirming && (
        <Dialog.Root open onOpenChange={(open) => !open && !decide.isPending && setConfirming(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-20 bg-black/30" />
            <Dialog.Content
              role="alertdialog"
              className="glass2 fixed top-1/2 left-1/2 z-20 flex w-[min(460px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-[30px] p-6 outline-none"
            >
              <Dialog.Title className="m-0 font-serif text-[24px] leading-tight font-normal">
                Approve this push?
              </Dialog.Title>
              <Dialog.Description className="m-0 text-[13.5px] leading-[1.55] text-ink2">
                NEXUS will push {fileCount(confirming)} to the new branch{" "}
                <code className="font-mono text-ink">{confirming.action.headBranch}</code> on{" "}
                <strong className="font-medium text-ink">{confirming.action.repositoryFullName}</strong> and
                open a draft PR against{" "}
                <code className="font-mono text-ink">{confirming.action.baseBranch}</code>. It never merges.{" "}
                {testsSentence(confirming)} Action hash {shortHash(confirming.actionHash)}.
              </Dialog.Description>
              {decide.isPending && (
                <p role="status" className="m-0 text-[12.5px] leading-snug text-ink2">
                  Pushing the branch and opening the draft PR on GitHub. This can take a moment.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close
                  disabled={decide.isPending}
                  className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2"
                >
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ a: confirming, decision: "approve" })}
                  className="rounded-xl bg-amber px-3.5 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
                >
                  {decide.isPending ? "Pushing and opening the draft PR…" : "Approve push"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}

// FR-DEV-05: NEXUS's own test result, in the words the owner decides on.
const testsSentence = (a: Approval) =>
  ({
    passed: "NEXUS ran the tests in the sandbox: they passed.",
    failed: `NEXUS ran the tests in the sandbox: they FAILED (exit code ${a.action.verification.exitCode ?? "?"}).`,
    error: `NEXUS couldn't run the tests${a.action.verification.reason ? `: ${a.action.verification.reason}` : ""}.`,
    not_configured: "The tests were not verified by NEXUS.",
  })[a.action.verification.status];

const testsFact = (a: Approval) => {
  const v = a.action.verification;
  if (v.status === "not_configured") return "not verified by NEXUS";
  return `${TEST_WORD[v.status]}${v.exitCode === null ? "" : ` (exit ${v.exitCode})`} · run by NEXUS in the sandbox`;
};

const fileCount = (a: Approval) =>
  `${a.action.files.length} ${a.action.files.length === 1 ? "file" : "files"}`;

const GATE: Record<Approval["status"], { kicker: string; tone: string; bg: string }> = {
  PENDING: { kicker: "Approval gate · R2", tone: "var(--amber)", bg: "oklch(0.70 0.13 65 / .13)" },
  APPROVED: { kicker: "Approved · audited", tone: "var(--amber)", bg: "oklch(0.70 0.13 65 / .13)" },
  EXECUTED: { kicker: "Approved · draft PR open", tone: "var(--green)", bg: "oklch(0.60 0.10 155 / .12)" },
  DENIED: { kicker: "Denied", tone: "var(--ink3)", bg: "var(--hair)" },
  EXPIRED: { kicker: "Expired", tone: "var(--ink3)", bg: "var(--hair)" },
  FAILED: { kicker: "Push failed", tone: "var(--coral)", bg: "oklch(0.62 0.15 32 / .12)" },
};

/** The push approval card of an issue run (design: dRun gate), showing exactly what the owner decides on. */
export function ApprovalGate({ approval: a, jobCancelled }: { approval: Approval; jobCancelled: boolean }) {
  const now = useNow(30_000);
  const g = GATE[a.status];
  const { action } = a;
  const facts: [string, ReactNode][] = [
    ["repository", action.repositoryFullName],
    [
      "branch",
      <>
        {action.baseBranch} ← <span className="text-ink">{action.headBranch}</span>
      </>,
    ],
    ["pr title", action.title],
    [
      "changes",
      <>
        {fileCount(a)} · <span className="text-green">+{action.stats.added}</span>{" "}
        <span className="text-coral">−{action.stats.removed}</span>
      </>,
    ],
    [
      "tests",
      <span className={action.verification.status === "passed" ? "text-green" : "text-ink"}>
        {testsFact(a)}
      </span>,
    ],
    ["action hash", <span title={a.actionHash}>{shortHash(a.actionHash)}</span>],
  ];
  const testsBad = action.verification.status === "failed" || action.verification.status === "error";
  if (a.status === "PENDING") facts.push(["expires", until(a.expiresAt, now)]);

  return (
    <section
      aria-labelledby="gate-title"
      className="flex flex-col gap-2.5 rounded-[18px] border p-4"
      style={{ background: g.bg, borderColor: g.tone }}
    >
      <span className="kicker" style={{ color: g.tone }}>
        {g.kicker}
      </span>
      <h3 id="gate-title" className="m-0 font-serif text-[20px] leading-[1.2] font-normal text-ink">
        {a.status === "EXECUTED" && a.result ? (
          <a href={a.result.pullRequestUrl} target="_blank" rel="noopener noreferrer" className="underline">
            Draft PR #{a.result.pullRequestNumber} opened — review on GitHub
            <span className="sr-only"> (opens GitHub in a new tab)</span>
          </a>
        ) : (
          {
            PENDING: pushTitle(a),
            APPROVED: "Approved. Pushing the branch and opening the draft PR…",
            EXECUTED: "Approved. Waiting for GitHub's answer…",
            // Cancelling a run that awaits approval withdraws the approval as DENIED.
            DENIED: jobCancelled
              ? "Run cancelled, so the push was withdrawn. Nothing was pushed."
              : "You denied this push. Nothing was pushed.",
            EXPIRED: "No decision in time. Nothing was pushed.",
            FAILED: "GitHub didn't accept the push.",
          }[a.status]
        )}
      </h3>
      {a.status === "PENDING" && testsBad && (
        <p
          role="note"
          className="m-0 rounded-xl px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink"
          style={{ background: "oklch(0.70 0.13 65 / .22)" }}
        >
          <strong className="font-medium">
            {action.verification.status === "failed" ? "Tests failed." : "Tests couldn't run."}
          </strong>{" "}
          {testsSentence(a)} You can still approve: the draft PR says so too. Check the test output in this
          run first.
        </p>
      )}
      {a.status === "EXPIRED" && (
        <p className="m-0 text-[12.5px] leading-[1.45] text-ink2">
          Approvals lapse after 24 hours so a stale change is never pushed. Start a new run to try again.
        </p>
      )}
      {a.status === "FAILED" && (
        <p className="m-0 text-[12.5px] leading-[1.45] text-ink2">
          {a.error ?? "The API gave no reason."} Nothing was merged; the branch may need a look on GitHub.
        </p>
      )}
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11.5px] leading-[1.45]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink3">{k}</dt>
            <dd className="m-0 break-words text-ink2">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[12px] leading-[1.45] text-ink2">
        Never merges. {action.baseBranch} is protected. The PR opens as a draft.
      </p>
      <details className="text-[12px] text-ink2">
        <summary className="cursor-pointer font-medium text-ink">Exact PR text</summary>
        <p className="mt-2 mb-0 max-h-48 overflow-auto rounded-xl bg-hair p-3 font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap">
          {action.body}
        </p>
      </details>
      {a.status === "PENDING" && <DecisionButtons approval={a} approveLabel="Approve push" />}
    </section>
  );
}

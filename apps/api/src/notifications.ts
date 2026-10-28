import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import type {
  Approval,
  JobOutcome,
  JobStatus,
  ListNotificationsQuery,
  Notification,
  NotificationCategory,
  NotificationList,
  SetNotificationStatusRequest,
  Verification,
} from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { approvals, jobs, notifications } from "./db/schema.ts";
import { notFound } from "./errors.ts";
import { ownerActor, type NewEvent } from "./jobs.ts";

// FR-NTF-01/02/04/05/06: verified events → one deduplicated notification each, written in the event's own
// transaction. Text is built from recorded facts only (PRD §15.3), never from agent narration.

type Row = typeof notifications.$inferSelect;
type Draft = {
  ownerId: string;
  projectId: string | null;
  category: NotificationCategory;
  title: string;
  body: string;
  jobId?: string | null;
  approvalId?: string | null;
  /** Unique per logical event: a retried or replayed write of the same event inserts nothing. */
  dedupKey: string;
};
type JobFacts = Pick<
  typeof jobs.$inferSelect,
  "id" | "initiatorId" | "projectId" | "jobType" | "request" | "issueSnapshot"
>;

const NOTIFIED_STATES = new Set<JobStatus>(["COMPLETED", "FAILED", "RECOVERY_REQUIRED"]);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const toNotificationDto = (n: Row): Notification => ({
  id: n.id,
  projectId: n.projectId,
  category: n.category,
  title: n.title,
  body: n.body,
  subject: { jobId: n.jobId, approvalId: n.approvalId },
  status: n.status,
  createdAt: n.createdAt.toISOString(),
});

async function insert(tx: Tx, drafts: Draft[]) {
  if (drafts.length === 0) return;
  await tx
    .insert(notifications)
    .values(drafts.map((d) => ({ ...d, title: clip(d.title, 200), body: clip(d.body, 1000) })))
    .onConflictDoNothing({ target: notifications.dedupKey });
}

/** Owner-wide security notice (emergency stop, runner revoked); `dedupKey` names the one event. */
export const notifySecurity = (
  tx: Tx,
  d: { ownerId: string; dedupKey: string; title: string; body: string },
) => insert(tx, [{ ...d, projectId: null, category: "SECURITY_CRITICAL" }]);

// ── Job and approval events ──

const stateTo = (e: NewEvent) =>
  e.type === "job.state.changed" ? (e.payload?.to as JobStatus | undefined) : undefined;
const triggers = (e: NewEvent) =>
  NOTIFIED_STATES.has(stateTo(e)!) ||
  e.type === "approval.requested" ||
  (e.type === "approval.decided" && e.payload?.decision === "expired");

const subjectOf = (j: JobFacts) =>
  j.issueSnapshot
    ? `${j.issueSnapshot.fullName}#${j.issueSnapshot.issueNumber}`
    : j.request.jobType === "RUNNER_DIAGNOSTIC"
      ? `${j.request.preset} diagnostic`
      : "run";

export function testsFact(v: Verification): string {
  switch (v.status) {
    case "passed":
      return "Tests passed (run by NEXUS in the sandbox)";
    case "failed":
      return `Tests FAILED with exit code ${v.exitCode ?? "?"} (run by NEXUS in the sandbox)`;
    case "error":
      return `Tests couldn't run${v.reason ? `: ${v.reason}` : ""}`;
    case "not_configured":
      return "Tests not verified by NEXUS";
  }
}

// Failure reasons the API and runner record → [what happened, what to do next]. Unknown codes fall back below.
const REASONS: Record<string, [string, string]> = {
  timeout: [
    "The command ran past its time limit.",
    "Start it again; if it keeps timing out, check the runner host.",
  ],
  budget_exceeded: [
    "The agent reached this run's budget.",
    "Narrow the issue or raise the run's limits, then start a new run.",
  ],
  BUDGET_EXHAUSTED: [
    "Today's AI budget was used up before the run could start.",
    "Raise the daily cap in Settings → Budgets & limits, or wait for the daily reset.",
  ],
  LEASE_EXPIRED: [
    "The runner stopped reporting while it held the run.",
    "Check the runner on the home machine. NEXUS never retries on its own; start a new run when it is back.",
  ],
  runner_shutdown: ["The runner shut down during the run.", "Restart the runner, then start a new run."],
  sandbox_unavailable: ["Docker isn't reachable on the runner host.", "Start Docker, then start a new run."],
  sandbox_image_missing: [
    "The sandbox image is missing on the runner host.",
    "Run `pnpm --filter @nexus/runner sandbox:build`, then start a new run.",
  ],
  sandbox_required: [
    "The runner refused to run without a sandbox.",
    "Set RUNNER_SANDBOX=docker on the runner, then start a new run.",
  ],
  stop_failed: [
    "The runner couldn't confirm the sandbox stopped.",
    "Check Docker on the runner host before starting another run.",
  ],
  fetch_failed: [
    "The runner couldn't fetch the repository.",
    "Check the GitHub App installation and the network, then start a new run.",
  ],
  base_sha_missing: [
    "The pinned base commit isn't on GitHub any more.",
    "Start a new run from the current branch.",
  ],
  GITHUB_TOKEN_UNAVAILABLE: [
    "NEXUS couldn't get a GitHub token for the repository.",
    "Check the GitHub App installation, then start a new run.",
  ],
  GITHUB_PUSH_FAILED: [
    "Pushing the branch or opening the draft PR failed; nothing was merged.",
    "Open the run for GitHub's answer, check the branch, then start a new run.",
  ],
  agent_failed: [
    "The coding agent stopped with an error.",
    "Open the run for the last output, then start a new run.",
  ],
  changeset_upload_failed: [
    "The runner couldn't hand the changes to NEXUS.",
    "Check the runner can reach the API, then start a new run.",
  ],
};

function failureText(
  j: JobFacts,
  to: JobStatus,
  outcome: JobOutcome | undefined,
  events: readonly NewEvent[],
) {
  const failed = events.find((e) => e.type === "job.failed" || e.type === "job.recovery_required");
  const raw = failed?.payload?.reason;
  // Runner-supplied: only a plain code is ever echoed.
  const reason = typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
  const [why, next] = (reason && REASONS[reason]) ?? [
    `The run failed${reason ? ` (${reason})` : ""}.`,
    "Open the run for the last output, then start a new run.",
  ];
  const head =
    to === "RECOVERY_REQUIRED"
      ? "Run needs recovery"
      : outcome === "TIMED_OUT"
        ? "Run timed out"
        : outcome === "BUDGET_EXCEEDED" || reason === "budget_exceeded"
          ? "Run stopped at its budget"
          : "Run failed";
  return { title: `${head} · ${subjectOf(j)}`, body: `${why} ${next}` };
}

async function completedText(tx: Tx, j: JobFacts, outcome: JobOutcome | undefined) {
  const subject = subjectOf(j);
  if (j.jobType !== "DEV_ISSUE_TO_PR")
    return {
      title: `Finished · ${subject}`,
      body:
        outcome === "COMMAND_SUCCEEDED"
          ? "The command succeeded. Open the run for its output."
          : "Open the run for its output.",
      approvalId: null,
    };
  const [a] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.jobId, j.id))
    .orderBy(desc(approvals.id))
    .limit(1);
  const tests = a ? `${testsFact(a.action.verification)}.` : "";
  // A PR is claimed only from GitHub's answer recorded on the executed approval (truth hierarchy).
  if (a?.status === "EXECUTED" && a.result)
    return {
      title: `Draft PR #${a.result.pullRequestNumber} opened · ${subject}`,
      body: `${tests} Review it on GitHub; NEXUS never merges.`,
      approvalId: a.id,
    };
  if (outcome === "APPROVAL_DENIED")
    return {
      title: `Push denied · ${subject}`,
      body: `You denied the push, so nothing was pushed and no PR exists. ${tests}`.trim(),
      approvalId: a?.id ?? null,
    };
  if (outcome === "COMPLETED_NO_CHANGES")
    return {
      title: `No changes · ${subject}`,
      body: "The agent changed no files, so there is nothing to review and no PR. Tests were not run.",
      approvalId: null,
    };
  return {
    title: `Run completed · ${subject}`,
    body: `${tests} No PR was opened.`.trim(),
    approvalId: a?.id ?? null,
  };
}

/**
 * The hook in writeEvents: notifications for these events of `jobId`, in the caller's transaction.
 * CANCELLED never notifies: only the owner (or their emergency stop) cancels.
 */
export async function notifyForJobEvents(tx: Tx, jobId: string, events: readonly NewEvent[]) {
  if (!events.some(triggers)) return;
  const [j] = await tx
    .select({
      id: jobs.id,
      initiatorId: jobs.initiatorId,
      projectId: jobs.projectId,
      jobType: jobs.jobType,
      request: jobs.request,
      issueSnapshot: jobs.issueSnapshot,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  if (!j) return;
  const base = { ownerId: j.initiatorId, projectId: j.projectId, jobId: j.id };
  const drafts: Draft[] = [];
  for (const e of events) {
    const to = stateTo(e);
    const outcome = e.payload?.outcome as JobOutcome | undefined;
    if (to === "COMPLETED") {
      const t = await completedText(tx, j, outcome);
      drafts.push({ ...base, category: "TASK_DONE", dedupKey: `job:${j.id}:COMPLETED`, ...t });
    } else if (to && NOTIFIED_STATES.has(to)) {
      drafts.push({
        ...base,
        category: "TASK_FAILED",
        dedupKey: `job:${j.id}:${to}`,
        ...failureText(j, to, outcome, events),
      });
    } else if (e.type === "approval.requested") {
      const a = e.payload?.approval as Approval;
      const { stats, files } = a.action;
      drafts.push({
        ...base,
        category: "APPROVAL_REQUIRED",
        approvalId: a.id,
        dedupKey: `approval:${a.id}:PENDING`,
        // "Ready for review" until GitHub confirms a PR: nothing has been pushed yet.
        title: `Ready for review · ${subjectOf(j)}`,
        body: `${testsFact(a.action.verification)}. +${stats.added} −${stats.removed} in ${files.length} ${files.length === 1 ? "file" : "files"}. No PR yet: approve the push to open a draft PR.`,
      });
    } else if (e.type === "approval.decided") {
      const approvalId = String(e.payload?.approvalId);
      drafts.push({
        ...base,
        category: "INFORMATIONAL",
        approvalId,
        dedupKey: `approval:${approvalId}:EXPIRED`,
        title: `Approval expired · ${subjectOf(j)}`,
        body: "Nobody approved the push in time, so nothing was pushed and no PR exists. Start a new run to try again.",
      });
    }
  }
  await insert(tx, drafts);
}

// ── Owner API ──

// Owner-wide notices (projectId null) belong to every project view.
const inProject = (projectId: string | undefined) =>
  projectId ? or(eq(notifications.projectId, projectId), isNull(notifications.projectId)) : undefined;

export async function listNotifications(
  db: Db,
  ownerId: string,
  q: ListNotificationsQuery,
): Promise<NotificationList> {
  const mine = and(eq(notifications.ownerId, ownerId), inProject(q.projectId));
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        mine,
        q.status ? eq(notifications.status, q.status) : undefined,
        q.category ? eq(notifications.category, q.category) : undefined,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(q.limit);
  const [unread] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(mine, eq(notifications.status, "UNREAD")));
  return { items: rows.map(toNotificationDto), unreadCount: unread?.n ?? 0 };
}

const RANK = { UNREAD: 0, READ: 1, ACKNOWLEDGED: 2 } as const;

/** READ / ACKNOWLEDGED; never moves back (an acknowledged notice stays acknowledged). */
export async function setNotificationStatus(
  db: Db,
  input: { ownerId: string; id: string; body: SetNotificationStatusRequest; correlationId: string },
): Promise<Notification> {
  return db.transaction(async (tx) => {
    const [n] = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, input.id), eq(notifications.ownerId, input.ownerId)))
      .for("update");
    if (!n) throw notFound("Notification");
    if (RANK[input.body.status] <= RANK[n.status]) return toNotificationDto(n);
    const [updated] = await tx
      .update(notifications)
      .set({ status: input.body.status, statusChangedAt: new Date() })
      .where(eq(notifications.id, n.id))
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: `notification.${input.body.status.toLowerCase()}`,
      resourceType: "notification",
      resourceId: n.id,
      correlationId: input.correlationId,
      metadata: { from: n.status, category: n.category },
    });
    return toNotificationDto(updated!);
  });
}

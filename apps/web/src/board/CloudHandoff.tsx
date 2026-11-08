import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CloudHandoff, CloudHandoffPreview, CloudHandoffState } from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { ago, clock, shortHash, until, useNow } from "../lib/queries.ts";

// Hand one issue to a Claude Code routine in Anthropic's cloud (docs/specs/cloud-handoff.md, runbook
// docs/runbooks/claude-cloud.md). The owner approves the exact text by its hash; NEXUS fires the routine once.
// Truth ladder: "Sent · session started" only from Anthropic's 200, "PR opened" and "Merged" only from GitHub.

const POLL_MS = 60_000;
const ROUTINES_URL = "https://claude.ai/code/routines";
const OFFLINE = "You're offline. NEXUS will check the cloud handoff when the connection is back.";
const AMBER_BG = "oklch(0.70 0.13 65 / .14)";

const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2 disabled:opacity-45";
const primaryBtn =
  "rounded-xl bg-teal px-3.5 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

/** Polls only while something can still change: a live session and no merged or closed PR known. */
export const polls = (h: CloudHandoff | null | undefined) =>
  !!h &&
  (h.status === "STARTING" || h.status === "STARTED" || h.status === "UNKNOWN") &&
  !(h.pullRequest && h.pullRequest.state !== "OPEN");

const detail = (e: unknown, k: string): unknown =>
  e instanceof ApiRequestError && typeof e.details === "object" && e.details !== null
    ? (e.details as Record<string, unknown>)[k]
    : undefined;
const retryAfter = (e: unknown) => {
  const s = detail(e, "retryAfterSeconds");
  return typeof s === "number" && s >= 0 ? s : null;
};

/**
 * Status, preview and focus state for one issue's cloud handoff. `projectId` is undefined while the issue can't
 * be handed off from this scope (no Dev project, or the repository isn't bound): nothing is fetched then.
 */
export function useCloudHandoff(repoId: string, number: number, projectId: string | undefined) {
  const state = useQuery({
    queryKey: keys.cloudHandoff(repoId, number, projectId ?? "none"),
    queryFn: () => api.cloudHandoff(repoId, number, projectId!),
    enabled: !!projectId,
    refetchInterval: (q) => (polls(q.state.data?.latest) ? POLL_MS : false),
  });
  const [open, setOpen] = useState(false);
  // One Idempotency-Key per previewed text: a retry of the same approval reuses it, a new preview gets a new one.
  const [held, setHeld] = useState<{ preview: CloudHandoffPreview; key: string } | null>(null);
  const preview = useMutation({
    mutationFn: () => api.previewCloudHandoff(repoId, number, projectId!),
    onMutate: () => setHeld(null),
    onSuccess: (p) => setHeld({ preview: p, key: crypto.randomUUID() }),
  });
  return {
    repoId,
    number,
    projectId,
    state,
    open,
    preview,
    held,
    start: () => {
      setOpen(true);
      preview.mutate();
    },
    close: () => {
      setOpen(false);
      setHeld(null);
      preview.reset();
    },
  };
}
export type CloudHandoffFlow = ReturnType<typeof useCloudHandoff>;

/** "Hand off to Claude (cloud)": offered only once the API says this repository has a routine. */
export function CloudHandoffButton({
  cloud,
  blockedBy,
  ref,
}: {
  cloud: CloudHandoffFlow;
  /** The id of the sentence explaining why runs can't start here (same guard as Start run). */
  blockedBy: string | null;
  ref?: Ref<HTMLButtonElement>;
}) {
  const configured = cloud.state.data?.routine.configured === true;
  if (!blockedBy && !configured) return null;
  return (
    <button
      ref={ref}
      type="button"
      disabled={!!blockedBy || cloud.preview.isPending}
      aria-describedby={blockedBy ?? undefined}
      aria-expanded={cloud.open}
      aria-controls={cloud.open ? "cloud-preview" : undefined}
      onClick={cloud.start}
      className="rounded-[14px] border border-hair px-4 py-3 text-[13px] font-medium text-ink disabled:opacity-45"
    >
      Hand off to Claude (cloud)
    </button>
  );
}

/** The routine hint or the latest handoff's status, plus the preview card while it is open. */
export function CloudHandoffPanel({ cloud, onClose }: { cloud: CloudHandoffFlow; onClose: () => void }) {
  const { state } = cloud;
  if (!cloud.projectId) return null;
  const offline = state.fetchStatus === "paused";
  if (!state.data)
    return state.error ? (
      <div className="flex flex-none flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-[13px] text-coral">
          Can&apos;t check the Claude cloud handoff: {state.error.message}
        </p>
        <button type="button" onClick={() => void state.refetch()} className={ghostBtn}>
          Try again
        </button>
      </div>
    ) : (
      <p role="status" className="m-0 flex-none text-[12.5px] text-ink3">
        {offline ? OFFLINE : "Checking the Claude cloud handoff…"}
      </p>
    );

  const { routine, latest } = state.data;
  return (
    <>
      {(state.error || offline) && (
        <p role="status" className="m-0 flex-none text-[12.5px] leading-normal text-amber">
          {offline ? "You're offline." : `Can't refresh the cloud handoff: ${state.error!.message}`} Showing
          what NEXUS had at {clock(new Date(state.dataUpdatedAt).toISOString())}.
        </p>
      )}
      {!routine.configured && (
        <p className="m-0 flex-none text-[12.5px] leading-snug text-ink2">
          Claude cloud handoff: {routine.detail}{" "}
          <span className="font-mono text-[11.5px] text-ink3">
            How: <span className="select-all">{routine.runbook}</span> on the home machine
          </span>
        </p>
      )}
      {latest && <HandoffStatus h={latest} />}
      {cloud.open && routine.configured && <PreviewSection cloud={cloud} latest={latest} onClose={onClose} />}
    </>
  );
}

// ---------------------------------------------------------------- status

const prState = (p: NonNullable<CloudHandoff["pullRequest"]>) =>
  p.state === "MERGED" ? "Merged" : p.state === "CLOSED" ? "Closed" : p.draft ? "Draft" : "Open";

function NewTabLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal underline">
      {children}
      <span className="sr-only"> (new tab)</span> ↗
    </a>
  );
}

function SessionLink({ url }: { url: string | null }) {
  if (!url) return null;
  // Only a claude.ai session is a link; the API already refuses anything else, this keeps it that way.
  return /^https:\/\/claude\.ai\//.test(url) ? (
    <NewTabLink href={url}>Open the session on claude.ai</NewTabLink>
  ) : (
    <span className="font-mono text-[11.5px] break-all text-ink3">{url}</span>
  );
}

function HandoffStatus({ h }: { h: CloudHandoff }) {
  const now = useNow(15_000);
  const live = h.status === "STARTED" || h.status === "UNKNOWN";
  const ladder: [string, boolean][] = [
    ["Sent · session started", h.status === "STARTED"],
    ["PR opened", !!h.pullRequest],
    ["Merged", h.pullRequest?.state === "MERGED"],
  ];
  const retryAt =
    h.retryAfterSeconds === null
      ? null
      : new Date(Date.parse(h.updatedAt) + h.retryAfterSeconds * 1000).toISOString();
  return (
    <section
      aria-labelledby="cloud-status-title"
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border border-hair p-4"
    >
      <h3 id="cloud-status-title" className="kicker m-0">
        Claude cloud handoff · sent {ago(h.createdAt, now)}
      </h3>
      <div aria-live="polite" className="flex flex-col gap-2.5">
        {h.status === "STARTING" && (
          <p className="m-0 text-[13px] text-ink2">
            Sending to Claude… NEXUS is starting this handoff right now.
          </p>
        )}
        {h.status === "STARTED" && (
          <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink">
            <span className="font-medium text-green">Session started</span>
            <SessionLink url={h.sessionUrl} />
          </p>
        )}
        {h.status === "UNKNOWN" && (
          <div
            role="note"
            className="flex flex-col gap-1.5 rounded-xl px-3.5 py-3"
            style={{ background: AMBER_BG }}
          >
            <span className="kicker" style={{ color: "var(--amber)" }}>
              Couldn&apos;t confirm the session
            </span>
            <span className="text-[13px] leading-normal text-ink">
              Anthropic didn&apos;t answer clearly (timeout or server error). A session may exist: look at the
              routine&apos;s runs on <NewTabLink href={ROUTINES_URL}>claude.ai</NewTabLink>. If none started,
              hand off again and confirm the second session. NEXUS never retries on its own.
            </span>
            {h.error && <span className="text-[12.5px] text-ink2">{h.error}</span>}
          </div>
        )}
        {h.status === "FAILED" && (
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[13px] leading-snug text-coral">
              Not sent: {h.error ?? "Anthropic refused the handoff. No session exists."}
            </p>
            {retryAt && (
              <p className="m-0 text-[12.5px] text-ink2">
                {until(retryAt, now) === "passed"
                  ? "Rate limit over: you can hand off again now."
                  : `Rate limited: you can hand off again ${until(retryAt, now)} (at ${clock(retryAt)}).`}
              </p>
            )}
          </div>
        )}

        {live && (
          <ol aria-label="Progress" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
            {ladder.map(([label, done]) => (
              <li
                key={label}
                className={`flex items-center gap-1.5 font-mono text-[11.5px] ${done ? "text-green" : "text-ink3"}`}
              >
                <span aria-hidden="true">{done ? "✓" : "○"}</span>
                {label}
                <span className="sr-only">{done ? ", done" : ", not yet"}</span>
              </li>
            ))}
          </ol>
        )}
        {h.pullRequest && (
          <p className="m-0 text-[13px] break-words text-ink">
            {/^https:\/\//.test(h.pullRequest.url) ? (
              <NewTabLink href={h.pullRequest.url}>PR #{h.pullRequest.number}</NewTabLink>
            ) : (
              `PR #${h.pullRequest.number}`
            )}{" "}
            · {prState(h.pullRequest)} · {h.pullRequest.title}
          </p>
        )}
        {h.pullRequestCheck === "UNAVAILABLE" && (
          <p className="m-0 text-[12.5px] text-amber">Couldn&apos;t check GitHub for the PR right now.</p>
        )}
        {live && !h.pullRequest && h.pullRequestCheck === "OK" && (
          <p className="m-0 text-[12.5px] text-ink3">
            GitHub shows no PR for it yet. NEXUS checks again every minute.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- preview → approve

function PreviewSection({
  cloud,
  latest,
  onClose,
}: {
  cloud: CloudHandoffFlow;
  latest: CloudHandoff | null;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // On open and whenever the card's content is replaced (a new preview), focus returns to its heading.
  const step = `${cloud.preview.status}:${cloud.held?.key ?? ""}`;
  useEffect(() => headingRef.current?.focus(), [step]);
  const cancel = () => {
    cloud.close();
    onClose();
  };
  return (
    <section
      aria-labelledby="cloud-preview-title"
      aria-busy={cloud.preview.isPending}
      id="cloud-preview"
      className="flex flex-none flex-col gap-4 rounded-[22px] border border-hair bg-card px-5 py-5"
    >
      <h3
        id="cloud-preview-title"
        ref={headingRef}
        tabIndex={-1}
        className="m-0 font-serif text-[22px] leading-tight font-normal italic outline-none"
      >
        Here’s exactly what Claude will receive.
      </h3>
      {cloud.held ? (
        <PreviewCard
          key={cloud.held.key}
          cloud={cloud}
          preview={cloud.held.preview}
          idemKey={cloud.held.key}
          latest={latest}
          onCancel={cancel}
          onSent={() => {
            cloud.close();
            onClose();
          }}
        />
      ) : cloud.preview.error ? (
        <>
          <p role="alert" className="m-0 text-[13px] text-coral">
            {cloud.preview.error.message}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={cancel} className={ghostBtn}>
              Cancel
            </button>
            <button type="button" onClick={cloud.start} className={primaryBtn}>
              Try again
            </button>
          </div>
        </>
      ) : (
        <p role="status" className="m-0 text-[13px] text-ink3">
          Building the preview from the issue on GitHub…
        </p>
      )}
    </section>
  );
}

function PreviewCard({
  cloud,
  preview: p,
  idemKey,
  latest,
  onCancel,
  onSent,
}: {
  cloud: CloudHandoffFlow;
  preview: CloudHandoffPreview;
  idemKey: string;
  latest: CloudHandoff | null;
  onCancel: () => void;
  onSent: () => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow(15_000);
  // Confirming a second session is a different request body, so it gets its own key.
  const [resendKey] = useState(() => crypto.randomUUID());
  const [resend, setResend] = useState(false);
  const stateKey = keys.cloudHandoff(cloud.repoId, cloud.number, p.projectId);
  const approve = useMutation({
    mutationFn: (confirmResend: boolean) =>
      api.createCloudHandoff(
        cloud.repoId,
        cloud.number,
        { projectId: p.projectId, actionHash: p.actionHash, confirmResend },
        confirmResend ? resendKey : idemKey,
      ),
    onSuccess: (h) => {
      queryClient.setQueryData<CloudHandoffState>(stateKey, (old) => old && { ...old, latest: h });
      onSent();
    },
    // A refusal, a rate limit or an unclear answer all change the issue's newest handoff: read it again.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: stateKey }),
  });

  const e = approve.error;
  const err = e instanceof ApiRequestError ? e : null;
  const needsConfirm = detail(e, "needsConfirmResend") === true;
  const upstream = err?.code === "UPSTREAM";
  const rateLimited = err?.code === "RATE_LIMITED";
  const refused = err?.status === 409 && !needsConfirm;
  const expired = until(p.expiresAt, now) === "passed";
  const retryS = retryAfter(e);
  const retryAt =
    rateLimited && retryS !== null ? new Date(approve.submittedAt + retryS * 1000).toISOString() : null;
  // After these the same approval can't help: preview again, wait, or check claude.ai first.
  const canApprove = !needsConfirm && !upstream && !rateLimited && !refused && !expired;
  // When an answer removes the Approve button, focus lands on Cancel/Close (never on a button that sends).
  const footerRef = useRef<HTMLDivElement>(null);
  const lostApprove = approve.isError && !canApprove;
  useEffect(() => {
    if (lostApprove) footerRef.current?.querySelector("button")?.focus();
  }, [lostApprove]);

  const rows = [
    ...p.rows,
    { k: "Routine", v: p.routineId },
    { k: "Action hash", v: shortHash(p.actionHash) },
    { k: "Expires", v: until(p.expiresAt, now) },
  ];

  return (
    <>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
        {rows.map((r) => (
          <div key={r.k} className="flex min-w-0 flex-col gap-1.5">
            <dt className="kicker">{r.k}</dt>
            <dd className="m-0 text-[13px] leading-snug break-words">{r.v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1.5">
        <span id="cloud-text-label" className="kicker">
          Exact text NEXUS will send · {p.repositoryFullName} #{p.issueNumber}
        </span>
        {/* Plain text: React escapes it, nothing in the issue is rendered as HTML. */}
        <pre
          // Scrollable text must be keyboard-reachable (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-labelledby="cloud-text-label"
          className="m-0 max-h-60 overflow-auto rounded-xl bg-hair p-3 font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap text-ink"
        >
          {p.text}
        </pre>
      </div>

      {expired && !e && (
        <p className="m-0 text-[12.5px] text-ink2">This preview has expired; preview it again.</p>
      )}
      {needsConfirm && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl px-3.5 py-3"
          style={{ background: AMBER_BG }}
        >
          <span className="kicker" style={{ color: "var(--amber)" }}>
            Claude is already on this issue
          </span>
          <span className="text-[13px] leading-normal text-ink">{e!.message}</span>
          {latest?.sessionUrl && <SessionLink url={latest.sessionUrl} />}
          <span className="text-[12.5px] text-ink2">
            Sending again starts a second, separate session on claude.ai.
          </span>
        </div>
      )}
      {upstream && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-xl px-3.5 py-3"
          style={{ background: AMBER_BG }}
        >
          <span className="kicker" style={{ color: "var(--amber)" }}>
            Couldn&apos;t confirm the session
          </span>
          <span className="text-[13px] leading-normal text-ink">
            {e!.message} It may have started: check the routine&apos;s runs on{" "}
            <NewTabLink href={ROUTINES_URL}>claude.ai</NewTabLink> before handing off again.
          </span>
        </div>
      )}
      {e && !needsConfirm && !upstream && (
        <div className="flex flex-col gap-1">
          <p role="alert" className="m-0 text-[13px] leading-snug text-coral">
            {e.message}
          </p>
          {retryAt && (
            <p className="m-0 text-[12.5px] text-ink2">
              You can hand off again {until(retryAt, now)} (at {clock(retryAt)}).
            </p>
          )}
          {err?.status === 0 && (
            <p className="m-0 text-[12.5px] text-ink2">
              If NEXUS did send it, approving again returns that handoff instead of starting a second session.
            </p>
          )}
        </div>
      )}
      {approve.isPending && (
        <p role="status" className="m-0 text-[12.5px] text-ink2">
          Waiting for Anthropic&apos;s answer. Nothing shows as started until it confirms.
        </p>
      )}

      <div ref={footerRef} className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink3">
          Runs in Anthropic&apos;s cloud on your claude.ai plan. Ends in a draft PR at most.
        </span>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onCancel} className={ghostBtn}>
            {upstream || rateLimited ? "Close" : "Cancel"}
          </button>
          {(refused || expired) && !needsConfirm && (
            <button type="button" onClick={cloud.start} className={primaryBtn}>
              Preview again
            </button>
          )}
          {needsConfirm && (
            <button
              type="button"
              disabled={approve.isPending}
              onClick={() => {
                setResend(true);
                approve.mutate(true);
              }}
              className={primaryBtn}
            >
              {approve.isPending ? "Sending…" : "Confirm: start another session"}
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              disabled={approve.isPending}
              onClick={() => approve.mutate(resend)}
              className={primaryBtn}
            >
              {approve.isPending ? "Sending…" : "Approve and send"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

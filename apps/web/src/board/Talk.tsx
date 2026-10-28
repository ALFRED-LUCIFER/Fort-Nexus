import { useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActionProposal, Basis, SourceRef, Turn } from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { ago, clock, shortHash, until, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";

// Talk, text only (EPIC CWV/CXR). Replies come from the API, built from NEXUS's own records; the owner's click on
// a proposal is the only approval.

const route = getRouteApi("/");

export function TalkDrawer({
  threadId,
  banner,
  onClose,
}: {
  threadId?: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      {threadId ? <ThreadView id={threadId} /> : <ThreadList />}
    </Drawer>
  );
}

function useOpen() {
  const navigate = route.useNavigate();
  const { ws } = route.useSearch();
  return (drawer: string) => void navigate({ search: { ws, drawer } });
}

function ThreadList() {
  const open = useOpen();
  const now = useNow(30_000);
  const threads = useQuery({ queryKey: keys.threads, queryFn: api.threads });
  const create = useMutation({ mutationFn: api.createThread, onSuccess: (t) => open(`talk:${t.id}`) });
  const items = threads.data?.items ?? [];

  return (
    <>
      <DrawerHeader kicker="Talk · text" title="Talk to NEXUS" />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pt-5 pb-6">
        <p className="m-0 text-[13.5px] leading-relaxed text-ink2">
          Ask how a run is going, list recent runs, or ask NEXUS to work on a GitHub issue. Answers cite the
          records they come from, and nothing starts until you confirm it on screen.
        </p>
        <button
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
          className="self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
        >
          {create.isPending ? "Starting…" : "New conversation"}
        </button>
        {create.error && (
          <p role="alert" className="m-0 text-[12.5px] text-coral">
            {create.error.message}
          </p>
        )}
        {!threads.data ? (
          <DrawerState error={threads.error} />
        ) : items.length === 0 ? (
          <p className="m-0 text-[14px] text-ink2">No conversations yet.</p>
        ) : (
          <ul aria-label="Conversations" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {items.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => open(`talk:${t.id}`)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-2xl border border-hair px-4 py-3 text-left"
                >
                  <span className="min-w-0 truncate text-[14px] font-medium text-ink">{t.title}</span>
                  <span className="flex-none font-mono text-[11px] text-ink3">{ago(t.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const SEND_FAILED: Record<string, string> = {
  UNREACHABLE: "Your message wasn't sent: NEXUS can't be reached. Send again to retry it safely.",
};

function ThreadView({ id }: { id: string }) {
  const open = useOpen();
  const queryClient = useQueryClient();
  const thread = useQuery({ queryKey: keys.thread(id), queryFn: () => api.thread(id) });
  const [text, setText] = useState("");
  // One Idempotency-Key per message: resending the same text after a failure can't produce a second answer.
  const [attempt, setAttempt] = useState<{ text: string; key: string } | null>(null);
  const send = useMutation({
    mutationFn: (a: { text: string; key: string }) => api.postTurn(id, a.text, a.key),
    onSuccess: () => {
      setText("");
      setAttempt(null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.thread(id) });
      void queryClient.invalidateQueries({ queryKey: keys.threads });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || send.isPending) return;
    const a = attempt?.text === msg ? attempt : { text: msg, key: crypto.randomUUID() };
    setAttempt(a);
    send.mutate(a);
  };

  const err = send.error instanceof ApiRequestError ? send.error : null;
  const reason = (err?.details as { reason?: string } | undefined)?.reason;
  const notConfigured = reason === "ai_provider_not_configured" || reason === "ai_provider_config_invalid";

  if (!thread.data)
    return (
      <>
        <DrawerHeader kicker="Talk · conversation" title="Conversation" />
        <DrawerState error={thread.error} />
      </>
    );
  const { thread: t, turns, proposals } = thread.data;
  return (
    <>
      <DrawerHeader kicker="Talk · conversation" title={t.title} />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-ink2">
            <button type="button" onClick={() => open("talk")} className="text-teal underline">
              All conversations
            </button>
            {t.subjectJobId && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={() => open(`run:${t.subjectJobId}`)} className="underline">
                  about run {t.subjectJobId.slice(-8)}
                </button>
              </>
            )}
          </div>
          {thread.error && (
            <p role="status" className="m-0 rounded-xl bg-hair px-3 py-2 text-[12.5px] text-ink2">
              Showing the conversation as last loaded. Refreshing failed: {thread.error.message}
            </p>
          )}
          {turns.length === 0 ? (
            <p className="m-0 text-[14px] leading-relaxed text-ink2">
              Ask something, for example “how is my run going?” or “work on acme/web#42”.
            </p>
          ) : (
            <ol role="log" aria-label="Conversation" className="m-0 flex list-none flex-col gap-3 p-0">
              {turns.map((turn) => (
                <TurnItem
                  key={turn.id}
                  turn={turn}
                  proposal={proposals.find((p) => p.id === turn.proposalId)}
                  onOpenRun={(jobId) => open(`run:${jobId}`)}
                />
              ))}
            </ol>
          )}
        </div>

        <form onSubmit={submit} className="flex flex-none flex-col gap-2 border-t border-hair px-6 pt-3 pb-5">
          {send.error &&
            (notConfigured ? (
              <div role="alert" className="flex flex-col gap-1 rounded-xl bg-hair px-3 py-2.5">
                <span className="text-[13px] font-medium text-ink">Talk isn't set up yet</span>
                <span className="text-[12.5px] leading-snug text-ink2">{send.error.message}</span>
              </div>
            ) : (
              <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
                {(err && SEND_FAILED[err.code]) ?? send.error.message}
              </p>
            ))}
          <div className="flex items-center gap-2 rounded-2xl bg-hair py-1.5 pr-1.5 pl-4">
            <label htmlFor="talk-input" className="sr-only">
              Message
            </label>
            <input
              id="talk-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
              autoComplete="off"
              placeholder="Ask about a run, or name an issue to work on…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink3"
            />
            <button
              type="submit"
              disabled={send.isPending || !text.trim()}
              className="h-10 flex-none rounded-xl bg-teal px-4 text-[13px] font-medium text-onacc disabled:opacity-60"
            >
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
          <span className="font-mono text-[10.5px] leading-snug text-ink3">
            text only · answers cite NEXUS records · actions need your on-screen confirm
          </span>
        </form>
      </div>
    </>
  );
}

const BASIS: Record<Exclude<Basis, "NONE">, { label: string; tone: string }> = {
  OBSERVED: { label: "observed", tone: "var(--green)" },
  INFERRED: { label: "inferred", tone: "var(--amber)" },
  PENDING: { label: "pending", tone: "var(--ink3)" },
};

function TurnItem({
  turn,
  proposal,
  onOpenRun,
}: {
  turn: Turn;
  proposal?: ActionProposal;
  onOpenRun: (jobId: string) => void;
}) {
  const mine = turn.role === "USER";
  const basis = turn.basis === "NONE" ? null : BASIS[turn.basis];
  return (
    <li className={`flex flex-col gap-1.5 ${mine ? "items-end" : "items-start"}`}>
      <span className="flex items-center gap-2 font-mono text-[10.5px] text-ink3">
        {mine ? "You" : "NEXUS"} · {clock(turn.createdAt)}
        {basis && (
          <span
            className="rounded-full border px-1.5 py-0.5"
            style={{ borderColor: basis.tone, color: basis.tone }}
            title="How NEXUS knows this"
          >
            {basis.label}
          </span>
        )}
      </span>
      <p
        className={`m-0 max-w-[min(560px,92%)] px-4 py-3 text-[14px] leading-[1.55] break-words whitespace-pre-wrap ${
          mine
            ? "rounded-[18px_18px_6px_18px] bg-ink text-bg"
            : "rounded-[18px_18px_18px_6px] bg-hair text-ink"
        }`}
      >
        {turn.text}
      </p>
      {turn.sources.length > 0 && (
        <ul aria-label="Sources" className="m-0 flex max-w-[560px] list-none flex-wrap gap-1.5 p-0">
          {turn.sources.map((s) => (
            <li key={`${s.kind}:${s.id}`}>
              <SourceChip source={s} onOpenRun={onOpenRun} />
            </li>
          ))}
        </ul>
      )}
      {proposal && <ProposalCard proposal={proposal} onOpenRun={onOpenRun} />}
    </li>
  );
}

const chip =
  "inline-flex items-center gap-1.5 rounded-full border border-hair px-2 py-1 font-mono text-[10.5px] leading-tight text-ink2";

function SourceChip({ source: s, onOpenRun }: { source: SourceRef; onOpenRun: (jobId: string) => void }) {
  const text = `${s.kind.toLowerCase().replace("_", " ")} · ${s.label}`;
  const asOf = `as of ${clock(s.asOf)}`;
  if (s.kind === "JOB")
    return (
      <button type="button" title={asOf} onClick={() => onOpenRun(s.id)} className={`${chip} underline`}>
        {text}
      </button>
    );
  if (s.url)
    return (
      <a href={s.url} target="_blank" rel="noopener noreferrer" title={asOf} className={`${chip} underline`}>
        {text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  return (
    <span title={asOf} className={chip}>
      {text}
    </span>
  );
}

const CARD: Record<ActionProposal["status"], { kicker: string; tone: string }> = {
  PROPOSED: { kicker: "Action proposal", tone: "var(--amber)" },
  AWAITING_APPROVAL: { kicker: "Action proposal · needs your confirm", tone: "var(--amber)" },
  APPROVED: { kicker: "Confirmed · starting", tone: "var(--amber)" },
  EXECUTED: { kicker: "Confirmed · run queued", tone: "var(--green)" },
  DENIED: { kicker: "Not started", tone: "var(--ink3)" },
  EXPIRED: { kicker: "Expired · not started", tone: "var(--ink3)" },
  INVALIDATED: { kicker: "Withdrawn · not started", tone: "var(--ink3)" },
  FAILED: { kicker: "Couldn't start", tone: "var(--coral)" },
  UNKNOWN: { kicker: "Outcome unknown", tone: "var(--coral)" },
};

// The API answers 409 when the hash no longer matches, it was already decided, or it expired.
const CHANGED =
  "This proposal changed or was already decided, so nothing happened. The latest state is shown now.";

function ProposalCard({
  proposal: p,
  onOpenRun,
}: {
  proposal: ActionProposal;
  onOpenRun: (jobId: string) => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api.decideProposal(p.id, { decision, actionHash: p.actionHash }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.thread(p.threadId) });
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
    },
  });
  const card = CARD[p.status];
  const { request } = p.action;
  const error =
    decide.error instanceof ApiRequestError && decide.error.status === 409 ? CHANGED : decide.error?.message;
  const facts: [string, string][] = [
    ["action", `${p.action.type} · ${request.jobType}`],
    ["risk", p.riskTier],
    ["hash", shortHash(p.actionHash)],
  ];
  if (p.status === "AWAITING_APPROVAL") facts.push(["expires", until(p.expiresAt, now)]);

  return (
    <section
      aria-label={`Proposal: ${p.action.preview}`}
      className="flex w-[min(560px,100%)] flex-col gap-2.5 rounded-[18px] border p-4"
      style={{ borderColor: card.tone }}
    >
      <span className="kicker" style={{ color: card.tone }}>
        {card.kicker}
      </span>
      <p className="m-0 text-[13.5px] leading-[1.5] text-ink">{p.action.preview}</p>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11.5px]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink3">{k}</dt>
            <dd className="m-0 break-words text-ink2" title={k === "hash" ? p.actionHash : undefined}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {p.status === "AWAITING_APPROVAL" && (
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
            className="flex-1 rounded-xl border border-hair px-3 py-2.5 text-[12.5px] font-medium text-ink2 disabled:opacity-60"
          >
            Not now
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
            className="flex-1 rounded-xl bg-amber px-3 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
          >
            {decide.isPending ? "Confirming…" : "Confirm"}
          </button>
        </div>
      )}
      {p.status === "EXECUTED" && p.result && (
        <button
          type="button"
          onClick={() => onOpenRun(p.result!.jobId)}
          className="self-start text-[12.5px] font-medium text-teal underline"
        >
          Open the queued run
        </button>
      )}
      {p.status === "FAILED" && (
        <p className="m-0 text-[12.5px] text-ink2">{p.error ?? "The API gave no reason."}</p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
          {error}
        </p>
      )}
    </section>
  );
}

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FEEDBACK_MAX,
  isTerminal,
  type Job,
  type JobFeedback as Feedback,
  type JobStatus,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { primaryBtn } from "./deepDive.tsx";
import { useKeepFixing } from "./RunAgain.tsx";
import { withTranscript } from "./Talk.tsx";
import { useScope } from "./scope.tsx";
import type { KeepFixingState, LoopView, StuckView } from "./loopEvents.ts";
import { MicButton, VoiceHud, VoiceProblems, micScopeBlock, usePushToTalk } from "./voice.tsx";

const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const isOnline = () => onlineManager.isOnline();
const POLL_MS = 5_000;
const NEAR_LIMIT = Math.floor(FEEDBACK_MAX * 0.9);

const WORKING: readonly JobStatus[] = ["QUEUED", "PREPARING", "RUNNING", "VERIFYING"];

type Mode = "feedback" | "keep" | "answer";

/** What the box does for this job right now; null when there is nothing to say to it. */
export function boxMode(status: JobStatus, keep: KeepFixingState): Mode | null {
  if (WORKING.includes(status)) return "feedback";
  if (keep.kind !== "eligible") return null;
  return keep.answers ? "answer" : "keep";
}

/** Where one message stands, from the API's record and the runner's own event, never from a guess. */
export function feedbackState(f: Feedback, view: LoopView, ended: boolean) {
  const round = f.deliveredRound ?? view.delivered.get(f.id) ?? null;
  if (round === 0 || (round === null && (view.stopped?.unusedFeedback.includes(f.id) || ended)))
    return "Not used: the job ended first";
  return round === null ? "Waiting for the next round" : `Delivered to round ${round}`;
}

/**
 * The prompt box under the live terminal (spec §6a). While the job works it sends feedback for the next round; on a
 * job that stopped it is the note for Keep fixing, or the answer to the agent's questions.
 */
export function JobFeedback({
  job,
  status,
  keep,
  stuck,
  view,
}: {
  job: Job;
  status: JobStatus;
  keep: KeepFixingState;
  stuck: StuckView;
  view: LoopView;
}) {
  const queryClient = useQueryClient();
  const scope = useScope();
  const online = useSyncExternalStore(subscribeOnline, isOnline);
  const fix = useKeepFixing(job);
  const ended = isTerminal(status);
  const mode = boxMode(status, keep);
  const [text, setText] = useState("");
  const sent = useRef<{ text: string; key: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ids = { input: useId(), help: useId(), count: useId(), why: useId() };
  const ptt = usePushToTalk(scope.project?.id);

  const list = useQuery({
    queryKey: keys.jobFeedback(job.id),
    queryFn: () => api.jobFeedback(job.id),
    refetchInterval: ended ? false : POLL_MS,
  });
  // The runner said it delivered something: look the list up now instead of at the next poll.
  const deliveredCount = view.delivered.size;
  useEffect(() => {
    if (deliveredCount) void queryClient.invalidateQueries({ queryKey: keys.jobFeedback(job.id) });
  }, [deliveredCount, job.id, queryClient]);

  // One Idempotency-Key per message: a retry of the same words reuses it, other words get their own.
  const send = useMutation({
    mutationFn: (words: string) => {
      if (sent.current?.text !== words) sent.current = { text: words, key: crypto.randomUUID() };
      return api.sendFeedback(job.id, words, sent.current.key);
    },
    networkMode: "always",
    onSuccess: () => {
      setText("");
      sent.current = null;
      void queryClient.invalidateQueries({ queryKey: keys.jobFeedback(job.id) });
    },
  });

  const words = text.trim();
  const over = text.length - FEEDBACK_MAX;
  const needsText = mode === "feedback" || mode === "answer";
  const pending = send.isPending || fix.pending;
  const error = mode === "feedback" ? send.error : fix.error;
  const reason =
    mode === "feedback"
      ? (fix.scopeReason ?? (online ? null : "You're offline. Send it when the connection is back."))
      : fix.reason;
  const canSend = !pending && !reason && over <= 0 && (!needsText || !!words) && fix.ready;

  const submit = () => {
    if (!canSend || !mode) return;
    if (mode === "feedback") send.mutate(words);
    else fix.run(words || undefined);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a new line; Enter while an input method is composing is not a send.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const messages = list.data ?? [];
  const questions = mode === "answer" ? stuck.questions : [];

  if (!mode && messages.length === 0) {
    return keep.kind === "needs_setup" ? <SetupNote nextStep={keep.nextStep} /> : null;
  }

  const label = {
    feedback: "Message to the agent",
    keep: "Note for the agent (optional)",
    answer: "Your answer to the agent's questions",
  }[mode ?? "feedback"];
  const action = {
    feedback: send.isPending ? "Sending…" : "Send to the agent",
    keep: fix.pending ? "Queueing…" : "Keep fixing",
    answer: fix.pending ? "Queueing…" : "Send answer and continue",
  }[mode ?? "feedback"];
  const help = {
    feedback:
      "The agent reads this at the start of its next round. A round that is already running isn't interrupted.",
    keep:
      keep.kind === "eligible" && keep.withdraws
        ? "Keep fixing withdraws the pending approval and starts a new run from the saved changes, with a fresh budget. The note is your guidance; it can't override the fixed rules."
        : "Keep fixing starts a new run from the saved changes, with a fresh budget. The note is your guidance; it can't override the fixed rules.",
    answer:
      "Your answer starts a new run that carries it. It is your guidance; it can't override the fixed rules.",
  }[mode ?? "feedback"];

  return (
    <section
      aria-labelledby={`${ids.input}-h`}
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border border-hair p-4"
    >
      <h3 id={`${ids.input}-h`} className="kicker m-0">
        {mode === "feedback"
          ? "Talk to the agent"
          : mode === "answer"
            ? "The agent has a question"
            : mode === "keep"
              ? "Keep fixing"
              : "Your messages"}
      </h3>
      {questions.length > 0 && (
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-[1.5] text-ink">
          {questions.map((q, i) => (
            <li key={i} className="break-words">
              {q}
            </li>
          ))}
        </ol>
      )}
      {messages.length > 0 && (
        <ul
          aria-label="Your messages to the agent"
          role="status"
          className="m-0 flex list-none flex-col gap-1.5 p-0"
        >
          {messages.map((m) => (
            <li key={m.id} className="rounded-xl bg-hair px-3 py-2 text-[12.5px] leading-[1.45] text-ink">
              <span className="break-words whitespace-pre-wrap">{m.text}</span>
              <span className="mt-0.5 block font-mono text-[11px] text-ink2">
                {feedbackState(m, view, ended)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          Can&apos;t load your earlier messages: {list.error.message}
        </p>
      )}
      {mode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={ids.input} className="text-[12.5px] font-medium text-ink">
            {label}
          </label>
          <div className="flex items-end gap-1.5">
            <textarea
              id={ids.input}
              ref={inputRef}
              value={text}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              aria-describedby={`${ids.help} ${ids.count}${reason ? ` ${ids.why}` : ""}`}
              aria-invalid={over > 0 ? true : undefined}
              className="min-w-0 flex-1 resize-y rounded-xl border border-hair bg-card px-3 py-2 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            />
            <MicButton
              ptt={ptt}
              onTranscript={(spoken) => {
                setText((t) => withTranscript(t, spoken));
                inputRef.current?.focus();
              }}
              blocked={micScopeBlock(scope)}
            />
          </div>
          <VoiceHud ptt={ptt} onEnd={ptt.cancel} />
          <VoiceProblems ptt={ptt} />
          <p id={ids.help} className="m-0 text-[12px] leading-[1.45] text-ink3">
            {help} Enter sends; Shift+Enter starts a new line.
          </p>
          <p
            id={ids.count}
            role={text.length >= NEAR_LIMIT ? "status" : undefined}
            className={`m-0 font-mono text-[11.5px] ${over > 0 ? "text-coral" : "text-ink3"}`}
          >
            {text.length >= NEAR_LIMIT
              ? over > 0
                ? `${over} characters over the ${FEEDBACK_MAX.toLocaleString("en")} limit: shorten it to send.`
                : `${text.length.toLocaleString("en")} of ${FEEDBACK_MAX.toLocaleString("en")} characters`
              : ""}
          </p>
          {reason && (
            <p id={ids.why} className="m-0 text-[12.5px] leading-snug text-ink2">
              {reason}
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
              {error.message}
            </p>
          )}
          <button type="submit" disabled={!canSend} className={`${primaryBtn} self-start`}>
            {action}
          </button>
        </form>
      )}
      {!mode && keep.kind === "needs_setup" && <SetupNote nextStep={keep.nextStep} inline />}
    </section>
  );
}

/** Not_configured: Keep fixing keeps the base commit's test plan, so it isn't offered; this says what to add. */
function SetupNote({ nextStep, inline }: { nextStep: string; inline?: boolean }) {
  return (
    <p
      role={inline ? undefined : "note"}
      className={`m-0 text-[12.5px] leading-[1.5] text-ink ${inline ? "" : "flex-none rounded-2xl border border-hair px-4 py-3"}`}
    >
      <strong className="font-medium">Keep fixing isn&apos;t available here.</strong> NEXUS has no tests it
      can run at the base commit. {nextStep}
    </p>
  );
}

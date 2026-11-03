import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Project, Thread } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { useScope } from "./scope.tsx";
import { MAX_TURN_CHARS, SendError, TurnItem, talkBlocked, useSendTurn, withTranscript } from "./Talk.tsx";
import {
  MicButton,
  Orb,
  ReadAloudButton,
  VoiceHud,
  VoiceProblems,
  thisDevice,
  useMicBlock,
  usePushToTalk,
  useSpeak,
} from "./voice.tsx";

// The Cofounder panel (PRD §D.4): the project's latest Talk thread, typed or spoken. Answers come from the Talk API
// (NEXUS's own records, with their sources); a transcript fills the input and waits for Send; proposals still need
// the owner's on-screen confirm (FR-VOICE-04).

const route = getRouteApi("/");

const PICK = "Pick a project to talk with your cofounder.";

// Suggestions only fill the input: the owner still sends them.
const CHIPS: Record<Project["mode"], string[]> = {
  DEV: ["What's waiting on me?", "Summarize today's runs", "What failed?"],
  BUSINESS: ["What's waiting on me?", "What did you notice?", "Summarize today"],
};

export function CofounderPanel({ projectId }: { projectId: string | undefined }) {
  const scope = useScope();
  const project = projectId && scope.project?.id === projectId ? scope.project : undefined;
  // While the URL's project resolves, the caller has no projectId yet either: that isn't the All view.
  if (!scope.ready)
    return (
      <Shell sub="loading">
        <p role="status" className="m-0 px-4 py-5 text-[13px] text-ink3">
          Loading…
        </p>
      </Shell>
    );
  if (!project)
    return (
      <Shell sub="cross-project · read-only">
        <p className="m-0 px-4 py-5 text-[14px] leading-relaxed text-ink2">{PICK}</p>
      </Shell>
    );
  // Another project is another conversation, mic session and voice: nothing carries over (FR-CSP-01).
  return <Conversation key={project.id} project={project} blocked={talkBlocked(scope)} />;
}

function Shell({
  sub,
  live = false,
  action,
  children,
}: {
  sub: string;
  live?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Cofounder"
      className="glass2 flex h-full max-h-[min(760px,calc(100dvh-116px))] min-h-[420px] w-full flex-col overflow-hidden rounded-[24px] border border-line"
    >
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-hair px-4 pt-4 pb-3.5">
        <Orb size={34} live={live} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 text-[15px] leading-none font-medium">Cofounder</h2>
          <span className="truncate font-mono text-[11px] leading-tight text-ink3">{sub}</span>
        </div>
        {action}
      </div>
      {children}
    </aside>
  );
}

const newest = (items: readonly Thread[] | undefined) =>
  items?.reduce<Thread | undefined>((a, t) => (!a || t.updatedAt > a.updatedAt ? t : a), undefined);

function Conversation({ project, blocked }: { project: Project; blocked: string | null }) {
  const navigate = route.useNavigate();
  const { keep } = useScope();
  const open = (drawer: string) => void navigate({ search: { ...keep, drawer } });
  const threads = useQuery({ queryKey: keys.threadsOf(project.id), queryFn: () => api.threads(project.id) });
  // The thread this panel's first send created, until the list shows it.
  const [created, setCreated] = useState<string>();
  const threadId = created ?? newest(threads.data?.items)?.id;
  const thread = useQuery({
    queryKey: keys.thread(threadId ?? ""),
    queryFn: () => api.thread(threadId ?? ""),
    enabled: !!threadId,
  });

  const [text, setText] = useState("");
  // The input holds words from the mic: the reply to them is read aloud when spoken replies are on.
  const [spoken, setSpoken] = useState(false);
  // "Talk with your cofounder": every reply is read aloud, then the mic is offered for the next turn.
  const [talking, setTalking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const modeWhy = useId();
  const ptt = usePushToTalk(project.id);
  const speaker = useSpeak(project.id);
  const micBlock = useMicBlock(blocked);

  const offerMic = () => micRef.current?.focus();
  const { send, submit } = useSendTurn({
    threadId,
    projectId: project.id,
    onSent: (res, id, viaMic) => {
      setCreated(id);
      setText("");
      setSpoken(false);
      if (!talking && !viaMic) return;
      if (speaker.enabled)
        speaker.speak(res.assistantTurn.id, res.assistantTurn.text, talking ? offerMic : undefined);
      else if (talking) offerMic();
    },
  });
  const onTranscript = (words: string) => {
    setText((t) => withTranscript(t, words));
    setSpoken(true);
    inputRef.current?.focus();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(text, spoken);
  };
  const end = () => {
    setTalking(false);
    ptt.cancel();
    speaker.stop();
  };
  const toggleTalk = () => {
    if (talking) return end();
    if (micBlock) return;
    setTalking(true);
    ptt.start(onTranscript);
  };

  const turns = thread.data?.turns ?? [];
  const proposals = thread.data?.proposals ?? [];
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const micLive = ptt.phase === "listening" || ptt.phase === "requesting";
  const sub = micLive
    ? `listening · mic on ${thisDevice()}`
    : speaker.speaking
      ? "speaking"
      : `watching ${project.name}`;
  const loadError = threads.error ?? thread.error;

  return (
    <Shell
      sub={sub}
      live={micLive || !!speaker.speaking}
      action={
        !blocked && (
          <>
            <button
              type="button"
              aria-pressed={talking}
              aria-disabled={micBlock && !talking ? "true" : undefined}
              aria-describedby={micBlock && !talking ? modeWhy : undefined}
              onClick={toggleTalk}
              className={`rounded-[10px] border px-2.5 py-2 text-[11.5px] leading-none font-medium whitespace-nowrap ${talking ? "border-teal text-teal" : "border-hair text-ink2"} ${micBlock && !talking ? "cursor-not-allowed opacity-45" : ""}`}
            >
              Talk with your cofounder
            </button>
            {micBlock && (
              <span id={modeWhy} hidden>
                {micBlock.why}
              </span>
            )}
          </>
        )
      }
    >
      <div ref={logRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
        {loadError && (
          <p role="status" className="m-0 rounded-xl bg-hair px-3 py-2 text-[12.5px] text-ink2">
            {thread.data ? "Showing the conversation as last loaded. " : "Couldn't load the conversation. "}
            {loadError.message}
          </p>
        )}
        {threads.isPending || (threadId && thread.isPending) ? (
          <p role="status" className="m-0 text-[13px] text-ink3">
            Loading…
          </p>
        ) : turns.length === 0 ? (
          !loadError && (
            <p className="m-0 text-[14px] leading-relaxed text-ink2">
              Ask about {project.name}: what is waiting on you, how today's runs went, what failed. Answers
              cite the records they come from.
            </p>
          )
        ) : (
          <ol role="log" aria-label="Conversation" className="m-0 flex list-none flex-col gap-3 p-0">
            {turns.map((turn) => (
              <TurnItem
                key={turn.id}
                turn={turn}
                name="Cofounder"
                proposal={proposals.find((p) => p.id === turn.proposalId)}
                onOpen={open}
                aside={
                  turn.role === "ASSISTANT" && (
                    <ReadAloudButton speaker={speaker} id={turn.id} text={turn.text} />
                  )
                }
              />
            ))}
          </ol>
        )}
      </div>

      <div className="flex flex-none flex-col gap-2.5 border-t border-hair px-3.5 pt-3 pb-3.5">
        {blocked ? (
          <p className="m-0 text-[12.5px] leading-snug text-ink2">{blocked}</p>
        ) : (
          <>
            <VoiceHud ptt={ptt} speaker={speaker} conversation={talking} onEnd={end} />
            <VoiceProblems ptt={ptt} speaker={speaker} />
            {send.error && <SendError error={send.error} />}
            <ul aria-label="Suggestions" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {CHIPS[project.mode].map((c) => (
                <li key={c}>
                  <button
                    type="button"
                    onClick={() => {
                      setText(c);
                      setSpoken(false);
                      inputRef.current?.focus();
                    }}
                    className="rounded-full border border-hair px-[11px] py-[7px] text-[12px] leading-none whitespace-nowrap text-ink2 hover:bg-hair"
                  >
                    {c}
                  </button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={onSubmit}
              className="flex h-[46px] items-center gap-1.5 rounded-[14px] border border-hair bg-hair py-0 pr-[5px] pl-3.5"
            >
              <input
                ref={inputRef}
                aria-label="Message your cofounder"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (!e.target.value) setSpoken(false);
                }}
                maxLength={MAX_TURN_CHARS}
                autoComplete="off"
                placeholder={`Ask about ${project.name}…`}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink3"
              />
              <MicButton
                ref={micRef}
                ptt={ptt}
                onTranscript={onTranscript}
                blocked={null}
                className="size-9"
              />
              <button
                type="submit"
                disabled={send.isPending || !text.trim()}
                className="h-9 flex-none rounded-[10px] bg-teal px-3.5 text-[12.5px] font-semibold text-onacc disabled:opacity-60"
              >
                {send.isPending ? "Sending…" : "Send"}
              </button>
            </form>
          </>
        )}
        <span className="font-mono text-[10.5px] leading-[1.4] text-ink3">
          answers from {project.name} sources only · runs execute on your home machine · pushes and merges
          need on-screen approval
        </span>
      </div>
    </Shell>
  );
}

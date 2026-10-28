import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DIAGNOSTIC_TIMEOUT_MS,
  DiagnosticPreset,
  type CreateJobRequest,
  type Runner,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { preferredRunner } from "../lib/queries.ts";
import { P1Button } from "./P1Button.tsx";

const MODES = ["Ask", "Plan", "Execute"] as const;
type Mode = (typeof MODES)[number];
const DIAGNOSTIC_TIMEOUT_S = DIAGNOSTIC_TIMEOUT_MS / 1000;

const seg = (on: boolean) =>
  `rounded-[9px] px-[11px] py-[9px] text-[12px] font-medium leading-none ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink3"}`;

/**
 * Command bar (top centre). Under it, in one column: `children` (status banners), then the
 * Execute preview or the Ask/Plan "not yet" note.
 */
export function CommandBar({
  runners,
  projectId,
  blocked,
  onQueued,
  children,
}: {
  runners: readonly Runner[] | undefined;
  /** The project a queued job belongs to; Execute is disabled (with `blocked` as the reason) without one. */
  projectId: string | undefined;
  blocked: string | null;
  onQueued: (jobId: string) => void;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("Execute");
  const [panel, setPanel] = useState<"preview" | "note" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setPanel(null);
    inputRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") setPanel(mode === "Execute" ? "preview" : "note");
    if (e.key === "Escape") setPanel(null);
  };

  return (
    <div className="relative mx-auto max-w-[780px] min-w-0 flex-[1_1_0]">
      <div className="glass2 pointer-events-auto flex h-[52px] items-center gap-2 rounded-[18px] pr-1.5 pl-4">
        <input
          ref={inputRef}
          aria-label="Command"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask, plan or run anything on your home machine…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink3"
        />
        <P1Button
          why="Voice commands arrive in P1."
          className="flex size-10 flex-none items-center justify-center gap-[2.5px] rounded-xl bg-hair"
        >
          <span className="sr-only">Voice command</span>
          {[0.5, 1, 0.7, 0.4].map((s, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="h-4 w-[3px] rounded-sm bg-ink2"
              style={{ transform: `scaleY(${s})` }}
            />
          ))}
        </P1Button>
        <div
          role="group"
          aria-label="Command mode"
          className="hidden flex-none rounded-xl bg-hair p-[3px] sm:flex"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={seg(mode === m)}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPanel(mode === "Execute" ? "preview" : "note")}
          className="h-10 flex-none rounded-xl bg-teal px-4 text-[13px] font-medium text-onacc"
        >
          {mode === "Execute" ? "Preview" : mode}
        </button>
      </div>
      <div className="absolute top-[62px] right-0 left-0 z-[12] flex flex-col gap-2.5">
        {children}
        {panel === "note" && (
          <Panel>
            <p role="status" className="m-0 font-serif text-[22px] leading-tight italic">
              {mode} needs the conversation service, which arrives in P1.
            </p>
            <p className="m-0 text-[13px] text-ink2">
              Execute works today: it runs a typed diagnostic on your home runner.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("Execute");
                  setPanel("preview");
                }}
                className="rounded-xl bg-teal px-3.5 py-2.5 text-[12.5px] font-medium text-onacc"
              >
                Switch to Execute
              </button>
            </div>
          </Panel>
        )}
        {panel === "preview" && (
          <ExecutePreview
            key={projectId ?? "none"} // another project is another request: fresh Idempotency-Key
            freeText={text.trim()}
            runners={runners}
            projectId={blocked ? undefined : projectId}
            blocked={blocked}
            onAdjust={close}
            onQueued={(id) => {
              setPanel(null);
              setText("");
              onQueued(id);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Panel({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className="glass2 pointer-events-auto flex w-full flex-col gap-4 rounded-[22px] px-[22px] py-5"
    >
      {children}
    </section>
  );
}

function ExecutePreview({
  freeText,
  runners,
  projectId,
  blocked,
  onAdjust,
  onQueued,
}: {
  freeText: string;
  runners: readonly Runner[] | undefined;
  projectId: string | undefined;
  blocked: string | null;
  onAdjust: () => void;
  onQueued: (jobId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<DiagnosticPreset>("host-info");
  // One key per preview; a retry of the same preview reuses it, so the API returns the original job.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => selectRef.current?.focus(), []);

  const runner = preferredRunner(runners);
  const online = runner?.status === "ONLINE";
  const queue = useMutation({
    mutationFn: (body: CreateJobRequest) => api.createJob(body, idemKey),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
      onQueued(res.jobId);
    },
  });

  const rows: [string, ReactNode][] = [
    ["Job type", "Runner diagnostic"],
    [
      "Preset",
      <select
        key="preset"
        ref={selectRef}
        aria-label="Preset"
        value={preset}
        onChange={(e) => {
          setPreset(DiagnosticPreset.parse(e.target.value));
          setIdemKey(crypto.randomUUID()); // different body ⇒ different request
        }}
        className="rounded-lg border border-hair bg-hair px-2 py-1 font-mono text-[12.5px] text-ink"
      >
        {DiagnosticPreset.options.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>,
    ],
    ["Runs on", runner ? `${runner.name} · fixed argv · no shell` : "No runner paired yet"],
    ["Risk", "R0 · read-only"],
    ["Approval", "Not required"],
    ["Timeout", `${DIAGNOSTIC_TIMEOUT_S} s`],
  ];

  return (
    <Panel label="Execute preview">
      <h2 className="m-0 font-serif text-[24px] leading-tight font-normal italic">
        Here’s exactly what will happen.
      </h2>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1.5">
            <dt className="kicker">{k}</dt>
            <dd className="m-0 text-[13px] leading-snug">{v}</dd>
          </div>
        ))}
      </dl>
      {freeText && (
        <p className="m-0 font-mono text-[11px] leading-snug text-ink3">
          Free-text commands need the conversation service (P1). Pick a preset; “{freeText}” is not sent.
        </p>
      )}
      {blocked && (
        <p id="execute-blocked" className="m-0 text-[12.5px] leading-snug text-ink2">
          {blocked}
        </p>
      )}
      {!online && (
        <p
          className="m-0 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: "oklch(0.70 0.13 65 / .15)" }}
        >
          {runner
            ? `${runner.name} is ${runner.status.toLowerCase()}. The job will be queued and held, not lost, until it reconnects.`
            : "No runner is paired. The job will be queued and held, not lost, until you pair one in Systems."}
        </p>
      )}
      {queue.error && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {queue.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onAdjust}
          className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2"
        >
          Adjust
        </button>
        <button
          type="button"
          disabled={queue.isPending || !projectId}
          aria-describedby={blocked ? "execute-blocked" : undefined}
          onClick={() => projectId && queue.mutate({ jobType: "RUNNER_DIAGNOSTIC", preset, projectId })}
          className="rounded-xl bg-teal px-3.5 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
        >
          {queue.isPending ? "Queuing…" : runner ? `Queue on ${runner.name}` : "Queue job"}
        </button>
      </div>
    </Panel>
  );
}

import { useState, type ReactNode } from "react";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import type { JobList, Runner } from "@nexus/contracts";
import { api } from "../lib/api.ts";
import { RUNNER_TONE, ago, clock, isActive, jobTone, statusLabel, useNow } from "../lib/queries.ts";

export interface ZoneProps {
  id: string;
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tint: string;
  dim: boolean;
  children: ReactNode;
}

export function EmptyZone({ children }: { children: ReactNode }) {
  return <p className="m-0 max-w-[460px] text-[15px] leading-relaxed text-ink3">{children}</p>;
}

function QueryState({ query, empty }: { query: UseQueryResult<unknown>; empty?: ReactNode }) {
  if (query.isPending) return <EmptyZone>Loading…</EmptyZone>;
  if (query.error) return <EmptyZone>{query.error.message}</EmptyZone>;
  return <EmptyZone>{empty}</EmptyZone>;
}

/** A board node: always a real button so the board is fully keyboard-operable. */
function Node(props: {
  dot: string;
  live?: boolean;
  kicker: string;
  title: string;
  meta: string;
  detail?: ReactNode;
  segs?: string[];
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-expanded={props.expanded}
      className="flex w-[220px] flex-col gap-2 rounded-[20px] border border-line bg-card px-4 py-3.5 text-left shadow-nx transition-shadow hover:shadow-[0_0_0_2px_var(--teal),var(--shadow)]"
    >
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-2 flex-none rounded-full ${props.live ? "nx-pulse" : ""}`}
          style={{ background: props.dot }}
        />
        <span className="kicker flex-1 truncate">{props.kicker}</span>
      </span>
      <span className="text-[14px] leading-[1.3] font-medium text-pretty">{props.title}</span>
      <span className="font-mono text-[11.5px] leading-[1.45] text-ink2">{props.meta}</span>
      {props.segs && (
        <span aria-hidden="true" className="grid w-full grid-cols-5 gap-[3px]">
          {props.segs.map((c, i) => (
            <span key={i} className="h-1 rounded-sm" style={{ background: c }} />
          ))}
        </span>
      )}
      {props.expanded && props.detail && (
        <span className="w-full border-t border-hair pt-2 text-[12px] leading-normal text-ink2">
          {props.detail}
        </span>
      )}
    </button>
  );
}

const nodeGrid = "m-0 flex list-none flex-wrap content-start gap-[30px] p-0";

const LIFECYCLE = ["QUEUED", "PREPARING", "RUNNING", "VERIFYING"];

export function CodeZone({
  query,
  runners,
  onOpen,
}: {
  query: UseQueryResult<JobList>;
  runners: readonly Runner[] | undefined;
  onOpen: (id: string) => void;
}) {
  const jobs = query.data?.items;
  if (!jobs?.length)
    return (
      <QueryState
        query={query}
        empty="No runs yet. Use Execute in the command bar to run a diagnostic on your home runner."
      />
    );
  return (
    <ul className={nodeGrid}>
      {jobs.map((j) => {
        const step = LIFECYCLE.indexOf(j.status);
        const tone = jobTone(j.status);
        // Done = past the step (we only know the current status here); finished runs fill the bar in their outcome colour.
        const segs = [0, 1, 2, 3, 4].map((i) =>
          step === -1
            ? i === 4 || j.status === "COMPLETED"
              ? tone
              : "var(--hair)"
            : i < step
              ? "var(--green)"
              : i === step
                ? tone
                : "var(--hair)",
        );
        const name = runners?.find((r) => r.id === j.runnerId)?.name;
        return (
          <li key={j.id}>
            <Node
              dot={tone}
              live={isActive(j.status)}
              kicker={j.status === "QUEUED" && !j.runnerId ? "Queued · held" : statusLabel(j.status)}
              title={`Diagnostic · ${j.request.preset}`}
              meta={`${name ?? (j.runnerId ? "runner" : "not claimed")} · ${clock(j.createdAt)}`}
              segs={segs}
              onClick={() => onOpen(j.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function SystemsZone({ query }: { query: UseQueryResult<Runner[]> }) {
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  const runners = query.data;
  if (!runners) return <QueryState query={query} />;
  const needsPairing = runners.every((r) => r.status === "REVOKED");
  return (
    <div className="flex flex-col gap-[30px]">
      {runners.length > 0 && (
        <ul className={nodeGrid}>
          {runners.map((r) => (
            <li key={r.id}>
              <Node
                dot={RUNNER_TONE[r.status]}
                live={r.status === "ONLINE"}
                kicker={`Home host · ${r.status}`}
                title={r.name}
                meta={`heartbeat ${ago(r.lastHeartbeatAt, now)}`}
                detail={`${r.os} · runner v${r.version} · capacity ${r.capacity}`}
                expanded={open === r.id}
                onClick={() => setOpen(open === r.id ? null : r.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {needsPairing && <PairRunner />}
    </div>
  );
}

function PairRunner() {
  const pair = useMutation({ mutationFn: api.pairRunner });
  return (
    <div className="flex max-w-[500px] flex-col gap-3 rounded-[20px] border border-line bg-card p-5 shadow-nx">
      <span className="kicker">No runner paired</span>
      <p className="m-0 text-[14px] leading-relaxed text-ink2">
        Jobs run only on your home machine. Pair it once; the code is single-use and expires in 10 minutes.
      </p>
      {pair.data ? (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[28px] tracking-[.12em]">{pair.data.code}</span>
          <span className="font-mono text-[11px] text-ink3">
            expires {clock(pair.data.expiresAt)} · shown once
          </span>
          <span className="text-[13px] text-ink2">On the home machine, from the repo root, run:</span>
          <code className="rounded-xl bg-term px-3 py-2.5 font-mono text-[12px] break-all text-[#eeeae2] select-all">
            node apps/runner/src/main.ts pair --code {pair.data.code}
          </code>
          <span className="text-[13px] text-ink2">
            Then start it with{" "}
            <code className="font-mono text-[12px]">node apps/runner/src/main.ts start</code>.
          </span>
        </div>
      ) : (
        <button
          type="button"
          disabled={pair.isPending}
          onClick={() => pair.mutate()}
          className="self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
        >
          {pair.isPending ? "Creating code…" : "Pair a runner"}
        </button>
      )}
      {pair.error && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {pair.error.message}
        </p>
      )}
    </div>
  );
}

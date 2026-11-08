import { useId, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link, getRouteApi } from "@tanstack/react-router";
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { isTerminal, type Job } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ghostBtn, primaryBtn } from "./deepDive.tsx";
import { useScope } from "./scope.tsx";

const route = getRouteApi("/");

const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const isOnline = () => onlineManager.isOnline();

/**
 * "Run again" for a finished job (FR-RUN-06): queues a new job linked to this one, which stays as it is. One
 * Idempotency-Key per mounted control: a double tap or a retry after a failed request starts one job.
 */
export function RunAgain({
  job,
  context,
  scopeNoteId,
}: {
  job: Job;
  /** Screen-reader name of the job, where several controls share a page. */
  context?: string;
  /** A list that already shows `scope.blocked` once: the id of that text, so rows don't repeat it. */
  scopeNoteId?: string;
}) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [idemKey] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const online = useSyncExternalStore(subscribeOnline, isOnline);

  const run = useMutation({
    mutationFn: () => api.retryJob(job.id, idemKey),
    // Never paused for a later reconnect: a paid run doesn't start by itself hours after the tap.
    networkMode: "always",
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
      void queryClient.invalidateQueries({ queryKey: keys.homeAll });
      void navigate({ search: { ...scope.keep, drawer: `run:${res.jobId}` } });
    },
  });

  if (!isTerminal(job.status)) return null;

  // Until the workspaces arrive the scope isn't known: disabled, without claiming a reason yet.
  const scopeReason = !scope.ready
    ? null
    : (scope.blocked ??
      (scope.project?.id === job.projectId
        ? null
        : "This job belongs to another project: switch to it first."));
  const shared = scope.ready && scope.blocked ? scopeNoteId : undefined;
  const offlineReason = online
    ? null
    : scopeNoteId
      ? "You're offline."
      : "You're offline. You can run this again when the connection is back.";
  const reason = scopeReason ?? offlineReason;
  const opensSecondPr = job.outcome === "PR_CREATED";
  const name = context && <span className="sr-only">: {context}</span>;

  return (
    <div className={`flex flex-none flex-col gap-2 ${scopeNoteId ? "items-start" : "items-end"}`}>
      <button
        type="button"
        disabled={!scope.ready || !!reason || run.isPending}
        aria-describedby={reason ? (shared ?? reasonId) : undefined}
        onClick={() => (opensSecondPr ? setConfirming(true) : run.mutate())}
        className={scopeNoteId ? ghostBtn : primaryBtn}
      >
        {run.isPending ? "Queueing…" : "Run again"}
        {name}
      </button>
      {reason && !shared && (
        <p id={reasonId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {reason}
        </p>
      )}
      {run.error && !confirming && (
        <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
          {run.error.message}
        </p>
      )}
      {!scopeNoteId && !reason && !run.error && (
        <p className="m-0 text-[12px] leading-snug text-ink3">
          Queues a new run. It starts when a runner picks it up.
        </p>
      )}
      {confirming && (
        <Dialog.Root open onOpenChange={(open) => !open && !run.isPending && setConfirming(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-20 bg-black/30" />
            <Dialog.Content
              role="alertdialog"
              className="glass2 fixed top-1/2 left-1/2 z-20 flex w-[min(460px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-[30px] p-6 outline-none"
            >
              <Dialog.Title className="m-0 font-serif text-[24px] leading-tight font-normal">
                Open a second pull request?
              </Dialog.Title>
              <Dialog.Description className="m-0 text-[13.5px] leading-[1.55] text-ink2">
                This run already opened a draft pull request. Running it again queues a new run on its own
                branch, and approving that run&apos;s push opens a second pull request. The first one is not
                changed.
              </Dialog.Description>
              {run.error && (
                <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
                  {run.error.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close disabled={run.isPending} className={ghostBtn}>
                  Keep the first one only
                </Dialog.Close>
                <button
                  type="button"
                  disabled={run.isPending}
                  onClick={() => run.mutate()}
                  className={primaryBtn}
                >
                  {run.isPending ? "Queueing…" : "Queue a new run"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}

/** On a rerun: the way back to the job it reran. */
export function RerunOf({ jobId }: { jobId: string }) {
  const { keep } = useScope();
  return (
    <p className="m-0 flex-none text-[12.5px] leading-snug text-ink2">
      <Link to="/" search={{ ...keep, drawer: `run:${jobId}` }} className="text-teal underline">
        Rerun of {jobId.slice(0, 8)}
      </Link>
    </p>
  );
}

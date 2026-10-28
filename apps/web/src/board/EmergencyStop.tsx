import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SystemControls } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { clock, useActiveJobs, useSystem } from "../lib/queries.ts";

// FR-INB-04 / FR-CSP-09: one global stop. The API cancels queued runs, asks running ones to stop, and refuses
// leases, new runs and approval execution until the owner releases it.

const STOP_RED = "oklch(0.52 0.15 32)"; // the design's banner red; white text on it meets AA

function useSetStop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setEmergencyStop,
    onSuccess: (s) => queryClient.setQueryData<SystemControls>(keys.system, s),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.system });
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    },
  });
}

/** Bottom-right STOP ALL (confirmed) / RESUME. */
export function StopButton() {
  const system = useSystem();
  const set = useSetStop();
  const [confirming, setConfirming] = useState(false);
  const engaged = system.data?.emergencyStop.engaged === true;
  const btn =
    "h-8 rounded-[10px] px-3 font-mono text-[11px] font-semibold tracking-[.06em] disabled:opacity-60";

  if (engaged)
    return (
      <button
        type="button"
        disabled={set.isPending}
        onClick={() => set.mutate(false)}
        aria-label="Release the emergency stop"
        className={`${btn} bg-ink text-bg`}
      >
        RESUME
      </button>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`${btn} bg-[oklch(0.62_0.15_32/.14)] text-coral`}
      >
        STOP ALL
      </button>
      {confirming && (
        <Dialog.Root open onOpenChange={(open) => !open && !set.isPending && setConfirming(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-20 bg-black/30" />
            <Dialog.Content
              role="alertdialog"
              className="glass2 fixed top-1/2 left-1/2 z-20 flex w-[min(460px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-[30px] p-6 outline-none"
            >
              <Dialog.Title className="m-0 font-serif text-[24px] leading-tight font-normal">
                Stop everything now?
              </Dialog.Title>
              <Dialog.Description className="m-0 text-[13.5px] leading-[1.55] text-ink2">
                Queued runs are cancelled and running ones are told to stop. Until you release the stop,
                nothing new starts and no approval is executed; pending approvals stay pending.
              </Dialog.Description>
              {set.error && (
                <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
                  {set.error.message} Nothing was stopped.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close
                  disabled={set.isPending}
                  className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2"
                >
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  disabled={set.isPending}
                  onClick={() => set.mutate(true, { onSuccess: () => setConfirming(false) })}
                  className="rounded-xl px-3.5 py-2.5 text-[12.5px] font-medium text-white disabled:opacity-60"
                  style={{ background: STOP_RED }}
                >
                  {set.isPending ? "Stopping…" : "Stop everything"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

/** The design's emergency banner while the stop is engaged; null otherwise. */
export function useStopBanner() {
  const system = useSystem();
  const engaged = system.data?.emergencyStop.engaged === true;
  const active = useActiveJobs(engaged);
  const set = useSetStop();
  if (!engaged) return null;
  const n = active.data?.length;
  const since = system.data?.emergencyStop.changedAt;
  return (
    <div
      role="alert"
      className="pointer-events-auto flex items-center gap-3 rounded-2xl py-3 pr-3.5 pl-[18px] text-white shadow-nx"
      style={{ background: STOP_RED }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13.5px] leading-snug font-medium">
          {n === undefined
            ? "Emergency stop engaged — checking what is still running…"
            : n === 0
              ? "Emergency stop engaged — nothing is running."
              : `Emergency stop engaged — waiting for ${n} ${n === 1 ? "run" : "runs"} to stop.`}
        </span>
        <span className="font-mono text-[11.5px] opacity-85">
          {since ? `since ${clock(since)} · ` : ""}queued runs cancelled · no new runs · approvals held
        </span>
        {set.error && <span className="text-[12px]">{set.error.message} The stop is still engaged.</span>}
      </div>
      <button
        type="button"
        disabled={set.isPending}
        onClick={() => set.mutate(false)}
        className="flex-none rounded-[11px] bg-white px-3 py-[9px] text-[12.5px] font-medium text-[#1d1c19] disabled:opacity-60"
      >
        {set.isPending ? "Releasing…" : "Release"}
      </button>
    </div>
  );
}

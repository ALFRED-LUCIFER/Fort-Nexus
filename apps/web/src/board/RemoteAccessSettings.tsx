import { useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RemoteAccessReport, RemoteAccessState, RemoteAccessStatus } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, useNow } from "../lib/queries.ts";
import { DrawerState } from "./Drawer.tsx";
import { Badge, Row, Rows } from "./Settings.tsx";

// Settings → Remote access (FR-ACC-03): what Tailscale says on the home machine, as the runner last reported it.
// Read-only on purpose. The page is often open over the connection a change would cut off.

const POLL_MS = 30_000;
const RUNBOOK = "docs/runbooks/remote-access.md";

const STATE: Record<RemoteAccessState, { label: string; tone: string; meta: string }> = {
  RUNNING: { label: "connected", tone: "var(--green)", meta: "connected on the home machine" },
  STOPPED: { label: "stopped", tone: "var(--amber)", meta: "installed, but not connected" },
  NEEDS_LOGIN: { label: "needs sign-in", tone: "var(--amber)", meta: "the home machine needs signing in" },
  NOT_INSTALLED: { label: "not installed", tone: "var(--coral)", meta: "not found on the home machine" },
  UNAVAILABLE: { label: "unknown", tone: "var(--ink3)", meta: "the runner couldn't read its status" },
};

const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine);

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function Notice({
  title,
  danger,
  alert,
  children,
}: {
  title: string;
  danger?: boolean;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className={`flex flex-none flex-col gap-1.5 rounded-[18px] bg-hair p-4 ${danger ? "border-2 border-coral" : ""}`}
    >
      <span className={`text-[13.5px] font-medium ${danger ? "text-coral" : ""}`}>{title}</span>
      {children && (
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-snug text-ink2">{children}</div>
      )}
    </div>
  );
}

const Command = ({ children }: { children: string }) => (
  <code className="block w-fit max-w-full rounded-lg border border-hair px-2.5 py-1.5 font-mono text-[12px] break-all text-ink select-all">
    {children}
  </code>
);

/** The fix for what the report shows. Funnel's includes setting Serve up again, so it replaces "not serving". */
function Fix({ report }: { report: RemoteAccessReport }) {
  if (report.state === "NOT_INSTALLED")
    return (
      <Notice title="Install Tailscale on the home machine">
        <p className="m-0">
          Follow <code className="font-mono text-[12px]">{RUNBOOK}</code>.
        </p>
      </Notice>
    );
  if (report.state === "STOPPED")
    return <Notice title="To fix it">Open Tailscale on the home machine and connect.</Notice>;
  if (report.state === "NEEDS_LOGIN")
    return (
      <Notice title="To fix it, on the home machine">
        <Command>tailscale up</Command>
      </Notice>
    );
  if (report.state === "UNAVAILABLE")
    return (
      <Notice title="To check">Open Tailscale on the home machine and see whether it is running.</Notice>
    );
  if (!report.serving && !report.funnel)
    return (
      <Notice title="To fix it, on the home machine">
        <Command>tailscale serve --bg 8787</Command>
      </Notice>
    );
  return null;
}

function Status({ data, now }: { data: RemoteAccessStatus; now: number }) {
  const { report, reportedAt, publicOrigin, stale } = data;
  if (!report || !reportedAt)
    return (
      <Notice title="No runner has reported yet">
        <p className="m-0">
          A paired runner on the home machine reports what Tailscale says there, so until one has, NEXUS
          doesn't know whether remote access is working. Pair a runner from the Systems zone; its first report
          arrives within about a minute of it starting.
        </p>
      </Notice>
    );
  const runnerName = data.runnerName ?? "a runner";
  const state = STATE[report.state];
  // NOT_INSTALLED and UNAVAILABLE mean Tailscale never answered: nothing is known about Serve, Funnel or devices.
  const answered = report.state === "RUNNING" || report.state === "STOPPED" || report.state === "NEEDS_LOGIN";
  const wrongAddress =
    report.serving && report.url !== null && report.url !== publicOrigin.replace(/\/$/, "");
  return (
    <>
      {stale && (
        <Notice title={`Last reported at ${hhmm(reportedAt)} by ${runnerName}, may have changed`}>
          <p className="m-0">The runner has stopped reporting, so this is how things looked then.</p>
        </Notice>
      )}
      {report.funnel && (
        <Notice alert danger title="Warning: NEXUS is published to the public internet">
          <p className="m-0">
            Tailscale Funnel is on, so anyone with the address can reach this NEXUS. It must stay private to
            your tailnet. On the home machine, run these in order:
          </p>
          <Command>tailscale funnel reset</Command>
          <Command>tailscale serve --bg 8787</Command>
        </Notice>
      )}
      {wrongAddress && (
        <Notice alert title={`Sign-in only works at ${publicOrigin}`}>
          <p className="m-0">
            Tailscale serves NEXUS at {report.url}, but NEXUS is set up for a different address. Change
            PUBLIC_ORIGIN on the home machine or use that address ({RUNBOOK}).
          </p>
        </Notice>
      )}
      <Rows label="Status">
        <Row title="Tailscale" meta={state.meta} badge={<Badge tone={state.tone}>{state.label}</Badge>} />
        {answered && (
          <>
            <li className="flex flex-col gap-1 border-b border-hair px-4 py-[13px] last:border-b-0">
              <span className="text-[13.5px] leading-[1.3] font-medium">Address</span>
              <span className="font-mono text-[11.5px] leading-[1.4] break-all text-ink3 select-text">
                {report.url === null
                  ? "none: nothing is being served"
                  : report.serving
                    ? report.url
                    : `${report.url} · serves something else, not NEXUS`}
              </span>
            </li>
            <Row
              title="Tailscale Serve"
              meta={
                report.serving
                  ? "on · forwards to NEXUS on the home machine"
                  : "off · not forwarding to NEXUS"
              }
              badge={
                <Badge tone={report.serving ? "var(--green)" : "var(--amber)"}>
                  {report.serving ? "on" : "off"}
                </Badge>
              }
            />
            <Row
              title="Who can reach it"
              meta={report.funnel ? "Public: Tailscale Funnel is on" : "Private to your tailnet"}
              badge={
                <Badge tone={report.funnel ? "var(--coral)" : "var(--green)"}>
                  {report.funnel ? "public" : "private"}
                </Badge>
              }
            />
          </>
        )}
        <Row title={`Reported by ${runnerName}`} meta={`at ${hhmm(reportedAt)} · ${ago(reportedAt, now)}`} />
      </Rows>
      {!stale && <Fix report={report} />}
      {answered && (
        <Rows label="Devices on your tailnet">
          {report.devices.length === 0 && <Row title="No devices reported" meta="Tailscale listed none" />}
          {report.devices.map((d) => (
            <Row
              key={`${d.name}-${d.self}`}
              title={d.self ? `${d.name} (home machine)` : d.name}
              meta={d.os || "unknown OS"}
              badge={
                <Badge tone={d.online ? "var(--green)" : "var(--ink3)"}>
                  {d.online ? "online" : "offline"}
                </Badge>
              }
            />
          ))}
        </Rows>
      )}
    </>
  );
}

export function RemoteAccessSettings() {
  const online = useOnline();
  const now = useNow(POLL_MS);
  const status = useQuery({
    queryKey: keys.remoteAccess,
    queryFn: api.remoteAccess,
    refetchInterval: POLL_MS,
  });
  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        How your devices reach NEXUS, as the home machine reports it. This page only shows it: changes are
        made on the home machine, because a mistake made from here could cut off the connection you're using.
      </p>
      {!online && (
        <Notice title="This device is offline">
          <p className="m-0">
            {status.data
              ? "This is the last status it received."
              : "NEXUS can't be asked for the status right now."}
          </p>
        </Notice>
      )}
      {online && status.data && status.error && (
        <Notice alert title="Couldn't refresh the status">
          <p className="m-0">{status.error.message} Showing the last status received.</p>
        </Notice>
      )}
      {status.data ? <Status data={status.data} now={now} /> : online && <DrawerState error={status.error} />}
    </>
  );
}

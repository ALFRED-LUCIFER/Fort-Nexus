import { useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { Notification } from "@nexus/contracts";
import { clock, until, useNow, usePendingApprovals } from "../lib/queries.ts";
import { DecisionButtons } from "./approval.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { CATEGORY, useOpenNotification, useScopeNotifications } from "./notifications.tsx";
import { useScope } from "./scope.tsx";

const route = getRouteApi("/");

// Design dInbox tabs. Approvals come from /v1/approvals (actionable); the rest from /v1/notifications.
const TABS = [
  ["all", "All"],
  ["approval", "Approvals"],
  ["failure", "Failures"],
  ["blocked", "Blocked"],
  ["business", "Business"],
  ["security", "Security"],
  ["connection", "Connections"],
  ["notice", "Done & notices"],
] as const;
type Tab = (typeof TABS)[number][0];

// What an empty tab honestly says. Blocked, Business and Connections have no source in the MVP.
const EMPTY: Record<Tab, string> = {
  all: "Nothing needs you. Finished and failed runs, push approvals and security notices show up here.",
  approval: "Nothing needs you. When a run asks to push a branch and open a draft PR, it shows up here.",
  failure: "No failed runs.",
  blocked:
    "Nothing is blocked. Runs don't wait for missing information today: missing acceptance criteria are recorded on the run.",
  business: "No business alerts. Business connectors arrive in P1.",
  security: "No security notices. Emergency stops and revoked runners show up here.",
  connection: "No connection alerts. Connector health arrives in P1.",
  notice: "No finished runs or notices yet.",
};

const seg = (on: boolean) =>
  `rounded-[10px] px-3 py-[9px] text-[12px] font-medium leading-none whitespace-nowrap ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink3"}`;

export function InboxDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <InboxBody />
    </Drawer>
  );
}

function InboxBody() {
  const navigate = route.useNavigate();
  const scope = useScope();
  const now = useNow(30_000);
  const pending = usePendingApprovals(scope.project?.id, scope.ready);
  const notes = useScopeNotifications();
  const [tab, setTab] = useState<Tab>("all");
  const items = pending.data ?? [];
  // A pending approval is listed as its actionable card; its APPROVAL_REQUIRED notice would repeat it.
  const notices = (notes.data?.items ?? []).filter((n) => n.category !== "APPROVAL_REQUIRED");
  const inTab = (t: Tab) => notices.filter((n) => t === "all" || CATEGORY[n.category].tab === t);
  const count = (t: Tab) =>
    (t === "all" || t === "approval" ? items.length : 0) + (t === "approval" ? 0 : inTab(t).length);
  const showsApprovals = tab === "all" || tab === "approval";
  const shown = tab === "approval" ? [] : inTab(tab);
  const loaded = (!showsApprovals || pending.data) && (tab === "approval" || notes.data);
  const empty = loaded && shown.length === 0 && (!showsApprovals || items.length === 0);

  return (
    <>
      <DrawerHeader
        kicker={`Inbox · ${pending.data ? `${items.length} pending` : "loading"}${notes.unread === undefined ? "" : ` · ${notes.unread} unread`}`}
        title="What needs you"
      />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pt-5 pb-6">
        <div
          role="group"
          aria-label="Inbox filter"
          className="flex flex-none flex-wrap gap-1 rounded-[14px] bg-hair p-1"
        >
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={seg(tab === id)}
            >
              {label}
              {pending.data && notes.data && (
                <span className="ml-1 font-mono text-[10.5px] opacity-60">{count(id)}</span>
              )}
            </button>
          ))}
        </div>

        {showsApprovals && !pending.data && <DrawerState error={pending.error} />}
        {tab !== "approval" && !notes.data && <DrawerState error={notes.error} />}
        {empty && <p className="m-0 text-[14px] leading-relaxed text-ink2">{EMPTY[tab]}</p>}

        {showsApprovals && items.length > 0 && (
          <ul aria-label="Pending approvals" className="m-0 flex list-none flex-col gap-2.5 p-0">
            {items.map((a) => (
              <li
                key={a.id}
                className="grid grid-cols-[4px_minmax(0,1fr)] items-stretch gap-3.5 overflow-hidden rounded-2xl border border-hair sm:grid-cols-[4px_minmax(0,1fr)_auto]"
              >
                <span aria-hidden="true" className="row-span-2 bg-amber sm:row-span-1" />
                <div className="flex min-w-0 flex-col gap-[5px] py-3.5">
                  <span className="kicker" style={{ color: "var(--amber)" }}>
                    Approval · {a.riskTier}
                  </span>
                  <span className="text-[14px] leading-[1.35] font-medium text-ink">
                    Push {a.action.headBranch} + open a draft PR for #{a.action.issueNumber}
                  </span>
                  <span className="text-[12px] leading-[1.4] break-words text-ink2">
                    {a.action.repositoryFullName} · {a.action.files.length}{" "}
                    {a.action.files.length === 1 ? "file" : "files"} · +{a.action.stats.added} −
                    {a.action.stats.removed} · into {a.action.baseBranch} · expires {until(a.expiresAt, now)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void navigate({ search: { ...scope.keep, drawer: `run:${a.jobId}` } })}
                    className="self-start text-[12px] font-medium text-teal underline"
                  >
                    Open the run <span className="sr-only">for #{a.action.issueNumber}</span>
                  </button>
                </div>
                <div className="py-3.5 pr-4 sm:self-center">
                  <DecisionButtons
                    approval={a}
                    approveLabel="Approve"
                    context={`push for #${a.action.issueNumber} on ${a.action.repositoryFullName}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {shown.length > 0 && (
          <ul aria-label="Notifications" className="m-0 flex list-none flex-col gap-2.5 p-0">
            {shown.map((n) => (
              <NoticeRow key={n.id} n={n} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function NoticeRow({ n }: { n: Notification }) {
  const open = useOpenNotification();
  const tone = CATEGORY[n.category].tone;
  const unread = n.status === "UNREAD";
  return (
    <li className="grid grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-3.5 overflow-hidden rounded-2xl border border-hair py-3.5 pr-4">
      <span aria-hidden="true" className="self-stretch" style={{ background: tone }} />
      <div className="flex min-w-0 flex-col gap-[5px]">
        <span className="kicker flex items-center gap-1.5" style={{ color: tone }}>
          {unread && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
          {n.category}
          {unread && <span className="sr-only">, unread</span>}
          <span className="text-ink3">· {clock(n.createdAt)}</span>
        </span>
        <span className={`text-[14px] leading-[1.35] text-ink ${unread ? "font-semibold" : "font-medium"}`}>
          {n.title}
        </span>
        <span className="text-[12px] leading-[1.4] break-words text-ink2">{n.body}</span>
      </div>
      <button
        type="button"
        onClick={() => open(n)}
        className="rounded-[11px] border border-hair px-[11px] py-[9px] text-[12px] font-medium whitespace-nowrap text-ink"
      >
        {n.subject.jobId ? "Open the run" : n.subject.incidentId ? "Open the incident" : "Open settings"}
        <span className="sr-only">: {n.title}</span>
      </button>
    </li>
  );
}

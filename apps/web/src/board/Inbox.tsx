import { useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { until, useNow, usePendingApprovals } from "../lib/queries.ts";
import { DecisionButtons } from "./approval.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";

const route = getRouteApi("/");

// Design dInbox tabs. Today only approvals exist; the rest need P1 sources.
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
  const { ws } = route.useSearch();
  const now = useNow(30_000);
  const pending = usePendingApprovals();
  const [tab, setTab] = useState<Tab>("all");
  const items = pending.data ?? [];
  const showsApprovals = tab === "all" || tab === "approval";

  return (
    <>
      <DrawerHeader
        kicker={`Inbox · ${pending.data ? `${items.length} pending` : "loading"}`}
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
              {(id === "all" || id === "approval") && pending.data && (
                <span className="ml-1 font-mono text-[10.5px] opacity-60">{items.length}</span>
              )}
            </button>
          ))}
        </div>

        {!showsApprovals ? (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">
            {TABS.find(([id]) => id === tab)?.[1]} arrive in P1. Today the inbox holds push approvals from
            runs.
          </p>
        ) : !pending.data ? (
          <DrawerState error={pending.error} />
        ) : items.length === 0 ? (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">
            Nothing needs you. When a run asks to push a branch and open a draft PR, it shows up here.
          </p>
        ) : (
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
                    onClick={() => void navigate({ search: { ws, drawer: `run:${a.jobId}` } })}
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
      </div>
    </>
  );
}

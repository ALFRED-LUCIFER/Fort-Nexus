import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  ConnectorEnvironment,
  ConnectorProvider,
  CreateConnectorRequest,
  MetricDictionary,
  type ConnectionTestResult,
  type Connector,
  type MetricProvenance,
  type PaymentFailuresResponse,
  type RevenueSummaryResponse,
  type SalesSummaryResponse,
  type TopProductsResponse,
  type Unavailable,
} from "@nexus/contracts";
import type { z } from "zod";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { ago, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { PICK_PROJECT, useScope } from "./scope.tsx";
import { EmptyZone } from "./zones.tsx";

// Business: read-only metric tools over a registered connector (EPIC CON/DATA/BIZ). Every number shown comes from the
// API with its provenance; when the API says UNAVAILABLE the UI says "no data", never 0 (DATA-G02).

const METRIC_POLL_MS = 60_000;

const field =
  "min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3";
const ghostBtn =
  "rounded-xl border border-hair px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-45";
const primaryBtn =
  "self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";
const labelCls = "flex flex-col gap-1 text-[11.5px] text-ink3";

const IN_DEV = "Business sources live in Business projects. Switch to one to see its orders and payments.";

/** The scope's connectors: one Business project, or All across them. Dev never asks: it holds no business sources. */
export const useConnectors = () => {
  const scope = useScope();
  const projectId = scope.project?.id;
  return useQuery({
    queryKey: keys.connectorsOf(projectId),
    queryFn: () => api.connectors(projectId),
    enabled: scope.ready && scope.ws !== "dev",
    refetchInterval: METRIC_POLL_MS,
  });
};

/** Why connectors can't be changed here, or null: All is read-only, and an archived project keeps only its history. */
function useWriteBlocked() {
  const { project } = useScope();
  if (!project) return PICK_PROJECT;
  return project.archivedAt ? `${project.name} is archived: its connectors are read-only.` : null;
}

/** The connector the board reports on: the first enabled one with a metric dictionary. */
export const primaryConnector = (list: readonly Connector[] | undefined) =>
  list?.find((c) => c.status !== "DISABLED" && c.hasDictionary);

export function bizSub(list: readonly Connector[] | undefined): string {
  if (!list) return "";
  const c = primaryConnector(list);
  if (c) return `${c.name} · today`;
  return list.length ? "no metric dictionary" : "not connected";
}

function useMetrics(connectorId: string | undefined) {
  const id = connectorId ?? "";
  const sales = useQuery({
    queryKey: keys.metric("sales", id),
    queryFn: () => api.salesSummary(id),
    enabled: !!connectorId,
    refetchInterval: METRIC_POLL_MS,
  });
  const payments = useQuery({
    queryKey: keys.metric("payments", id),
    queryFn: () => api.paymentFailures(id),
    enabled: !!connectorId,
    refetchInterval: METRIC_POLL_MS,
  });
  return { sales, payments };
}

/** Revenue and top products: drawer only, so the board's polling stays at two queries. */
function useInsights(connectorId: string | undefined) {
  const id = connectorId ?? "";
  const revenue = useQuery({
    queryKey: keys.metric("revenue", id),
    queryFn: () => api.revenue(id),
    enabled: !!connectorId,
    refetchInterval: METRIC_POLL_MS,
  });
  const top = useQuery({
    queryKey: keys.metric("topProducts", id),
    queryFn: () => api.topProducts(id),
    enabled: !!connectorId,
    refetchInterval: METRIC_POLL_MS,
  });
  return { revenue, top };
}

// ---------------------------------------------------------------- tiles

type TileState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "value"; value: string; detail: string; partial: boolean; stale: boolean };

type MetricResponse = SalesSummaryResponse | PaymentFailuresResponse | RevenueSummaryResponse;
type Available<R extends MetricResponse> = Exclude<R["current"], Unavailable>;

/** One KPI from a metric query: the value, or why there is none. Stale = the last refresh failed, the value is older. */
function tileState<R extends MetricResponse>(
  q: UseQueryResult<R>,
  pick: (cur: Available<R>, prev: R["previous"]) => { value: string; detail: string },
): TileState {
  if (!q.data) return q.error ? { kind: "error", message: q.error.message } : { kind: "loading" };
  const cur = q.data.current;
  if (cur.status === "UNAVAILABLE") return { kind: "unavailable", message: cur.message };
  return {
    kind: "value",
    ...pick(cur as Available<R>, q.data.previous),
    partial: cur.provenance.partial,
    stale: q.isRefetchError,
  };
}

const prevOf = <T,>(prev: T | Unavailable | null, f: (p: T) => string) =>
  prev && !("reason" in (prev as object)) ? f(prev as T) : "no data";

const percent = (rate: number | null) => (rate === null ? "no attempts" : `${(rate * 100).toFixed(1)}%`);

function salesTiles(q: UseQueryResult<SalesSummaryResponse>) {
  return [
    {
      label: "Paid orders today",
      state: tileState(q, (c, p) => ({
        value: String(c.paidOrders),
        detail: `yesterday same time: ${prevOf(p, (x) => String(x.paidOrders))}`,
      })),
    },
    {
      label: "Gross sales today",
      state: tileState(q, (c, p) => ({
        value: `${c.currency} ${c.grossSales}`,
        detail: `yesterday same time: ${prevOf(p, (x) => `${x.currency} ${x.grossSales}`)} · gross ≠ net`,
      })),
    },
  ];
}

function paymentTile(q: UseQueryResult<PaymentFailuresResponse>) {
  return {
    label: "Failed payments today",
    state: tileState(q, (c, p) => ({
      value: String(c.failed),
      detail: `${percent(c.failureRate)} fail rate · yesterday same time: ${prevOf(p, (x) => String(x.failed))}`,
    })),
  };
}

function revenueTiles(q: UseQueryResult<RevenueSummaryResponse>) {
  const money = (cur: string, v: string) => `${cur} ${v}`;
  const yesterday = (
    p: RevenueSummaryResponse["previous"],
    f: (x: Available<RevenueSummaryResponse>) => string,
  ) => `yesterday same time: ${prevOf(p, f)}`;
  return [
    {
      label: "Gross sales",
      state: tileState(q, (c, p) => ({
        value: money(c.currency, c.grossSales),
        detail: `paid orders by order time · ${yesterday(p, (x) => money(x.currency, x.grossSales))}`,
      })),
    },
    {
      label: "Refunds",
      state: tileState(q, (c, p) => ({
        value: money(c.currency, c.refunds),
        detail: `by refund time · ${yesterday(p, (x) => money(x.currency, x.refunds))}`,
      })),
    },
    {
      label: "Net sales",
      state: tileState(q, (c, p) => ({
        value: money(c.currency, c.netSales),
        detail: `gross − refunds · ${yesterday(p, (x) => money(x.currency, x.netSales))}`,
      })),
    },
  ];
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className="rounded-full px-2 py-[3px] font-mono text-[10px] font-medium tracking-[.04em] uppercase"
      style={{ color: tone, background: "var(--hair)" }}
    >
      {children}
    </span>
  );
}

function Tile({ label, state }: { label: string; state: TileState }) {
  return (
    <span className="flex h-full flex-col gap-2 rounded-[18px] border border-line bg-card px-4 py-3.5 text-left shadow-nx">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="kicker flex-1">{label}</span>
        {state.kind === "value" && state.partial && <Badge tone="var(--amber)">partial</Badge>}
        {state.kind === "value" && state.stale && <Badge tone="var(--coral)">stale</Badge>}
        {(state.kind === "unavailable" || state.kind === "error") && (
          <Badge tone="var(--coral)">unavailable</Badge>
        )}
      </span>
      {state.kind === "value" ? (
        <>
          <span className="font-serif text-[34px] leading-none">{state.value}</span>
          <span className="font-mono text-[11px] leading-[1.45] text-ink2">{state.detail}</span>
        </>
      ) : state.kind === "loading" ? (
        <span role="status" className="text-[13px] text-ink3">
          Loading…
        </span>
      ) : (
        <>
          <span className="font-serif text-[26px] leading-none text-ink2">no data</span>
          <span className="text-[12px] leading-[1.45] text-ink2">{state.message}</span>
        </>
      )}
    </span>
  );
}

const fmt = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

const windowLabel = (p: MetricProvenance) => `${fmt(p.from, p.timezone)} – ${fmt(p.to, p.timezone)}`;

/** Source + freshness line from the sales provenance (FR-DATA-07). */
function SourceLine({ p, now }: { p: MetricProvenance; now: number }) {
  return (
    <p className="m-0 font-mono text-[11px] leading-[1.5] text-ink3">
      source: {p.connectorName} · {p.environment.toLowerCase()} · read-only · {p.dataset} · newest record{" "}
      {ago(p.latestRecordAt, now)} · queried {ago(p.queriedAt, now)} · {p.timezone}
    </p>
  );
}

// ---------------------------------------------------------------- zone

export function BusinessZone({ onOpen }: { onOpen: () => void }) {
  const scope = useScope();
  const connectors = useConnectors();
  const c = primaryConnector(connectors.data);
  const { sales, payments } = useMetrics(c?.id);
  const now = useNow(30_000);

  if (scope.ws === "dev") return <EmptyZone>{IN_DEV}</EmptyZone>;
  if (!connectors.data)
    return <EmptyZone>{connectors.error ? connectors.error.message : "Loading…"}</EmptyZone>;
  if (!c)
    return (
      <div className="flex flex-col gap-4">
        <EmptyZone>
          {connectors.data.length
            ? "No enabled connector has a metric dictionary yet, so there are no numbers to show."
            : scope.project
              ? `No sources connected to ${scope.project.name}. Connect a read-only database to see orders and payments.`
              : "No business sources connected. Pick a Business project to connect one."}
        </EmptyZone>
        <button type="button" onClick={onOpen} className={primaryBtn}>
          {connectors.data.length ? "Define metrics" : "Connect a source"}
        </button>
      </div>
    );

  const tiles = [...salesTiles(sales), paymentTile(payments)];
  const p = sales.data?.current.status === "AVAILABLE" ? sales.data.current.provenance : undefined;
  return (
    <div className="flex flex-col gap-5">
      <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0">
        {tiles.map((t) => (
          <li key={t.label}>
            <button
              type="button"
              onClick={onOpen}
              aria-label={`${t.label}: ${t.state.kind === "value" ? `${t.state.value}${t.state.partial ? ", partial" : ""}${t.state.stale ? ", stale" : ""}` : "no data"}. Open Business.`}
              className="h-full w-full rounded-[18px] transition-shadow hover:shadow-[0_0_0_2px_var(--teal)]"
            >
              <Tile label={t.label} state={t.state} />
            </button>
          </li>
        ))}
      </ul>
      {p && <SourceLine p={p} now={now} />}
    </div>
  );
}

// ---------------------------------------------------------------- drawer

export function BusinessDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <BusinessBody />
    </Drawer>
  );
}

function BusinessBody() {
  const scope = useScope();
  const connectors = useConnectors();
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    connectors.data?.find((c) => c.id === selectedId && c.status !== "DISABLED") ??
    primaryConnector(connectors.data);
  const { sales, payments } = useMetrics(selected?.hasDictionary ? selected.id : undefined);
  const { revenue, top } = useInsights(selected?.hasDictionary ? selected.id : undefined);
  const now = useNow(30_000);

  if (scope.ws === "dev")
    return (
      <>
        <DrawerHeader kicker="Business · read-only" title="Business" />
        <p className="m-0 px-6 pt-5 text-[13.5px] text-ink2">{IN_DEV}</p>
      </>
    );
  if (!connectors.data)
    return (
      <>
        <DrawerHeader kicker="Business · read-only" title="Business" />
        <DrawerState error={connectors.error} />
      </>
    );

  const s = sales.data?.current;
  const pf = payments.data?.current;
  return (
    <>
      <DrawerHeader
        kicker={`Business · read-only${selected ? ` · ${selected.name} · ${selected.environment.toLowerCase()}` : ""}`}
        title={selected?.hasDictionary ? "Today vs yesterday" : "Connect a business source"}
      />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 pt-5 pb-6">
        {selected?.hasDictionary && (
          <>
            <ul className="m-0 grid flex-none list-none grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5 p-0">
              {[...salesTiles(sales), paymentTile(payments)].map((t) => (
                <li key={t.label}>
                  <Tile label={t.label} state={t.state} />
                </li>
              ))}
            </ul>
            <Comparison sales={sales.data} payments={payments.data} />
            {pf?.status === "AVAILABLE" && <Reasons byReason={pf.byReason} failed={pf.failed} />}
            {s?.status === "AVAILABLE" && (
              <div className="flex flex-none flex-col gap-1">
                <SourceLine p={s.provenance} now={now} />
                <p className="m-0 font-mono text-[11px] leading-[1.5] text-ink3">
                  {s.provenance.formula}
                  {s.excludedStatuses.length > 0 && ` · excluded statuses: ${s.excludedStatuses.join(", ")}`}
                </p>
              </div>
            )}
            <Revenue q={revenue} now={now} />
            <TopProductsTable q={top} />
          </>
        )}
        <Connectors items={connectors.data} selectedId={selected?.id} onSelect={(id) => setSelectedId(id)} />
      </div>
    </>
  );
}

function Comparison({
  sales,
  payments,
}: {
  sales: SalesSummaryResponse | undefined;
  payments: PaymentFailuresResponse | undefined;
}) {
  const cur = sales?.current;
  const prev = sales?.previous;
  const pc = payments?.current;
  const pp = payments?.previous;
  const cell = <T,>(r: T | Unavailable | null | undefined, f: (x: T) => string) =>
    !r ? "…" : "reason" in (r as object) ? "no data" : f(r as T);
  type S = Exclude<SalesSummaryResponse["current"], Unavailable>;
  type P = Exclude<PaymentFailuresResponse["current"], Unavailable>;
  const win = (r: SalesSummaryResponse["current"] | null | undefined) =>
    !r ? "…" : r.status === "AVAILABLE" ? `${windowLabel(r.provenance)} ${r.provenance.timezone}` : "no data";
  const rows: [string, string, string][] = [
    ["Paid orders", cell<S>(cur, (x) => String(x.paidOrders)), cell<S>(prev, (x) => String(x.paidOrders))],
    [
      "Gross sales",
      cell<S>(cur, (x) => `${x.currency} ${x.grossSales}`),
      cell<S>(prev, (x) => `${x.currency} ${x.grossSales}`),
    ],
    ["Payment attempts", cell<P>(pc, (x) => String(x.attempts)), cell<P>(pp, (x) => String(x.attempts))],
    ["Failed payments", cell<P>(pc, (x) => String(x.failed)), cell<P>(pp, (x) => String(x.failed))],
    ["Fail rate", cell<P>(pc, (x) => percent(x.failureRate)), cell<P>(pp, (x) => percent(x.failureRate))],
  ];
  return (
    <section
      aria-labelledby="biz-compare"
      className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
    >
      <h3 id="biz-compare" className="kicker m-0">
        Today vs yesterday · same clock window
      </h3>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="align-bottom">
            <th scope="col" className="py-1.5 pr-2 font-normal text-ink3">
              <span className="sr-only">Metric</span>
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium text-ink">
              Today{cur?.status === "AVAILABLE" && cur.provenance.partial ? " (partial)" : ""}
              <span className="block font-mono text-[10.5px] font-normal text-ink3">{win(cur)}</span>
            </th>
            <th scope="col" className="py-1.5 font-medium text-ink">
              Yesterday
              <span className="block font-mono text-[10.5px] font-normal text-ink3">{win(prev)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, a, b]) => (
            <tr key={k} className="border-t border-hair">
              <th scope="row" className="py-2 pr-2 font-normal text-ink2">
                {k}
              </th>
              <td className="py-2 pr-2 font-mono text-ink">{a}</td>
              <td className="py-2 font-mono text-ink">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Revenue({ q, now }: { q: UseQueryResult<RevenueSummaryResponse>; now: number }) {
  const r = q.data?.current;
  return (
    <section aria-labelledby="biz-revenue" className="flex flex-none flex-col gap-2.5">
      <h3 id="biz-revenue" className="kicker m-0">
        Revenue today · gross, refunds, net
      </h3>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5 p-0">
        {revenueTiles(q).map((t) => (
          <li key={t.label}>
            <Tile label={t.label} state={t.state} />
          </li>
        ))}
      </ul>
      {r?.status === "AVAILABLE" && (
        <div className="flex flex-col gap-1">
          <p className="m-0 font-mono text-[11px] leading-[1.5] text-ink3">{r.formula}</p>
          <SourceLine p={r.refundsProvenance} now={now} />
        </div>
      )}
    </section>
  );
}

function TopProductsTable({ q }: { q: UseQueryResult<TopProductsResponse> }) {
  const r = q.data?.current;
  return (
    <section
      aria-labelledby="biz-top"
      className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
    >
      <h3 id="biz-top" className="kicker m-0">
        Top products today · by revenue · masked
        {r?.status === "AVAILABLE" && r.provenance.partial ? " · partial" : ""}
      </h3>
      {!r ? (
        <p role={q.error ? "alert" : "status"} className="m-0 text-[13px] text-ink2">
          {q.error ? q.error.message : "Loading…"}
        </p>
      ) : r.status === "UNAVAILABLE" ? (
        <p className="m-0 text-[13px] text-ink2">No data: {r.message}</p>
      ) : r.items.length === 0 ? (
        <p className="m-0 text-[13px] text-ink2">No products sold in paid orders in this window.</p>
      ) : (
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr>
              <th scope="col" className="py-1.5 pr-2 font-medium text-ink">
                Product
              </th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium text-ink">
                Qty
              </th>
              <th scope="col" className="py-1.5 text-right font-medium text-ink">
                Revenue
              </th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((i) => (
              <tr key={i.product} className="border-t border-hair">
                <th
                  scope="row"
                  className="max-w-0 truncate py-2 pr-2 font-normal text-ink2"
                  title={i.product}
                >
                  {i.product}
                </th>
                <td className="py-2 pr-2 text-right font-mono text-ink">{i.quantity}</td>
                <td className="py-2 text-right font-mono text-ink">
                  {r.currency} {i.revenue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r?.status === "AVAILABLE" && (
        <p className="m-0 font-mono text-[11px] leading-[1.5] text-ink3">
          {r.provenance.formula}
          {q.isRefetchError ? " · stale: the last refresh failed" : ""}
        </p>
      )}
    </section>
  );
}

function Reasons({ byReason, failed }: { byReason: { reason: string; count: number }[]; failed: number }) {
  return (
    <section
      aria-labelledby="biz-reasons"
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border border-hair p-4"
    >
      <h3 id="biz-reasons" className="kicker m-0">
        Failed payments by reason · masked
      </h3>
      {byReason.length === 0 ? (
        <p className="m-0 text-[13px] text-ink2">No failed payments in this window.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {byReason.map((r) => (
            <li
              key={r.reason}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-center gap-2.5"
            >
              <span className="truncate text-[12.5px] text-ink2" title={r.reason}>
                {r.reason}
              </span>
              <span aria-hidden="true" className="h-2 overflow-hidden rounded bg-hair">
                <span
                  className="block h-full rounded bg-coral"
                  style={{ width: `${failed ? (r.count / failed) * 100 : 0}%` }}
                />
              </span>
              <span className="text-right font-mono text-[12px] text-ink">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- connectors

const STATUS_TONE: Record<Connector["status"], string> = {
  CONNECTED: "var(--green)",
  UNTESTED: "var(--amber)",
  FAILED: "var(--coral)",
  DISABLED: "var(--ink3)",
};

/** First Zod issue as "path: message", for inline form errors before anything is sent. */
const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0]!;
  return `${i.path.join(".") || "form"}: ${i.message}`;
};
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function Connectors({
  items,
  selectedId,
  onSelect,
}: {
  items: Connector[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const blocked = useWriteBlocked();
  return (
    <section aria-labelledby="biz-connectors" className="flex flex-none flex-col gap-3">
      <h3 id="biz-connectors" className="kicker m-0">
        Connectors · read-only
      </h3>
      {blocked && (
        <p id="biz-blocked" className="m-0 text-[13px] leading-snug text-ink2">
          {blocked}
        </p>
      )}
      {items.length === 0 && (
        <p className="m-0 text-[13.5px] text-ink2">
          No connectors yet. Create a read-only role and a credential file on the home machine (
          <code className="font-mono text-[12px]">docs/runbooks/business-connector.md</code>), then register
          it below.
        </p>
      )}
      <ul aria-label="Connectors" className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((c) => (
          <li key={c.id}>
            <ConnectorRow
              c={c}
              selected={c.id === selectedId}
              editing={editing === c.id}
              onSelect={() => onSelect(c.id)}
              onEdit={() => setEditing(editing === c.id ? undefined : c.id)}
            />
          </li>
        ))}
      </ul>
      <RegisterForm />
    </section>
  );
}

function ConnectorRow({
  c,
  selected,
  editing,
  onSelect,
  onEdit,
}: {
  c: Connector;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const blocked = useWriteBlocked();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["business"] });
  const test = useMutation({ mutationFn: () => api.testConnector(c.id), onSettled: refresh });
  const toggle = useMutation({
    mutationFn: () => api.updateConnector(c.id, { disabled: c.status !== "DISABLED" }),
    onSettled: refresh,
  });
  return (
    <div
      className={`flex flex-col gap-2.5 rounded-2xl border px-4 py-3.5 ${selected ? "border-teal" : "border-hair"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ background: STATUS_TONE[c.status] }}
        />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{c.name}</span>
        <span className="font-mono text-[11px] text-ink2">
          {c.status.toLowerCase()} · {c.provider.toLowerCase()} · {c.environment.toLowerCase()}
        </span>
      </div>
      <span className="font-mono text-[11px] text-ink3">
        credential {c.credentialRef} · schemas {c.schemaAllowlist.join(", ")} · timeout {c.statementTimeoutMs}{" "}
        ms · tested {ago(c.lastTestedAt, now)} ·{" "}
        {c.hasDictionary ? "metrics defined" : "no metric dictionary"}
      </span>
      {c.lastError && c.status === "FAILED" && <p className="m-0 text-[12.5px] text-coral">{c.lastError}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={c.status === "DISABLED" || test.isPending || !!blocked}
          aria-describedby={blocked ? "biz-blocked" : undefined}
          onClick={() => test.mutate()}
          className={ghostBtn}
        >
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
        <button type="button" aria-expanded={editing} onClick={onEdit} className={ghostBtn}>
          Metric dictionary
        </button>
        {c.hasDictionary && c.status !== "DISABLED" && !selected && (
          <button type="button" onClick={onSelect} className={ghostBtn}>
            Show its numbers
          </button>
        )}
        <button
          type="button"
          disabled={toggle.isPending || !!blocked}
          aria-describedby={blocked ? "biz-blocked" : undefined}
          onClick={() => toggle.mutate()}
          className={ghostBtn}
        >
          {c.status === "DISABLED" ? "Enable" : "Disable"}
        </button>
      </div>
      {(test.error ?? toggle.error) && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {(test.error ?? toggle.error)!.message}
        </p>
      )}
      {test.data && <TestResult result={test.data} />}
      {editing && <DictionaryForm connectorId={c.id} />}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  return (
    <div role="status" className="flex flex-col gap-1.5">
      <span className={`text-[12.5px] font-medium ${result.ok ? "text-green" : "text-coral"}`}>
        {result.ok ? "Connection test passed" : "Connection test failed"}
      </span>
      <ul aria-label="Connection checks" className="m-0 flex list-none flex-col gap-1 p-0">
        {result.checks.map((ch) => (
          <li key={ch.name} className="text-[12px] leading-[1.45] text-ink2">
            <span className={`font-mono ${ch.ok ? "text-green" : "text-coral"}`}>
              {ch.ok ? "pass" : "fail"} {ch.name}
            </span>{" "}
            · {ch.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RegisterForm() {
  const queryClient = useQueryClient();
  const { project } = useScope();
  const blocked = useWriteBlocked();
  const blank = {
    name: "",
    provider: "POSTGRES",
    environment: "DEV",
    credentialRef: "",
    schemas: "",
    timeout: "5000",
  };
  const [form, setForm] = useState(blank);
  const [invalid, setInvalid] = useState<string>();
  const create = useMutation({
    mutationFn: api.createConnector,
    onSuccess: () => {
      setForm(blank);
      void queryClient.invalidateQueries({ queryKey: keys.connectors });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateConnectorRequest.safeParse({
      projectId: project?.id,
      name: form.name,
      provider: form.provider,
      environment: form.environment,
      credentialRef: form.credentialRef.trim(),
      schemaAllowlist: list(form.schemas),
      statementTimeoutMs: Number(form.timeout),
    });
    setInvalid(parsed.success ? undefined : firstIssue(parsed.error));
    if (parsed.success) create.mutate(parsed.data);
  };
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <form
      aria-labelledby="biz-register"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-[18px] border border-hair p-4"
    >
      <h4 id="biz-register" className="kicker m-0">
        Register a read-only connector
      </h4>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        <label className={labelCls}>
          Name
          <input required value={form.name} onChange={set("name")} className={field} />
        </label>
        <label className={labelCls}>
          Provider
          <select value={form.provider} onChange={set("provider")} className={field}>
            {ConnectorProvider.options.map((p) => (
              <option key={p} value={p}>
                {p === "POSTGRES" ? "Postgres" : "Supabase"}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Environment
          <select value={form.environment} onChange={set("environment")} className={field}>
            {ConnectorEnvironment.options.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Credential reference
          <input
            required
            value={form.credentialRef}
            placeholder="shop-prod"
            onChange={set("credentialRef")}
            className={field}
          />
        </label>
        <label className={labelCls}>
          Schemas (comma-separated)
          <input
            required
            value={form.schemas}
            placeholder="shop"
            onChange={set("schemas")}
            className={field}
          />
        </label>
        <label className={labelCls}>
          Statement timeout (ms)
          <input
            type="number"
            min={500}
            max={30000}
            value={form.timeout}
            onChange={set("timeout")}
            className={field}
          />
        </label>
      </div>
      <p className="m-0 text-[12px] text-ink3">
        The reference names <code className="font-mono">~/.nexus/connectors/&lt;reference&gt;.json</code> on
        the home machine. The password never leaves that file.
      </p>
      {(invalid ?? create.error) && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {invalid ?? create.error!.message}
        </p>
      )}
      <button
        type="submit"
        disabled={create.isPending || !!blocked}
        aria-describedby={blocked ? "biz-blocked" : undefined}
        className={primaryBtn}
      >
        {create.isPending ? "Registering…" : "Register"}
      </button>
    </form>
  );
}

type Unit = "MINOR" | "MAJOR";
type DictForm = {
  reportingTimezone: string;
  currency: string;
  ordersTable: string;
  ordersCreatedAt: string;
  ordersStatus: string;
  ordersAmount: string;
  amountUnit: Unit;
  paidStatuses: string;
  ordersId: string;
  withPayments: boolean;
  paymentsTable: string;
  paymentsCreatedAt: string;
  paymentsStatus: string;
  paymentsReason: string;
  failedStatuses: string;
  withRefunds: boolean;
  refundsTable: string;
  refundsCreatedAt: string;
  refundsAmount: string;
  refundsUnit: Unit;
  withItems: boolean;
  itemsTable: string;
  itemsOrderId: string;
  itemsProduct: string;
  itemsQuantity: string;
  itemsAmount: string;
  itemsUnit: Unit;
};
type UnitKey = "amountUnit" | "refundsUnit" | "itemsUnit";
type CheckKey = "withPayments" | "withRefunds" | "withItems";

const toForm = (d: MetricDictionary | undefined): DictForm => ({
  reportingTimezone: d?.reportingTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  currency: d?.currency ?? "",
  ordersTable: d?.orders.table ?? "",
  ordersCreatedAt: d?.orders.createdAtColumn ?? "created_at",
  ordersStatus: d?.orders.statusColumn ?? "status",
  ordersAmount: d?.orders.amountColumn ?? "",
  amountUnit: d?.orders.amountUnit ?? "MINOR",
  paidStatuses: d?.orders.paidStatuses.join(", ") ?? "paid",
  withPayments: !!d?.payments,
  paymentsTable: d?.payments?.table ?? "",
  paymentsCreatedAt: d?.payments?.createdAtColumn ?? "created_at",
  paymentsStatus: d?.payments?.statusColumn ?? "status",
  paymentsReason: d?.payments?.reasonColumn ?? "",
  failedStatuses: d?.payments?.failedStatuses.join(", ") ?? "failed",
  ordersId: d?.orders.idColumn ?? "",
  withRefunds: !!d?.refunds,
  refundsTable: d?.refunds?.table ?? "",
  refundsCreatedAt: d?.refunds?.createdAtColumn ?? "created_at",
  refundsAmount: d?.refunds?.amountColumn ?? "",
  refundsUnit: d?.refunds?.amountUnit ?? "MINOR",
  withItems: !!d?.orderItems,
  itemsTable: d?.orderItems?.table ?? "",
  itemsOrderId: d?.orderItems?.orderIdColumn ?? "order_id",
  itemsProduct: d?.orderItems?.productColumn ?? "",
  itemsQuantity: d?.orderItems?.quantityColumn ?? "quantity",
  itemsAmount: d?.orderItems?.amountColumn ?? "",
  itemsUnit: d?.orderItems?.amountUnit ?? "MINOR",
});

function DictionaryForm({ connectorId }: { connectorId: string }) {
  // 404 = no dictionary yet: start from a blank form.
  const current = useQuery({
    queryKey: keys.dictionary(connectorId),
    queryFn: () =>
      api.dictionary(connectorId).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 404) return null;
        throw e;
      }),
  });
  if (current.data === undefined) return <DrawerState error={current.error} />;
  return <DictionaryFields connectorId={connectorId} initial={toForm(current.data ?? undefined)} />;
}

function DictionaryFields({ connectorId, initial }: { connectorId: string; initial: DictForm }) {
  const queryClient = useQueryClient();
  const blocked = useWriteBlocked();
  const [form, setForm] = useState(initial);
  const [invalid, setInvalid] = useState<string>();
  const save = useMutation({
    mutationFn: (d: MetricDictionary) => api.putDictionary(connectorId, d),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["business"] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = MetricDictionary.safeParse({
      reportingTimezone: form.reportingTimezone.trim(),
      currency: form.currency.trim().toUpperCase(),
      orders: {
        table: form.ordersTable.trim(),
        createdAtColumn: form.ordersCreatedAt.trim(),
        statusColumn: form.ordersStatus.trim(),
        amountColumn: form.ordersAmount.trim(),
        amountUnit: form.amountUnit,
        paidStatuses: list(form.paidStatuses),
        idColumn: form.ordersId.trim() || undefined,
      },
      payments: form.withPayments
        ? {
            table: form.paymentsTable.trim(),
            createdAtColumn: form.paymentsCreatedAt.trim(),
            statusColumn: form.paymentsStatus.trim(),
            reasonColumn: form.paymentsReason.trim(),
            failedStatuses: list(form.failedStatuses),
          }
        : undefined,
      refunds: form.withRefunds
        ? {
            table: form.refundsTable.trim(),
            createdAtColumn: form.refundsCreatedAt.trim(),
            amountColumn: form.refundsAmount.trim(),
            amountUnit: form.refundsUnit,
          }
        : undefined,
      orderItems: form.withItems
        ? {
            table: form.itemsTable.trim(),
            orderIdColumn: form.itemsOrderId.trim(),
            productColumn: form.itemsProduct.trim(),
            quantityColumn: form.itemsQuantity.trim(),
            amountColumn: form.itemsAmount.trim(),
            amountUnit: form.itemsUnit,
          }
        : undefined,
    });
    setInvalid(parsed.success ? undefined : firstIssue(parsed.error));
    if (parsed.success) save.mutate(parsed.data);
  };
  const text = (k: Exclude<keyof DictForm, UnitKey | CheckKey>, label: string, placeholder?: string) => (
    <label className={labelCls}>
      {label}
      <input
        value={form[k]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        className={field}
      />
    </label>
  );
  const unit = (k: UnitKey) => (
    <label className={labelCls}>
      Amount unit
      <select
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value as Unit })}
        className={field}
      >
        <option value="MINOR">Minor units (cents)</option>
        <option value="MAJOR">Major units</option>
      </select>
    </label>
  );
  const check = (k: CheckKey, label: string) => (
    <label className="flex items-center gap-2 text-[12.5px] text-ink">
      <input
        type="checkbox"
        checked={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <form
      aria-label="Metric dictionary"
      onSubmit={submit}
      className="flex flex-col gap-3 border-t border-hair pt-3"
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        {text("reportingTimezone", "Reporting time zone", "Asia/Dubai")}
        {text("currency", "Currency", "AED")}
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="kicker mb-1.5">Orders</legend>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
          {text("ordersTable", "Table (schema.table)", "shop.orders")}
          {text("ordersCreatedAt", "Created-at column")}
          {text("ordersStatus", "Status column")}
          {text("ordersAmount", "Amount column", "amount_cents")}
          {unit("amountUnit")}
          {text("paidStatuses", "Paid statuses (comma-separated)")}
          {text("ordersId", "Order id column (for order items)", "id")}
        </div>
      </fieldset>
      {check("withPayments", "Payments table")}
      {form.withPayments && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="kicker mb-1.5">Payments</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {text("paymentsTable", "Table (schema.table)", "shop.payments")}
            {text("paymentsCreatedAt", "Created-at column")}
            {text("paymentsStatus", "Status column")}
            {text("paymentsReason", "Failure reason column", "failure_reason")}
            {text("failedStatuses", "Failed statuses (comma-separated)")}
          </div>
        </fieldset>
      )}
      {check("withRefunds", "Refunds table (counted on the refund day)")}
      {form.withRefunds && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="kicker mb-1.5">Refunds</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {text("refundsTable", "Table (schema.table)", "shop.refunds")}
            {text("refundsCreatedAt", "Created-at column")}
            {text("refundsAmount", "Amount column", "amount_cents")}
            {unit("refundsUnit")}
          </div>
        </fieldset>
      )}
      {check("withItems", "Order items table (top products)")}
      {form.withItems && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="kicker mb-1.5">Order items</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {text("itemsTable", "Table (schema.table)", "shop.order_items")}
            {text("itemsOrderId", "Order id column")}
            {text("itemsProduct", "Product column", "product_name")}
            {text("itemsQuantity", "Quantity column")}
            {text("itemsAmount", "Amount column", "amount_cents")}
            {unit("itemsUnit")}
          </div>
        </fieldset>
      )}
      {(invalid ?? save.error) && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {invalid ?? save.error!.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="m-0 text-[12.5px] text-ink2">
          Saved. Run the connection test again; a production connector serves no numbers until it passes.
        </p>
      )}
      <button
        type="submit"
        disabled={save.isPending || !!blocked}
        aria-describedby={blocked ? "biz-blocked" : undefined}
        className={primaryBtn}
      >
        {save.isPending ? "Saving…" : "Save dictionary"}
      </button>
    </form>
  );
}

import type pg from "pg";
import type {
  MetricDictionary,
  MetricProvenance,
  MetricQuery,
  PaymentFailures,
  PaymentFailuresResponse,
  RevenueSummary,
  RevenueSummaryResponse,
  SalesSummary,
  SalesSummaryResponse,
  TopProducts,
  TopProductsResponse,
  Unavailable,
} from "@nexus/contracts";
import { TOP_PRODUCTS_LIMIT } from "@nexus/contracts";
import { audit } from "../audit.ts";
import { HttpError } from "../errors.ts";
import { findConnector, type BusinessScope } from "./connectors.ts";
import { CredentialError, loadConnectionString } from "./credentials.ts";
import { ConnectError, IdentifierError, isTimeout, quoteColumn, quoteTable, readOnly } from "./gateway.ts";
import type { BusinessConnectorRow } from "./schema.ts";

// Typed metric tools (FR-DATA-05, FR-BIZ-02/03/07). Each call is one READ ONLY transaction running fixed aggregate SQL
// per day window; identifiers come only from the validated dictionary. Values come back with provenance or as
// UNAVAILABLE with a reason, never as an invented zero (DATA-G02).

export type ToolScope = BusinessScope & { now?: Date };

const MAX_GROUPS = 20;

// FR-DATA-09: emails and digit runs of 6+ (optionally space/dash separated, e.g. card numbers) are masked inside the
// source database, so raw values never reach NEXUS. Reason and product text is capped at 120 chars.
const mask = (expr: string) =>
  `left(regexp_replace(regexp_replace(coalesce(${expr}, '(none)'), '[^[:space:]@]+@[^[:space:]@]+', '[email]', 'g'), '[0-9](?:[ -]?[0-9]){5,}', '[number]', 'g'), 120)`;

// Window for local day $1 in time zone $2: [local 00:00, next local 00:00), cut at the same local clock time as "now"
// ($3) is on the reference day $4. For today that ends the window at now (partial); for the previous day it gives the
// same clock window (BIZ-G01); for complete days the cut lies beyond the end and changes nothing.
const WINDOW = `w as (
  select f, least(e, cut) as t, $3::timestamptz < e as partial from (
    select ($1::date::timestamp) at time zone $2 as f,
           (($1::date + 1)::timestamp) at time zone $2 as e,
           ($1::date::timestamp + (($3::timestamptz at time zone $2) - $4::date::timestamp)) at time zone $2 as cut
  ) b
)`;

// Top groups by count; beyond MAX_GROUPS the tail is summed into one "other" bucket so counts still add up.
const capped = (from: string, other: string, extra = "") => `
  select case when total <= ${MAX_GROUPS} or rn < ${MAX_GROUPS} then k else '${other}' end as k, sum(n)::int as n${extra ? `, bool_or(${extra}) as ${extra}` : ""}
  from (select *, row_number() over (order by ${extra ? `${extra} desc, ` : ""}n desc, k) as rn, count(*) over () as total from ${from}) r
  group by 1`;

type WindowRow = { f: Date; t: Date; partial: boolean; latest: Date | null };

const localDate = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const minorDigits = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

type AmountUnit = MetricDictionary["orders"]["amountUnit"];

/** sum(a) in major currency units as an exact SQL numeric (never a JS float); 0 for no rows. */
const majorSum = (unit: AmountUnit, digits: number) =>
  unit === "MINOR"
    ? `round(coalesce(sum(a), 0)::numeric / power(10::numeric, ${digits}), ${digits})`
    : `coalesce(sum(a), 0)::numeric`;
/** The same sum as formula text. */
const sumText = (column: string, unit: AmountUnit, digits: number) =>
  unit === "MINOR" ? `sum(${column})/${10 ** digits}` : `sum(${column})`;

/** The source's data doesn't fit the metric's definition; reported as NOT_DEFINED, never as a wrong number. */
class NotDefined extends Error {}

const unavailable = (reason: Unavailable["reason"], message: string): Unavailable => ({
  status: "UNAVAILABLE",
  reason,
  message,
});

type Ready = { row: BusinessConnectorRow; dict: MetricDictionary; connectionString: string };

type Needs = "orders" | "payments" | "refunds" | "orderItems";

/** Everything that must hold before a tool may touch the source; otherwise the reason it is unavailable. */
async function resolveSource(
  s: ToolScope,
  row: BusinessConnectorRow | undefined,
  needs: Needs,
): Promise<Ready | Unavailable> {
  if (!row) return unavailable("NO_CONNECTOR", "No business source is connected for this request");
  if (row.status === "DISABLED") return unavailable("CONNECTOR_DISABLED", `${row.name} is disabled`);
  if (row.status === "FAILED")
    return unavailable(
      "CONNECTOR_FAILED",
      `${row.name} failed its last connection test: ${row.lastError ?? ""}`,
    );
  if (row.environment === "PROD" && row.status !== "CONNECTED")
    return unavailable(
      "CONNECTOR_FAILED",
      `${row.name} is a production source and must pass a connection test before tools can use it`,
    );
  const dict = row.dictionary;
  if (!dict) return unavailable("NOT_DEFINED", `${row.name} has no metric dictionary yet`);
  if (needs === "payments" && !dict.payments)
    return unavailable("NOT_DEFINED", `${row.name}'s metric dictionary doesn't define payments`);
  // DATA-G02: no refunds section means refunds are unknown, not zero.
  if (needs === "refunds" && !dict.refunds)
    return unavailable("NOT_DEFINED", `${row.name}'s metric dictionary doesn't define refunds`);
  if (needs === "orderItems" && (!dict.orderItems || !dict.orders.idColumn))
    return unavailable(
      "NOT_DEFINED",
      `${row.name}'s metric dictionary doesn't define order items joined on an order id column`,
    );
  try {
    return { row, dict, connectionString: await loadConnectionString(s.connectorsDir, row.credentialRef) };
  } catch (err) {
    if (err instanceof CredentialError) return unavailable("CONNECTOR_FAILED", err.message);
    throw err;
  }
}

type Win = { day: string; reference: string; now: Date };

type Days = { current: string; previous: string | null; reference: string };

function days(query: MetricQuery, timeZone: string, now: Date): Days {
  const today = localDate(now, timeZone);
  const day = query.day === "today" ? today : query.day === "yesterday" ? addDays(today, -1) : query.day;
  if (day > today)
    throw new HttpError(
      400,
      "VALIDATION_FAILED",
      `${day} is in the future in ${timeZone} (today is ${today})`,
    );
  return { current: day, previous: query.compare ? addDays(day, -1) : null, reference: day };
}

const provenance = (
  r: Ready,
  table: string,
  w: WindowRow,
  filters: MetricProvenance["filters"],
  formula: string,
): MetricProvenance => ({
  connectorId: r.row.id,
  connectorName: r.row.name,
  environment: r.row.environment,
  dataset: table,
  timezone: r.dict.reportingTimezone,
  from: w.f.toISOString(),
  to: w.t.toISOString(),
  filters,
  formula,
  queriedAt: new Date().toISOString(),
  latestRecordAt: w.latest?.toISOString() ?? null,
  partial: w.partial,
});

/** Runs one tool call: resolve, one READ ONLY transaction for the window(s), one audit record. */
async function runTool<R>(
  s: ToolScope,
  query: MetricQuery,
  tool: "sales_summary" | "payment_failures" | "revenue" | "top_products",
  needs: Needs,
  run: (c: pg.Client, r: Ready, win: Win) => Promise<R>,
): Promise<{ current: R | Unavailable; previous: R | Unavailable | null }> {
  const started = performance.now();
  const now = s.now ?? new Date();
  const row = await findConnector(s, query.connectorId);
  const ready = await resolveSource(s, row, needs);
  let result: { current: R | Unavailable; previous: R | Unavailable | null };
  if ("status" in ready) {
    result = { current: ready, previous: query.compare ? ready : null };
  } else {
    const d = days(query, ready.dict.reportingTimezone, now);
    try {
      result = await readOnly(
        ready.connectionString,
        { timeoutMs: ready.row.statementTimeoutMs, schemas: ready.row.schemaAllowlist },
        async (c) => ({
          current: await run(c, ready, { day: d.current, reference: d.reference, now }),
          previous: d.previous ? await run(c, ready, { day: d.previous, reference: d.reference, now }) : null,
        }),
      );
    } catch (err) {
      const u = isTimeout(err)
        ? unavailable("TIMEOUT", `${ready.row.name} didn't answer within ${ready.row.statementTimeoutMs} ms`)
        : err instanceof IdentifierError || err instanceof NotDefined
          ? unavailable("NOT_DEFINED", err.message)
          : err instanceof ConnectError
            ? unavailable("CONNECTOR_FAILED", `${ready.row.name}: ${err.message}`)
            : unavailable(
                "CONNECTOR_FAILED",
                // pg messages can quote data: report the SQLSTATE only.
                `${ready.row.name}: query failed (SQLSTATE ${String((err as { code?: unknown }).code ?? "unknown")})`,
              );
      result = { current: u, previous: d.previous ? u : null };
    }
  }

  const c = result.current as { status: string; reason?: string };
  await audit(s.db, {
    actor: s.actor,
    action: `business.${tool}`,
    resourceType: "connector",
    resourceId: query.connectorId,
    correlationId: s.correlationId,
    outcome: c.status === "UNAVAILABLE" ? "FAILED" : "SUCCEEDED",
    metadata: {
      workspaceId: row?.workspaceId ?? null,
      projectId: s.projectId,
      tool,
      environment: "status" in ready ? null : ready.row.environment,
      day: query.day,
      compare: query.compare,
      status: c.status,
      ...(c.reason && { reason: c.reason }),
      durationMs: Math.round(performance.now() - started),
    },
  });
  return result;
}

/** Paid orders, gross sales and counts by status for one local day (FR-BIZ-02). */
export async function getSalesSummary(scope: ToolScope, query: MetricQuery): Promise<SalesSummaryResponse> {
  return runTool(scope, query, "sales_summary", "orders", async (c, r, win): Promise<SalesSummary> => {
    const o = r.dict.orders;
    const table = quoteTable(o.table, r.row.schemaAllowlist);
    const [created, status, amount] = [o.createdAtColumn, o.statusColumn, o.amountColumn].map(quoteColumn);
    const digits = minorDigits(r.dict.currency);
    const gross = `${majorSum(o.amountUnit, digits)}::text`;
    const res = await c.query<
      WindowRow & { groups: { k: string; n: number; p: boolean | null }[]; paid: number; gross: string }
    >(
      `with ${WINDOW},
       o as (select x.${status}::text as s, x.${amount} as a from ${table} x, w where x.${created} >= w.f and x.${created} < w.t),
       g as (select ${mask("s")} as k, count(*)::int as n, coalesce(bool_or(s = any($5::text[])), false) as p from o group by 1),
       c as (${capped("g", "(other statuses)", "p")})
       select w.f, w.t, w.partial,
         (select max(x.${created})::timestamptz from ${table} x) as latest,
         (select coalesce(json_agg(json_build_object('k', k, 'n', n, 'p', p) order by n desc, k), '[]'::json) from c) as groups,
         (select count(*)::int from o where s = any($5::text[])) as paid,
         (select ${gross} from o where s = any($5::text[])) as gross
       from w`,
      [win.day, r.dict.reportingTimezone, win.now, win.reference, o.paidStatuses],
    );
    const w = res.rows[0]!;
    const unit = sumText(o.amountColumn, o.amountUnit, digits);
    return {
      status: "AVAILABLE",
      paidOrders: w.paid,
      grossSales: w.gross,
      currency: r.dict.currency,
      byStatus: w.groups.map((g) => ({ status: g.k, count: g.n })),
      excludedStatuses: w.groups.filter((g) => !g.p).map((g) => g.k),
      provenance: provenance(
        r,
        o.table,
        w,
        { [o.statusColumn]: o.paidStatuses },
        `paid orders = count(*), gross sales = ${unit} in ${r.dict.currency}, where ${o.statusColumn} in (${o.paidStatuses.join(", ")}) and ${o.createdAtColumn} in [from, to)`,
      ),
    };
  });
}

/** Payment attempts, failures and failure reasons (masked, at most 20 groups) for one local day (FR-BIZ-03). */
export async function getPaymentFailures(
  scope: ToolScope,
  query: MetricQuery,
): Promise<PaymentFailuresResponse> {
  return runTool(
    scope,
    query,
    "payment_failures",
    "payments",
    async (c, r, win): Promise<PaymentFailures> => {
      const p = r.dict.payments!; // resolveSource guarantees it
      const table = quoteTable(p.table, r.row.schemaAllowlist);
      const [created, status, reason] = [p.createdAtColumn, p.statusColumn, p.reasonColumn].map(quoteColumn);
      const res = await c.query<
        WindowRow & { attempts: number; failed: number; groups: { k: string; n: number }[] }
      >(
        `with ${WINDOW},
         o as (select x.${status}::text as s, x.${reason}::text as why from ${table} x, w where x.${created} >= w.f and x.${created} < w.t),
         g as (select ${mask("why")} as k, count(*)::int as n from o where s = any($5::text[]) group by 1),
         c as (${capped("g", "(other reasons)")})
         select w.f, w.t, w.partial,
           (select max(x.${created})::timestamptz from ${table} x) as latest,
           (select count(*)::int from o) as attempts,
           (select count(*)::int from o where s = any($5::text[])) as failed,
           (select coalesce(json_agg(json_build_object('k', k, 'n', n) order by n desc, k), '[]'::json) from c) as groups
         from w`,
        [win.day, r.dict.reportingTimezone, win.now, win.reference, p.failedStatuses],
      );
      const w = res.rows[0]!;
      return {
        status: "AVAILABLE",
        attempts: w.attempts,
        failed: w.failed,
        failureRate: w.attempts === 0 ? null : w.failed / w.attempts,
        byReason: w.groups.map((g) => ({ reason: g.k, count: g.n })),
        provenance: provenance(
          r,
          p.table,
          w,
          { [p.statusColumn]: p.failedStatuses },
          `failure rate = failed / attempts, where failed = ${p.statusColumn} in (${p.failedStatuses.join(", ")}) and ${p.createdAtColumn} in [from, to); reasons masked`,
        ),
      };
    },
  );
}

/**
 * Gross sales, refunds and net for one local day (FR-BIZ-04). Gross counts paid orders by order time; refunds count by
 * refund time, whatever day the order was placed; net = gross − refunds, all in SQL numeric.
 */
export async function getRevenueSummary(
  scope: ToolScope,
  query: MetricQuery,
): Promise<RevenueSummaryResponse> {
  return runTool(scope, query, "revenue", "refunds", async (c, r, win): Promise<RevenueSummary> => {
    const o = r.dict.orders;
    const rf = r.dict.refunds!; // resolveSource guarantees it
    const orders = quoteTable(o.table, r.row.schemaAllowlist);
    const refunds = quoteTable(rf.table, r.row.schemaAllowlist);
    const [created, status, amount] = [o.createdAtColumn, o.statusColumn, o.amountColumn].map(quoteColumn);
    const [rCreated, rAmount] = [rf.createdAtColumn, rf.amountColumn].map(quoteColumn);
    const digits = minorDigits(r.dict.currency);
    const res = await c.query<
      WindowRow & { rlatest: Date | null; gross: string; refunds: string; net: string }
    >(
      `with ${WINDOW},
       o as (select x.${amount} as a from ${orders} x, w
             where x.${created} >= w.f and x.${created} < w.t and x.${status}::text = any($5::text[])),
       r as (select x.${rAmount} as a from ${refunds} x, w where x.${rCreated} >= w.f and x.${rCreated} < w.t),
       g as (select ${majorSum(o.amountUnit, digits)} as v from o),
       rv as (select ${majorSum(rf.amountUnit, digits)} as v from r)
       select w.f, w.t, w.partial,
         (select max(x.${created})::timestamptz from ${orders} x) as latest,
         (select max(x.${rCreated})::timestamptz from ${refunds} x) as rlatest,
         g.v::text as gross, rv.v::text as refunds, (g.v - rv.v)::text as net
       from w, g, rv`,
      [win.day, r.dict.reportingTimezone, win.now, win.reference, o.paidStatuses],
    );
    const w = res.rows[0]!;
    const cur = r.dict.currency;
    const grossFormula = `gross sales = ${sumText(o.amountColumn, o.amountUnit, digits)} in ${cur}, where ${o.statusColumn} in (${o.paidStatuses.join(", ")}) and ${o.createdAtColumn} in [from, to) (by order time)`;
    const refundsFormula = `refunds = ${sumText(rf.amountColumn, rf.amountUnit, digits)} in ${cur}, where ${rf.createdAtColumn} in [from, to) (by refund time, whatever the order day)`;
    return {
      status: "AVAILABLE",
      grossSales: w.gross,
      refunds: w.refunds,
      netSales: w.net,
      currency: cur,
      formula: `net sales = gross sales − refunds; ${grossFormula}; ${refundsFormula}`,
      provenance: provenance(r, o.table, w, { [o.statusColumn]: o.paidStatuses }, grossFormula),
      refundsProvenance: provenance(r, rf.table, { ...w, latest: w.rlatest }, {}, refundsFormula),
    };
  });
}

/** The TOP_PRODUCTS_LIMIT products of paid orders by revenue for one local day; names masked in SQL (FR-BIZ-05). */
export async function getTopProducts(scope: ToolScope, query: MetricQuery): Promise<TopProductsResponse> {
  return runTool(scope, query, "top_products", "orderItems", async (c, r, win): Promise<TopProducts> => {
    const o = r.dict.orders;
    const it = r.dict.orderItems!; // resolveSource guarantees it and orders.idColumn
    const orders = quoteTable(o.table, r.row.schemaAllowlist);
    const items = quoteTable(it.table, r.row.schemaAllowlist);
    const [created, status, id] = [o.createdAtColumn, o.statusColumn, o.idColumn!].map(quoteColumn);
    const [orderId, product, quantity, amount] = [
      it.orderIdColumn,
      it.productColumn,
      it.quantityColumn,
      it.amountColumn,
    ].map(quoteColumn);
    const digits = minorDigits(r.dict.currency);
    // shortcut: return lines (negative quantities) make top products NOT_DEFINED instead of netting them; add a returns
    // filter to the dictionary when a source needs one.
    const res = await c.query<WindowRow & { top: { k: string; q: number; v: string }[] }>(
      `with ${WINDOW},
       o as (select x.${id} as id from ${orders} x, w
             where x.${created} >= w.f and x.${created} < w.t and x.${status}::text = any($5::text[])),
       i as (select ${mask(`y.${product}::text`)} as k, y.${quantity} as q, y.${amount} as a
             from ${items} y join o on y.${orderId} = o.id),
       g as (select k, coalesce(sum(q), 0)::bigint as q, ${majorSum(it.amountUnit, digits)} as v from i group by k)
       select w.f, w.t, w.partial,
         (select max(x.${created})::timestamptz from ${orders} x) as latest,
         (select coalesce(json_agg(json_build_object('k', k, 'q', q, 'v', v::text) order by v desc, k), '[]'::json)
            from (select * from g order by v desc, k limit ${TOP_PRODUCTS_LIMIT}) t) as top
       from w`,
      [win.day, r.dict.reportingTimezone, win.now, win.reference, o.paidStatuses],
    );
    const w = res.rows[0]!;
    if (w.top.some((g) => g.q < 0))
      throw new NotDefined(`${r.row.name}'s order items include returns (negative quantities)`);
    return {
      status: "AVAILABLE",
      currency: r.dict.currency,
      items: w.top.map((g) => ({ product: g.k, quantity: g.q, revenue: g.v })),
      provenance: provenance(
        r,
        it.table,
        w,
        { [o.statusColumn]: o.paidStatuses },
        `top ${TOP_PRODUCTS_LIMIT} products by revenue = ${sumText(it.amountColumn, it.amountUnit, digits)} in ${r.dict.currency}, quantity = sum(${it.quantityColumn}), over ${it.table} joined on ${it.orderIdColumn} = ${o.table}.${o.idColumn} where ${o.statusColumn} in (${o.paidStatuses.join(", ")}) and ${o.createdAtColumn} in [from, to); product names masked`,
      ),
    };
  });
}

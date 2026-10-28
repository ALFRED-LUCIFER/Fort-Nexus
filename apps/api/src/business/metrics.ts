import type pg from "pg";
import type {
  MetricDictionary,
  MetricProvenance,
  MetricQuery,
  PaymentFailures,
  PaymentFailuresResponse,
  SalesSummary,
  SalesSummaryResponse,
  Unavailable,
} from "@nexus/contracts";
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
// source database, so raw values never reach NEXUS. Reason text is capped at 120 chars.
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

const unavailable = (reason: Unavailable["reason"], message: string): Unavailable => ({
  status: "UNAVAILABLE",
  reason,
  message,
});

type Ready = { row: BusinessConnectorRow; dict: MetricDictionary; connectionString: string };

/** Everything that must hold before a tool may touch the source; otherwise the reason it is unavailable. */
async function resolveSource(
  s: ToolScope,
  connectorId: string,
  needs: "orders" | "payments",
): Promise<Ready | Unavailable> {
  const row = await findConnector(s, connectorId);
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
  tool: "sales_summary" | "payment_failures",
  needs: "orders" | "payments",
  run: (c: pg.Client, r: Ready, win: Win) => Promise<R>,
): Promise<{ current: R | Unavailable; previous: R | Unavailable | null }> {
  const started = performance.now();
  const now = s.now ?? new Date();
  const ready = await resolveSource(s, query.connectorId, needs);
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
        : err instanceof IdentifierError
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
      workspaceId: s.workspaceId,
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
    // Exact decimal in SQL numeric, returned as text (never a JS float).
    const gross =
      o.amountUnit === "MINOR"
        ? `round(coalesce(sum(a), 0)::numeric / power(10::numeric, ${digits}), ${digits})::text`
        : `coalesce(sum(a), 0)::numeric::text`;
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
    const unit =
      o.amountUnit === "MINOR" ? `sum(${o.amountColumn})/${10 ** digits}` : `sum(${o.amountColumn})`;
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

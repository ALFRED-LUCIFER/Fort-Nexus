import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOP_PRODUCTS_LIMIT } from "@nexus/contracts";
import type {
  ConnectionTestResult,
  Connector,
  CreateConnectorRequest,
  MetricDictionary,
  MetricQuery,
  PaymentFailuresResponse,
  Project,
  RevenueSummaryResponse,
  SalesSummaryResponse,
  TopProductsResponse,
  WorkspaceList,
} from "@nexus/contracts";
import { listConnectors, testConnector } from "../src/business/connectors.ts";
import { businessConnectors } from "../src/business/schema.ts";
import { readOnly } from "../src/business/gateway.ts";
import {
  getPaymentFailures,
  getRevenueSummary,
  getSalesSummary,
  getTopProducts,
  type ToolScope,
} from "../src/business/metrics.ts";
import { answer } from "../src/conversations/tools.ts";
import { createDb } from "../src/db/index.ts";
import { auditRecords } from "../src/db/schema.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// A second Postgres plays the business source: a read-only role, a write-capable role and orders/payments seeded across
// the Asia/Dubai (UTC+4) day boundary. "Now" is 14:30 in Dubai on 28 Oct 2026.
const NOW = new Date("2026-10-28T10:30:00Z");
const RO_PASSWORD = randomBytes(16).toString("hex");
const RW_PASSWORD = randomBytes(16).toString("hex");

const SEED = `
create schema shop;
create schema private;
create table shop.orders (id serial primary key, created_at timestamptz not null, status text not null,
  amount_cents bigint not null, customer_email text, address text);
create table shop.payments (id serial primary key, created_at timestamptz not null, status text not null, failure_reason text);
create table shop.refunds (id serial primary key, order_id int, created_at timestamptz not null, amount numeric(12, 2) not null);
create table shop.order_items (id serial primary key, order_id int not null, product text, quantity int not null,
  amount_cents bigint not null);
create table private.customers (id serial primary key, email text);
create view shop.slow_orders as select o.* from shop.orders o cross join lateral (select pg_sleep(0.3)) s;

insert into shop.orders (created_at, status, amount_cents, customer_email, address) values
  ('2026-10-26T19:00:00Z', 'paid', 999, null, null),                       -- Dubai 26 Oct 23:00
  ('2026-10-27T05:00:00Z', 'paid', 2000, null, null),                      -- Dubai 27 Oct 09:00
  ('2026-10-27T12:00:00Z', 'paid', 3000, null, null),                      -- Dubai 27 Oct 16:00 (after the clock cut)
  ('2026-10-27T19:59:59Z', 'paid', 1000, null, null),                      -- Dubai 27 Oct 23:59:59
  ('2026-10-27T20:00:00Z', 'paid', 12345, 'jane@example.com', '1 Main St'), -- Dubai 28 Oct 00:00 (UTC: still the 27th)
  ('2026-10-28T09:00:00Z', 'paid', 199, null, null),                       -- Dubai 28 Oct 13:00
  ('2026-10-28T09:30:00Z', 'pending', 500, null, null),                    -- Dubai 28 Oct 13:30
  ('2026-10-28T11:00:00Z', 'paid', 7777, null, null);                      -- Dubai 28 Oct 15:00, after "now"

insert into shop.payments (created_at, status, failure_reason) values
  ('2026-10-27T21:00:00Z', 'failed', '3DS timeout'),
  ('2026-10-28T01:00:00Z', 'failed', 'Card declined for jane@example.com'),
  ('2026-10-28T02:00:00Z', 'failed', 'Card declined for bob@example.org'),
  ('2026-10-28T03:00:00Z', 'failed', 'Insufficient funds, card 4242 4242 4242 4242'),
  ('2026-10-28T04:00:00Z', 'succeeded', null);
insert into shop.payments (created_at, status, failure_reason)
  select '2026-10-20T08:00:00Z', 'failed', 'code E' || lpad(i::text, 2, '0') from generate_series(1, 25) i;

-- Refunds count on the refund's own Dubai day (major units), whatever day the order was placed.
insert into shop.refunds (order_id, created_at, amount) values
  (1, '2026-10-27T06:00:00Z', 5.50),   -- Dubai 27 Oct 10:00
  (2, '2026-10-27T19:30:00Z', 0.10),   -- Dubai 27 Oct 23:30
  (2, '2026-10-27T20:30:00Z', 12.34),  -- Dubai 28 Oct 00:30 (UTC: still the 27th); the order was placed on the 27th
  (5, '2026-10-28T08:00:00Z', 0.01),   -- Dubai 28 Oct 12:00
  (5, '2026-10-28T11:00:00Z', 99.00);  -- Dubai 28 Oct 15:00, after "now"

-- Order ids follow the insert order above: 5 and 6 are today's paid orders, 7 is pending, 8 is after "now".
insert into shop.order_items (order_id, product, quantity, amount_cents) values
  (5, 'Gift card for jane@example.com', 1, 10000),
  (5, 'Widget', 3, 2345),
  (6, 'Widget', 1, 199),
  (7, 'Pending thing', 10, 500),
  (8, 'Later thing', 1, 7777);
insert into shop.order_items (order_id, product, quantity, amount_cents)
  select 2, 'P' || lpad(i::text, 2, '0'), i, i * 100 from generate_series(1, 12) i;

create role nexus_ro login password '${RO_PASSWORD}';
grant usage on schema shop to nexus_ro;
grant select on all tables in schema shop to nexus_ro;
create role nexus_rw login password '${RW_PASSWORD}';
grant usage on schema shop to nexus_rw;
grant select, insert, update on all tables in schema shop to nexus_rw;
`;

const DICTIONARY: MetricDictionary = {
  reportingTimezone: "Asia/Dubai",
  currency: "AED",
  orders: {
    table: "shop.orders",
    createdAtColumn: "created_at",
    statusColumn: "status",
    amountColumn: "amount_cents",
    amountUnit: "MINOR",
    paidStatuses: ["paid"],
    idColumn: "id",
  },
  payments: {
    table: "shop.payments",
    createdAtColumn: "created_at",
    statusColumn: "status",
    reasonColumn: "failure_reason",
    failedStatuses: ["failed"],
  },
  refunds: {
    table: "shop.refunds",
    createdAtColumn: "created_at",
    amountColumn: "amount",
    amountUnit: "MAJOR",
  },
  orderItems: {
    table: "shop.order_items",
    orderIdColumn: "order_id",
    productColumn: "product",
    quantityColumn: "quantity",
    amountColumn: "amount_cents",
    amountUnit: "MINOR",
  },
};

let source: StartedPostgreSqlContainer;
let t: TestApp;
let cookie: string;
let dir: string;
let roUrl: string;
let rwUrl: string;
let appDb: ReturnType<typeof createDb>;
let ownerId: string;
let bizWorkspaceId: string;
/** The Business project every connector here lives in, unless a test says otherwise. */
let shop: Project;

const roleUrl = (user: string, password: string) => {
  const u = new URL(source.getConnectionUri());
  u.username = user;
  u.password = password;
  return u.toString();
};
const writeCredential = (ref: string, content: string, mode = 0o600) => {
  const file = join(dir, `${ref}.json`);
  writeFileSync(file, content, { mode });
  chmodSync(file, mode); // umask can't loosen what the test sets
};

beforeAll(async () => {
  source = await new PostgreSqlContainer("postgres:18-alpine").start();
  const admin = new pg.Client({ connectionString: source.getConnectionUri() });
  await admin.connect();
  await admin.query(SEED);
  await admin.end();
  roUrl = roleUrl("nexus_ro", RO_PASSWORD);
  rwUrl = roleUrl("nexus_rw", RW_PASSWORD);

  dir = mkdtempSync(join(tmpdir(), "nexus-connectors-"));
  writeCredential("shop-ro", JSON.stringify({ connectionString: roUrl }));
  writeCredential("shop-rw", JSON.stringify({ connectionString: rwUrl }));
  writeCredential("shop-badpw", JSON.stringify({ connectionString: roleUrl("nexus_ro", "wrong-password") }));
  writeCredential("shop-loose", JSON.stringify({ connectionString: roUrl }), 0o644);
  writeCredential("shop-broken", `{"connectionString": "${roUrl}"`); // truncated JSON

  t = await createTestApp({ NEXUS_CONNECTORS_DIR: dir });
  cookie = await ownerSession(t);
  appDb = createDb(t.databaseUrl);
  ownerId = (await call("GET", "/v1/me")).json<{ id: string }>().id;
  const ws = (await call("GET", "/v1/workspaces")).json<WorkspaceList>();
  bizWorkspaceId = ws.items.find((w) => w.mode === "BUSINESS")!.id;
  shop = await businessProject("shop");
});

afterAll(async () => {
  await appDb?.pool.end();
  await t?.app.close();
  await source?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    payload: payload as object,
    headers: { cookie, origin: t.config.publicOrigin },
  });

async function businessProject(slug: string) {
  const res = await call("POST", `/v1/workspaces/${bizWorkspaceId}/projects`, { name: slug, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Project>();
}

/** Secrets must never show up in a response body, a stored row or an audit record. */
const expectNoSecrets = (text: string) => {
  expect(text).not.toContain(RO_PASSWORD);
  expect(text).not.toContain(RW_PASSWORD);
  expect(text).not.toContain("wrong-password");
  expect(text).not.toMatch(/postgres(ql)?:\/\//);
};

async function connector(
  over: Partial<CreateConnectorRequest> = {},
  dictionary: MetricDictionary | null = DICTIONARY,
) {
  const res = await call("POST", "/v1/business/connectors", {
    projectId: shop.id,
    name: `shop ${randomBytes(3).toString("hex")}`,
    provider: "POSTGRES",
    environment: "DEV",
    credentialRef: "shop-ro",
    schemaAllowlist: ["shop"],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json<Connector>();
  if (dictionary) {
    const put = await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, dictionary);
    expect(put.statusCode, put.body).toBe(200);
  }
  return c;
}

const runTest = async (id: string) => {
  const res = await call("POST", `/v1/business/connectors/${id}/test`);
  expect(res.statusCode, res.body).toBe(200);
  expectNoSecrets(res.body);
  return res.json<ConnectionTestResult>();
};

const sales = async (q: Record<string, string>) => {
  const res = await call("GET", `/v1/business/metrics/sales-summary?${new URLSearchParams(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  expectNoSecrets(res.body);
  return res.json<SalesSummaryResponse>();
};
const revenue = async (q: Record<string, string>) => {
  const res = await call("GET", `/v1/business/metrics/revenue?${new URLSearchParams(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  expectNoSecrets(res.body);
  return res.json<RevenueSummaryResponse>();
};
const topProducts = async (q: Record<string, string>) => {
  const res = await call("GET", `/v1/business/metrics/top-products?${new URLSearchParams(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  expectNoSecrets(res.body);
  return res.json<TopProductsResponse>();
};
const payments = async (q: Record<string, string>) => {
  const res = await call("GET", `/v1/business/metrics/payment-failures?${new URLSearchParams(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  expectNoSecrets(res.body);
  return res.json<PaymentFailuresResponse>();
};

/** The exported tools at a fixed "now", as the conversations module calls them. */
const toolScope = (over: Partial<ToolScope> = {}): ToolScope => ({
  db: appDb.db,
  connectorsDir: dir,
  actor: "user:test",
  correlationId: randomUUID(),
  ownerId,
  projectId: shop.id,
  now: NOW,
  ...over,
});
const query = (connectorId: string, over: Partial<MetricQuery> = {}): MetricQuery => ({
  connectorId,
  day: "today",
  compare: false,
  ...over,
});

const auditFor = (resourceId: string, action: string) =>
  appDb.db
    .select()
    .from(auditRecords)
    .where(and(eq(auditRecords.resourceId, resourceId), eq(auditRecords.action, action)));

describe("business connector registry", () => {
  it("requires the owner session and a trusted origin", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/business/connectors" })).statusCode).toBe(401);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/business/connectors",
      headers: { cookie },
      payload: {
        name: "x",
        provider: "POSTGRES",
        environment: "DEV",
        credentialRef: "x",
        schemaAllowlist: ["x"],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("registers a connector by credential reference; the secret is never stored, logged in audit or returned", async () => {
    const c = await connector({ environment: "STAGING" }, null);
    expect(c).toMatchObject({ status: "UNTESTED", hasDictionary: false, statementTimeoutMs: 5000 });
    expect(c.projectId).toBe(shop.id);
    const list = await call("GET", `/v1/business/connectors?projectId=${shop.id}`);
    expect(list.json<{ items: Connector[] }>().items.map((i) => i.id)).toContain(c.id);
    expect(await runTest(c.id)).toMatchObject({ ok: true });
    const [row] = await appDb.db.select().from(businessConnectors).where(eq(businessConnectors.id, c.id));
    expect(row).toMatchObject({ workspaceId: bizWorkspaceId, projectId: shop.id });
    expectNoSecrets(JSON.stringify(row));
    const records = await appDb.db.select().from(auditRecords).where(eq(auditRecords.resourceId, c.id));
    expect(records.map((r) => r.action).sort()).toEqual(["connector.create", "connector.test"]);
    expectNoSecrets(JSON.stringify(records));
    for (const r of records)
      expect(r.metadata).toMatchObject({ workspaceId: bizWorkspaceId, projectId: shop.id });
  });

  it("credential files must be private, valid and are never echoed", async () => {
    for (const [ref, why] of [
      ["shop-loose", "must not be readable by group or others"],
      ["shop-broken", "is not valid JSON"],
      ["shop-missing", "does not exist"],
    ] as const) {
      const c = await connector({ credentialRef: ref }, null);
      const result = await runTest(c.id);
      expect(result.ok).toBe(false);
      expect(result.checks).toEqual([
        { name: "credential", ok: false, detail: expect.stringContaining(join(dir, `${ref}.json`)) },
      ]);
      expect(result.checks[0]!.detail).toContain(why);
    }
  });

  it("reports a rejected password as an auth failure without the key", async () => {
    const c = await connector({ credentialRef: "shop-badpw" }, null);
    const result = await runTest(c.id);
    expect(result.checks.at(-1)).toMatchObject({ name: "auth", ok: false });
    expect(result.checks.at(-1)!.detail).toMatch(/28P01/);
  });

  it("a write-capable role fails its read_only check, and its tools stay unavailable", async () => {
    const c = await connector({ credentialRef: "shop-rw" });
    const result = await runTest(c.id);
    expect(result.ok).toBe(false);
    const ro = result.checks.find((x) => x.name === "read_only")!;
    expect(ro.ok).toBe(false);
    expect(ro.detail).toContain("shop.orders");
    const listed = (await call("GET", "/v1/business/connectors")).json<{ items: Connector[] }>();
    expect(listed.items.find((i) => i.id === c.id)).toMatchObject({ status: "FAILED", lastError: ro.detail });
    for (const r of [
      await sales({ connectorId: c.id, day: "2026-10-27" }),
      await revenue({ connectorId: c.id, day: "2026-10-27" }),
      await topProducts({ connectorId: c.id, day: "2026-10-27" }),
    ])
      expect(r.current).toMatchObject({ status: "UNAVAILABLE", reason: "CONNECTOR_FAILED" });
  });

  it("FR-BIZ-04/05 dictionary: refunds and order items stay inside the allowlist, items need orders.idColumn, columns are tested", async () => {
    const c = await connector({}, null);
    const put = (d: unknown) => call("PUT", `/v1/business/connectors/${c.id}/dictionary`, d);
    const outside = await put({
      ...DICTIONARY,
      refunds: { ...DICTIONARY.refunds, table: "private.customers" },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({
      error: { message: expect.stringContaining("private.customers") },
    });
    expect(
      (await put({ ...DICTIONARY, orderItems: { ...DICTIONARY.orderItems, table: "private.customers" } }))
        .statusCode,
    ).toBe(400);
    const noId = await put({ ...DICTIONARY, orders: { ...DICTIONARY.orders, idColumn: undefined } });
    expect(noId.statusCode).toBe(400);
    expect(noId.body).toContain("orders.idColumn is required");
    expect(
      (await put({ ...DICTIONARY, orderItems: { ...DICTIONARY.orderItems, productColumn: "name; --" } }))
        .statusCode,
    ).toBe(400);

    // The service directly: the HTTP test route is rate-limited to 10 a minute and other tests here use it.
    const test = () => testConnector(toolScope(), c.id);
    const typos = {
      ...DICTIONARY,
      orders: { ...DICTIONARY.orders, idColumn: "order_no" },
      refunds: { ...DICTIONARY.refunds!, amountColumn: "total" },
      orderItems: { ...DICTIONARY.orderItems!, quantityColumn: "qty" },
    };
    expect((await put(typos)).statusCode).toBe(200);
    const failed = (await test()).checks.at(-1)!;
    expect(failed).toMatchObject({ name: "dictionary", ok: false });
    for (const col of ["shop.orders.order_no", "shop.refunds.total", "shop.order_items.qty"])
      expect(failed.detail).toContain(col);
    expect((await put(DICTIONARY)).statusCode).toBe(200);
    expect(await test()).toMatchObject({ ok: true });
    const [record] = await auditFor(c.id, "connector.dictionary.put").then((r) => r.slice(-1));
    expect(record!.metadata).toMatchObject({
      tables: ["shop.orders", "shop.payments", "shop.refunds", "shop.order_items"],
      refunds: true,
      orderItems: true,
    });
  });

  it("rejects dictionary identifiers outside the schema allowlist, and checks dictionary columns exist", async () => {
    const c = await connector({}, null);
    const outside = await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, {
      ...DICTIONARY,
      orders: { ...DICTIONARY.orders, table: "private.customers" },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({
      error: { message: expect.stringContaining("private.customers") },
    });
    const injected = await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, {
      ...DICTIONARY,
      orders: { ...DICTIONARY.orders, statusColumn: 'status"; drop table shop.orders; --' },
    });
    expect(injected.statusCode).toBe(400);

    const typo = await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, {
      ...DICTIONARY,
      orders: { ...DICTIONARY.orders, amountColumn: "amount" },
    });
    expect(typo.statusCode).toBe(200);
    const result = await runTest(c.id);
    expect(result.checks.at(-1)).toMatchObject({
      name: "dictionary",
      ok: false,
      detail: expect.stringContaining("shop.orders.amount"),
    });

    // An allowlist narrowed after the dictionary was saved: the tool refuses the now-outside table.
    const d = await connector();
    await call("PATCH", `/v1/business/connectors/${d.id}`, { schemaAllowlist: ["private"] });
    expect((await sales({ connectorId: d.id, day: "2026-10-27" })).current).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NOT_DEFINED",
      message: expect.stringContaining("outside the connector's schema allowlist"),
    });
  });
});

describe("read-only metric tools", () => {
  it("DATA-G01: a production connector serves read-only tools only after its test passes, with source and freshness", async () => {
    const c = await connector({ environment: "PROD", provider: "SUPABASE" });
    expect((await sales({ connectorId: c.id, day: "2026-10-27" })).current).toMatchObject({
      status: "UNAVAILABLE",
      reason: "CONNECTOR_FAILED",
      message: expect.stringContaining("must pass a connection test"),
    });

    const result = await runTest(c.id);
    expect(result.checks.map((x) => [x.name, x.ok])).toEqual([
      ["credential", true],
      ["network", true],
      ["auth", true],
      ["read_only", true],
      ["schema_allowlist", true],
      ["dictionary", true],
    ]);

    const res = await sales({ connectorId: c.id, day: "2026-10-27" });
    expect(res.current).toMatchObject({
      status: "AVAILABLE",
      paidOrders: 3,
      grossSales: "60.00",
      provenance: {
        connectorId: c.id,
        connectorName: c.name,
        environment: "PROD",
        dataset: "shop.orders",
        latestRecordAt: "2026-10-28T11:00:00.000Z",
        partial: false,
      },
    });
    const [record] = await auditFor(c.id, "business.sales_summary").then((r) => r.slice(-1));
    expect(record).toMatchObject({ outcome: "SUCCEEDED", correlationId: expect.any(String) });
    expect(record!.metadata).toMatchObject({
      tool: "sales_summary",
      environment: "PROD",
      status: "AVAILABLE",
    });
    expect(record!.metadata).toHaveProperty("durationMs");
  });

  it("DATA-G04: writes can't run through the gateway, even with a write-capable credential", async () => {
    await expect(
      readOnly(rwUrl, { timeoutMs: 2_000, schemas: ["shop"] }, (c) =>
        c.query("insert into shop.orders (created_at, status, amount_cents) values (now(), 'paid', 1)"),
      ),
    ).rejects.toMatchObject({ code: "25006" }); // read_only_sql_transaction
    const admin = new pg.Client({ connectionString: source.getConnectionUri() });
    await admin.connect();
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from shop.orders");
    await admin.end();
    expect(rows[0]!.n).toBe(8);
  });

  it("BIZ-G01: today vs yesterday in Asia/Dubai: today is partial, both windows carry start/end and the same filters", async () => {
    const c = await connector();
    const res = await getSalesSummary(toolScope(), query(c.id, { compare: true }));
    expect(res.current).toMatchObject({
      status: "AVAILABLE",
      paidOrders: 2, // 00:00 (UTC: the 27th) and 13:00; 15:00 is after now, the pending order is excluded
      grossSales: "125.44",
      currency: "AED",
      byStatus: [
        { status: "paid", count: 2 },
        { status: "pending", count: 1 },
      ],
      excludedStatuses: ["pending"],
      provenance: {
        timezone: "Asia/Dubai",
        from: "2026-10-27T20:00:00.000Z",
        to: "2026-10-28T10:30:00.000Z",
        partial: true,
        filters: { status: ["paid"] },
      },
    });
    // Same local clock window yesterday: 00:00–14:30 Dubai, so 16:00 and 23:59 are not compared.
    expect(res.previous).toMatchObject({
      status: "AVAILABLE",
      paidOrders: 1,
      grossSales: "20.00",
      provenance: {
        from: "2026-10-26T20:00:00.000Z",
        to: "2026-10-27T10:30:00.000Z",
        partial: false,
        filters: { status: ["paid"] },
      },
    });
  });

  it("complete days run [local 00:00, next local 00:00) in the reporting time zone", async () => {
    const c = await connector();
    const res = await getSalesSummary(toolScope(), query(c.id, { day: "yesterday" }));
    expect(res.previous).toBeNull();
    expect(res.current).toMatchObject({
      paidOrders: 3,
      grossSales: "60.00",
      provenance: { from: "2026-10-26T20:00:00.000Z", to: "2026-10-27T20:00:00.000Z", partial: false },
    });
    const future = await call("GET", `/v1/business/metrics/sales-summary?connectorId=${c.id}&day=2999-01-01`);
    expect(future.statusCode).toBe(400);
  });

  it("DATA-G03: payment failures come back as masked aggregates; no customer detail leaves the gateway", async () => {
    const c = await connector();
    const scope = toolScope();
    const res = await getPaymentFailures(scope, query(c.id));
    expect(res.current).toMatchObject({
      status: "AVAILABLE",
      attempts: 5,
      failed: 4,
      failureRate: 0.8,
      byReason: [
        { reason: "Card declined for [email]", count: 2 },
        { reason: "3DS timeout", count: 1 },
        { reason: "Insufficient funds, card [number]", count: 1 },
      ],
    });
    const sales = await getSalesSummary(scope, query(c.id));
    const [record] = await auditFor(c.id, "business.payment_failures");
    for (const text of [JSON.stringify(res), JSON.stringify(sales), JSON.stringify(record)]) {
      expect(text).not.toMatch(/@example\.(com|org)|4242|1 Main St|jane|bob/);
    }
    expect(record).toMatchObject({ correlationId: scope.correlationId });
  });

  it("DATA-G03: failure reasons are capped at 20 groups and still add up", async () => {
    const c = await connector();
    const res = await getPaymentFailures(toolScope(), query(c.id, { day: "2026-10-20" }));
    if (res.current.status !== "AVAILABLE") throw new Error(res.current.message);
    expect(res.current.byReason).toHaveLength(20);
    expect(res.current.byReason).toContainEqual({ reason: "(other reasons)", count: 6 });
    expect(res.current.byReason.reduce((n, r) => n + r.count, 0)).toBe(25);
  });

  it("DATA-G02: missing, disabled, failing or undefined sources are unavailable, never zero", async () => {
    const none = await payments({ connectorId: randomUUID(), compare: "true" });
    expect(none).toEqual({
      current: { status: "UNAVAILABLE", reason: "NO_CONNECTOR", message: expect.any(String) },
      previous: { status: "UNAVAILABLE", reason: "NO_CONNECTOR", message: expect.any(String) },
    });

    const disabled = await connector();
    expect(
      (await call("PATCH", `/v1/business/connectors/${disabled.id}`, { disabled: true })).json(),
    ).toMatchObject({
      status: "DISABLED",
    });
    expect((await payments({ connectorId: disabled.id })).current).toMatchObject({
      reason: "CONNECTOR_DISABLED",
    });

    const noPayments = await connector({}, { ...DICTIONARY, payments: undefined });
    expect((await payments({ connectorId: noPayments.id })).current).toMatchObject({ reason: "NOT_DEFINED" });

    const noDictionary = await connector({}, null);
    expect((await sales({ connectorId: noDictionary.id })).current).toMatchObject({ reason: "NOT_DEFINED" });

    const gone = await connector({ credentialRef: "shop-gone" });
    const g = (await payments({ connectorId: gone.id })).current;
    expect(g).toMatchObject({
      reason: "CONNECTOR_FAILED",
      message: expect.stringContaining("shop-gone.json"),
    });

    const [record] = await auditFor(disabled.id, "business.payment_failures");
    expect(record).toMatchObject({ outcome: "FAILED", metadata: { reason: "CONNECTOR_DISABLED" } });
  });

  it("a source slower than the statement timeout is TIMEOUT, not a number", async () => {
    const c = await connector(
      { statementTimeoutMs: 500 },
      { ...DICTIONARY, orders: { ...DICTIONARY.orders, table: "shop.slow_orders" } },
    );
    const res = await sales({ connectorId: c.id, day: "2026-10-27", compare: "true" });
    expect(res.current).toMatchObject({ status: "UNAVAILABLE", reason: "TIMEOUT" });
    expect(res.previous).toMatchObject({ status: "UNAVAILABLE", reason: "TIMEOUT" });
  });
});

describe("revenue and top products (FR-BIZ-04/05)", () => {
  it("FR-BIZ-04: refunds count on the refund's own Dubai day, net = gross − refunds exact to the cent, with both provenances", async () => {
    const c = await connector();
    const scope = toolScope();
    const res = await getRevenueSummary(scope, query(c.id, { compare: true }));
    // Today 00:00–14:30 Dubai: gross 123.45 + 1.99; refunds 12.34 (00:30, UTC still the 27th, for a 27 Oct order) + 0.01.
    expect(res.current).toEqual({
      status: "AVAILABLE",
      grossSales: "125.44",
      refunds: "12.35",
      netSales: "113.09", // a float would give 113.08999999999999
      currency: "AED",
      formula:
        "net sales = gross sales − refunds; gross sales = sum(amount_cents)/100 in AED, where status in (paid) and created_at in [from, to) (by order time); refunds = sum(amount) in AED, where created_at in [from, to) (by refund time, whatever the order day)",
      provenance: expect.objectContaining({
        dataset: "shop.orders",
        timezone: "Asia/Dubai",
        from: "2026-10-27T20:00:00.000Z",
        to: "2026-10-28T10:30:00.000Z",
        partial: true,
        filters: { status: ["paid"] },
        latestRecordAt: "2026-10-28T11:00:00.000Z",
      }),
      refundsProvenance: expect.objectContaining({
        connectorId: c.id,
        dataset: "shop.refunds",
        timezone: "Asia/Dubai",
        from: "2026-10-27T20:00:00.000Z",
        to: "2026-10-28T10:30:00.000Z",
        partial: true,
        filters: {},
        formula: expect.stringContaining("by refund time"),
        latestRecordAt: "2026-10-28T11:00:00.000Z",
      }),
    });
    // Yesterday's same clock window (00:00–14:30): the 10:00 refund only.
    expect(res.previous).toMatchObject({
      grossSales: "20.00",
      refunds: "5.50",
      netSales: "14.50",
      refundsProvenance: { from: "2026-10-26T20:00:00.000Z", to: "2026-10-27T10:30:00.000Z", partial: false },
    });
    // The full 27th keeps 23:30 and drops 00:30 on the 28th, though both are 27 Oct in UTC.
    expect((await revenue({ connectorId: c.id, day: "2026-10-27" })).current).toMatchObject({
      grossSales: "60.00",
      refunds: "5.60",
      netSales: "54.40",
    });
    // A day with no orders or refunds in a defined source is a read zero with provenance, not a missing value.
    expect((await revenue({ connectorId: c.id, day: "2026-10-20" })).current).toMatchObject({
      status: "AVAILABLE",
      grossSales: "0.00",
      refunds: "0",
      netSales: "0.00",
    });
    const [record] = await auditFor(c.id, "business.revenue");
    expect(record).toMatchObject({
      outcome: "SUCCEEDED",
      correlationId: scope.correlationId,
      metadata: { tool: "revenue", status: "AVAILABLE", projectId: shop.id },
    });
  });

  it("FR-BIZ-05: top products of paid orders in the window by revenue, masked in SQL and capped", async () => {
    const c = await connector();
    const res = await getTopProducts(toolScope(), query(c.id));
    expect(res.current).toMatchObject({
      status: "AVAILABLE",
      currency: "AED",
      // The pending order's and the after-now order's items are left out.
      items: [
        { product: "Gift card for [email]", quantity: 1, revenue: "100.00" },
        { product: "Widget", quantity: 4, revenue: "25.44" },
      ],
      provenance: {
        dataset: "shop.order_items",
        from: "2026-10-27T20:00:00.000Z",
        to: "2026-10-28T10:30:00.000Z",
        partial: true,
        filters: { status: ["paid"] },
        formula: expect.stringContaining("product names masked"),
      },
    });
    const text = JSON.stringify(res) + JSON.stringify(await auditFor(c.id, "business.top_products"));
    expect(text).not.toMatch(/jane|@example|Pending thing|Later thing/);

    const day = await topProducts({ connectorId: c.id, day: "2026-10-27" });
    if (day.current.status !== "AVAILABLE") throw new Error(day.current.message);
    expect(day.current.items).toHaveLength(TOP_PRODUCTS_LIMIT);
    expect(day.current.items[0]).toEqual({ product: "P12", quantity: 12, revenue: "12.00" });
    expect(day.current.items.at(-1)).toEqual({ product: "P03", quantity: 3, revenue: "3.00" });
  });

  it("DATA-G02: without a refunds or order-items section the tools are NOT_DEFINED, never 0 refunds", async () => {
    const noRefunds = await connector({}, { ...DICTIONARY, refunds: undefined });
    const r = await revenue({ connectorId: noRefunds.id, compare: "true" });
    expect(r).toEqual({
      current: { status: "UNAVAILABLE", reason: "NOT_DEFINED", message: expect.stringContaining("refunds") },
      previous: { status: "UNAVAILABLE", reason: "NOT_DEFINED", message: expect.stringContaining("refunds") },
    });
    const noItems = await connector({}, { ...DICTIONARY, orderItems: undefined });
    expect((await topProducts({ connectorId: noItems.id })).current).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NOT_DEFINED",
    });
    const [record] = await auditFor(noRefunds.id, "business.revenue");
    expect(record).toMatchObject({ outcome: "FAILED", metadata: { reason: "NOT_DEFINED" } });
  });
});

describe("project scope (decoy project B, NFR-CNV-05)", () => {
  const ids = async (q: string) =>
    (await call("GET", `/v1/business/connectors${q}`)).json<{ items: Connector[] }>().items.map((i) => i.id);
  const body = {
    name: "decoy",
    provider: "POSTGRES",
    environment: "DEV",
    credentialRef: "shop-ro",
    schemaAllowlist: ["shop"],
  };

  it("B's list never contains A's connectors; All lists both", async () => {
    const decoy = await businessProject(`decoy-${randomBytes(3).toString("hex")}`);
    const a = await connector();
    const b = await connector({ projectId: decoy.id });
    expect(await ids(`?projectId=${decoy.id}`)).toEqual([b.id]);
    expect(await ids(`?projectId=${shop.id}`)).toEqual(expect.arrayContaining([a.id]));
    expect(await ids(`?projectId=${shop.id}`)).not.toContain(b.id);
    expect(await ids("")).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await listConnectors(toolScope({ projectId: decoy.id }))).map((c) => c.id)).toEqual([b.id]);
  });

  it("a tool scoped to B, or to another owner, treats A's connector as missing", async () => {
    const decoy = await businessProject(`decoy-${randomBytes(3).toString("hex")}`);
    const a = await connector();
    for (const s of [toolScope({ projectId: decoy.id }), toolScope({ ownerId: "someone-else" })]) {
      expect((await getSalesSummary(s, query(a.id, { day: "2026-10-27" }))).current).toMatchObject({
        status: "UNAVAILABLE",
        reason: "NO_CONNECTOR",
      });
      expect((await getPaymentFailures(s, query(a.id))).current).toMatchObject({ reason: "NO_CONNECTOR" });
      expect((await getRevenueSummary(s, query(a.id))).current).toMatchObject({ reason: "NO_CONNECTOR" });
      expect((await getTopProducts(s, query(a.id))).current).toMatchObject({ reason: "NO_CONNECTOR" });
    }
    const stranger = { db: appDb.db, connectorsDir: dir, actor: "user:x", correlationId: randomUUID() };
    expect(await listConnectors({ ...stranger, ownerId: "someone-else" })).toEqual([]);
    expect(await listConnectors({ ...stranger, ownerId: "someone-else", projectId: shop.id })).toEqual([]);
  });

  it("connectors need a Business project: a Dev project is 403, an unknown one 404", async () => {
    const home = await homeProjectId(t, cookie);
    const before = await ids("");
    expect((await call("POST", "/v1/business/connectors", { ...body, projectId: home })).statusCode).toBe(
      403,
    );
    expect((await call("GET", `/v1/business/connectors?projectId=${home}`)).statusCode).toBe(403);
    const unknown = randomUUID();
    expect((await call("POST", "/v1/business/connectors", { ...body, projectId: unknown })).statusCode).toBe(
      404,
    );
    expect((await call("GET", `/v1/business/connectors?projectId=${unknown}`)).statusCode).toBe(404);
    expect(await ids("")).toEqual(before);
  });

  it("an archived project's connectors stay readable, but can't be created, changed or tested (409)", async () => {
    const p = await businessProject(`old-${randomBytes(3).toString("hex")}`);
    const c = await connector({ projectId: p.id });
    expect((await call("PATCH", `/v1/projects/${p.id}`, { archived: true })).statusCode).toBe(200);
    for (const res of [
      await call("POST", "/v1/business/connectors", { ...body, projectId: p.id }),
      await call("PATCH", `/v1/business/connectors/${c.id}`, { disabled: true }),
      await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, DICTIONARY),
      await call("POST", `/v1/business/connectors/${c.id}/test`),
    ])
      expect(res.statusCode, res.body).toBe(409);
    expect(await ids(`?projectId=${p.id}`)).toEqual([c.id]);
    expect((await call("GET", `/v1/business/connectors/${c.id}/dictionary`)).statusCode).toBe(200);
    expect((await sales({ connectorId: c.id, day: "2026-10-27" })).current).toMatchObject({
      status: "AVAILABLE",
      paidOrders: 3,
    });
    const [row] = await appDb.db.select().from(businessConnectors).where(eq(businessConnectors.id, c.id));
    expect(row).toMatchObject({ status: "UNTESTED", lastTestedAt: null });
  });
});

// Last in the file: it disables every other connector in the shop project.
describe("Talk answers business questions from the gateway (FR-BIZ-07)", () => {
  const ask = (compare = false, metric: "SALES_SUMMARY" | "REVENUE" | "TOP_PRODUCTS" = "SALES_SUMMARY") => {
    // A variable, not a literal: `projectId` is the thread's project once Talk is project-scoped (wave 2 S3).
    const ctx = {
      db: appDb.db,
      github: null,
      ownerId,
      projectId: shop.id,
      subjectJobId: null,
      connectorsDir: dir,
      correlationId: randomUUID(),
    };
    return answer({ kind: "BUSINESS_METRIC", metric, day: "2026-10-27", compare }, ctx);
  };

  it("quotes the gateway's figures with a METRIC source, and never picks between several sources", async () => {
    const c = await connector();
    expect(await ask()).toMatchObject({
      basis: "NONE",
      text: expect.stringMatching(/Several business sources/),
    });

    for (const other of await appDb.db
      .select()
      .from(businessConnectors)
      .where(eq(businessConnectors.projectId, shop.id)))
      if (other.id !== c.id)
        expect(
          (await call("PATCH", `/v1/business/connectors/${other.id}`, { disabled: true })).statusCode,
        ).toBe(200);

    const r = await ask();
    expect(r.basis).toBe("OBSERVED");
    expect(r.text).toMatch(/3 paid orders, gross sales \d+\.\d{2} AED/);
    expect(r.sources).toEqual([
      expect.objectContaining({ kind: "METRIC", label: expect.stringContaining("shop.orders") }),
    ]);
    expectNoSecrets(JSON.stringify(r));

    // FR-BIZ-04 in Talk: the gateway's figures, the formula, and a METRIC source for orders and for refunds.
    const rev = await ask(false, "REVENUE");
    expect(rev.basis).toBe("OBSERVED");
    expect(rev.text).toMatch(
      /^Revenue 2026-10-27, .*gross sales 60\.00 AED, refunds 5\.60 AED, net sales 54\.40 AED/,
    );
    expect(rev.text).toContain("Formula: net sales = gross sales − refunds;");
    expect(rev.sources.map((s) => [s.kind, s.label.split(" · ")[1]])).toEqual([
      ["METRIC", "shop.orders"],
      ["METRIC", "shop.refunds"],
    ]);

    // FR-BIZ-05 in Talk: masked names, quantities and the formula.
    const top = await ask(false, "TOP_PRODUCTS");
    expect(top.basis).toBe("OBSERVED");
    expect(top.text).toMatch(/^Top products 2026-10-27, .*P12 12\.00 AED \(12 sold\)/);
    expect(top.text).toContain("product names masked");
    expect(top.sources).toEqual([
      expect.objectContaining({ kind: "METRIC", label: expect.stringContaining("shop.order_items") }),
    ]);

    // Unavailable is said plainly, with no figure and no source.
    expect(
      (await call("PUT", `/v1/business/connectors/${c.id}/dictionary`, { ...DICTIONARY, refunds: undefined }))
        .statusCode,
    ).toBe(200);
    const none = await ask(true, "REVENUE");
    expect(none).toMatchObject({ basis: "NONE", sources: [] });
    expect(none.text).toMatch(/^Revenue 2026-10-27: unavailable \(.*doesn't define refunds\)\./);
    expect(none.text).not.toMatch(/\d+\.\d{2}/);
  });
});

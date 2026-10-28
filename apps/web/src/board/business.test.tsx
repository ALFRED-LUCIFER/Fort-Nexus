import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Connector,
  MetricProvenance,
  PaymentFailuresResponse,
  RevenueSummaryResponse,
  SalesSummaryResponse,
  TopProductsResponse,
} from "@nexus/contracts";
import { BIZ_PROJECT_ID, IN_PROJECT, ME, json, mockFetch, renderApp } from "../test/helpers.tsx";

const CID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date().toISOString();
const IN_SHOP = `/?ws=business&project=${BIZ_PROJECT_ID}`;

const connector = (over: Partial<Connector> = {}): Connector => ({
  id: CID,
  projectId: BIZ_PROJECT_ID,
  name: "Acme shop",
  provider: "SUPABASE",
  environment: "PROD",
  credentialRef: "shop-prod",
  schemaAllowlist: ["shop"],
  statementTimeoutMs: 5000,
  status: "CONNECTED",
  lastTestedAt: NOW,
  lastError: null,
  hasDictionary: true,
  createdAt: NOW,
  ...over,
});

const prov = (over: Partial<MetricProvenance> = {}): MetricProvenance => ({
  connectorId: CID,
  connectorName: "Acme shop",
  environment: "PROD",
  dataset: "shop.orders",
  timezone: "Asia/Dubai",
  from: "2026-10-27T20:00:00.000Z",
  to: "2026-10-28T10:30:00.000Z",
  filters: { status: ["paid"] },
  formula: "paid orders = count(*), gross sales = sum(amount_cents)/100 in AED",
  queriedAt: NOW,
  latestRecordAt: NOW,
  partial: true,
  ...over,
});

const SALES: SalesSummaryResponse = {
  current: {
    status: "AVAILABLE",
    paidOrders: 2,
    grossSales: "125.44",
    currency: "AED",
    byStatus: [
      { status: "paid", count: 2 },
      { status: "pending", count: 1 },
    ],
    excludedStatuses: ["pending"],
    provenance: prov(),
  },
  previous: {
    status: "AVAILABLE",
    paidOrders: 1,
    grossSales: "20.00",
    currency: "AED",
    byStatus: [{ status: "paid", count: 1 }],
    excludedStatuses: [],
    provenance: prov({ from: "2026-10-26T20:00:00.000Z", to: "2026-10-27T10:30:00.000Z", partial: false }),
  },
};

const unavailable = {
  status: "UNAVAILABLE",
  reason: "NOT_DEFINED",
  message: "Acme shop doesn't define payments",
} as const;
const NO_PAYMENTS: PaymentFailuresResponse = { current: unavailable, previous: unavailable };

const PAYMENTS: PaymentFailuresResponse = {
  current: {
    status: "AVAILABLE",
    attempts: 5,
    failed: 4,
    failureRate: 0.8,
    byReason: [
      { reason: "Card declined for [email]", count: 2 },
      { reason: "3DS timeout", count: 2 },
    ],
    provenance: prov({ dataset: "shop.payments" }),
  },
  previous: unavailable,
};

const REVENUE_FORMULA =
  "net sales = gross sales − refunds; gross sales = sum(amount_cents)/100 in AED, where status in (paid) and created_at in [from, to) (by order time); refunds = sum(amount) in AED, where created_at in [from, to) (by refund time, whatever the order day)";

const REVENUE: RevenueSummaryResponse = {
  current: {
    status: "AVAILABLE",
    grossSales: "125.44",
    refunds: "12.35",
    netSales: "113.09",
    currency: "AED",
    formula: REVENUE_FORMULA,
    provenance: prov(),
    refundsProvenance: prov({ dataset: "shop.refunds", filters: {} }),
  },
  previous: unavailable,
};

const TOP: TopProductsResponse = {
  current: {
    status: "AVAILABLE",
    currency: "AED",
    items: [
      { product: "Gift card for [email]", quantity: 1, revenue: "100.00" },
      { product: "Widget", quantity: 4, revenue: "25.44" },
    ],
    provenance: prov({
      dataset: "shop.order_items",
      formula: "top 10 products by revenue … product names masked",
    }),
  },
  previous: null,
};

function business(
  items: Connector[],
  payments: PaymentFailuresResponse = NO_PAYMENTS,
  extra: Parameters<typeof mockFetch>[0] = {},
) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/business/connectors": () => json({ items }),
    "GET /v1/business/metrics/sales-summary": () => json(SALES),
    "GET /v1/business/metrics/payment-failures": () => json(payments),
    "GET /v1/business/metrics/revenue": () => json(REVENUE),
    "GET /v1/business/metrics/top-products": () => json(TOP),
    ...extra,
  });
}

describe("business zone", () => {
  it("shows today's KPIs labelled partial, and says no data (never 0) for an unavailable metric", async () => {
    const calls = business([connector()]);
    renderApp(IN_SHOP);
    const zone = await screen.findByRole("region", { name: "Business" });
    const orders = await within(zone).findByRole("button", { name: /Paid orders today: 2, partial/ });
    // Only this project's connectors are ever asked for.
    const lists = calls.filter((c) => c.path === "/v1/business/connectors");
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((c) => c.query.get("projectId") === BIZ_PROJECT_ID)).toBe(true);
    expect(orders.textContent).toContain("yesterday same time: 1");
    expect(within(zone).getByRole("button", { name: /Gross sales today: AED 125.44, partial/ })).toBeTruthy();
    const failed = within(zone).getByRole("button", { name: /Failed payments today: no data/ });
    expect(failed.textContent).toContain("unavailable");
    expect(failed.textContent).toContain("doesn't define payments");
    expect(failed.textContent).not.toMatch(/\b0\b/);
    expect(within(zone).getByText(/source: Acme shop · prod · read-only · shop.orders/)).toBeTruthy();
    const q = calls.find((c) => c.path === "/v1/business/metrics/sales-summary")!.query;
    expect(Object.fromEntries(q)).toEqual({ connectorId: CID, day: "today", compare: "true" });
  });

  it("in All, invites the owner to pick a project; registering is disabled until then", async () => {
    const calls = business([]);
    const user = userEvent.setup();
    renderApp("/");
    const zone = await screen.findByRole("region", { name: "Business" });
    expect(
      await within(zone).findByText(/No business sources connected. Pick a Business project/),
    ).toBeTruthy();
    expect(within(zone).getByText("not connected")).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/business/connectors")!.query.has("projectId")).toBe(false);
    await user.click(within(zone).getByRole("button", { name: "Connect a source" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "Connect a business source" })).toBeTruthy();
    const register = within(drawer).getByRole("button", { name: "Register" });
    expect(register.hasAttribute("disabled")).toBe(true);
    expect(register.getAttribute("aria-describedby")).toBe("biz-blocked");
    expect(within(drawer).getByText(/^Pick a project first/)).toBeTruthy();
  });

  it("in a Dev project, says business sources live in Business projects and asks for none", async () => {
    const calls = business([connector()]);
    renderApp(`${IN_PROJECT}&drawer=business`);
    const drawer = await screen.findByRole("dialog");
    // The open drawer hides the board from the accessibility tree.
    const zone = screen.getByRole("region", { name: "Business", hidden: true });
    expect(within(zone).getByText(/^Business sources live in Business projects/)).toBeTruthy();
    expect(within(drawer).getByText(/^Business sources live in Business projects/)).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/v1/business/"))).toBe(false);
  });
});

describe("business drawer", () => {
  it("BIZ-G01: compares today (partial) with yesterday's same window, both with start/end, and failed payments by reason", async () => {
    business([connector()], PAYMENTS);
    renderApp("/?drawer=business");
    const drawer = await screen.findByRole("dialog");
    const table = await within(drawer).findByRole("table");
    await within(table).findByText("Today (partial)", { exact: false });
    const head = within(table).getAllByRole("columnheader");
    expect(head[1]!.textContent).toBe("Today (partial)28 Oct, 00:00 – 28 Oct, 14:30 Asia/Dubai");
    expect(head[2]!.textContent).toBe("Yesterday27 Oct, 00:00 – 27 Oct, 14:30 Asia/Dubai");
    const gross = within(table).getByRole("row", { name: /Gross sales/ });
    expect(gross.textContent).toBe("Gross salesAED 125.44AED 20.00");
    // Yesterday's payments are unavailable: shown as "no data", never 0.
    expect(within(table).getByRole("row", { name: /Failed payments/ }).textContent).toBe(
      "Failed payments4no data",
    );
    const reasons = within(drawer).getByRole("region", { name: /Failed payments by reason/ });
    expect(within(reasons).getByText("Card declined for [email]")).toBeTruthy();
    expect(within(drawer).getByText(/excluded statuses: pending/)).toBeTruthy();
  });

  it("FR-BIZ-04/05: revenue tiles show gross, refunds and net with the formula; top products by revenue, masked", async () => {
    const calls = business([connector()], PAYMENTS);
    renderApp("/?drawer=business");
    const drawer = await screen.findByRole("dialog");
    const revenue = await within(drawer).findByRole("region", { name: /Revenue today/ });
    const tiles = await within(revenue).findAllByRole("listitem");
    await waitFor(() => expect(tiles[2]!.textContent).toContain("AED 113.09"));
    expect(tiles.map((t) => t.textContent)).toEqual([
      expect.stringMatching(
        /^Gross salespartialAED 125\.44paid orders by order time · yesterday same time: no data$/,
      ),
      expect.stringMatching(/^RefundspartialAED 12\.35by refund time/),
      expect.stringMatching(/^Net salespartialAED 113\.09gross − refunds/),
    ]);
    expect(within(revenue).getByText(REVENUE_FORMULA)).toBeTruthy();
    expect(within(revenue).getByText(/source: Acme shop · prod · read-only · shop.refunds/)).toBeTruthy();

    const top = within(drawer).getByRole("region", {
      name: /Top products today · by revenue · masked · partial/,
    });
    const rows = within(top).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "ProductQtyRevenue",
      "Gift card for [email]1AED 100.00",
      "Widget4AED 25.44",
    ]);
    expect(within(top).getByText(/product names masked/)).toBeTruthy();
    for (const path of ["/v1/business/metrics/revenue", "/v1/business/metrics/top-products"])
      expect(Object.fromEntries(calls.find((c) => c.path === path)!.query)).toEqual({
        connectorId: CID,
        day: "today",
        compare: "true",
      });
  });

  it("DATA-G02: undefined refunds or order items read 'no data' with the reason, never 0", async () => {
    const notDefined = (what: string) =>
      ({
        status: "UNAVAILABLE",
        reason: "NOT_DEFINED",
        message: `Acme shop doesn't define ${what}`,
      }) as const;
    business([connector()], NO_PAYMENTS, {
      "GET /v1/business/metrics/revenue": () =>
        json({ current: notDefined("refunds"), previous: notDefined("refunds") }),
      "GET /v1/business/metrics/top-products": () =>
        json({ current: notDefined("order items"), previous: null }),
    });
    renderApp("/?drawer=business");
    const drawer = await screen.findByRole("dialog");
    const revenue = await within(drawer).findByRole("region", { name: /Revenue today/ });
    await waitFor(() => expect(revenue.textContent).toContain("doesn't define refunds"));
    for (const t of within(revenue).getAllByRole("listitem")) {
      expect(t.textContent).toMatch(/unavailableno data/);
      expect(t.textContent).not.toMatch(/\b0\b|AED/);
    }
    const top = within(drawer).getByRole("region", { name: /Top products today/ });
    expect(top.textContent).toContain("No data: Acme shop doesn't define order items");
    expect(within(top).queryByRole("table")).toBeNull();
  });

  it("FR-BIZ-04/05 dictionary: refunds and order items sections, and items need the order id column", async () => {
    const calls = business([connector({ hasDictionary: false, environment: "DEV" })], NO_PAYMENTS, {
      [`GET /v1/business/connectors/${CID}/dictionary`]: () =>
        json({ error: { code: "NOT_FOUND", message: "Metric dictionary not found" }, requestId: "r" }, 404),
      [`PUT /v1/business/connectors/${CID}/dictionary`]: (c) => json(c.body),
    });
    const user = userEvent.setup();
    renderApp(`${IN_SHOP}&drawer=business`);
    const drawer = await screen.findByRole("dialog");
    await user.click(await within(drawer).findByRole("button", { name: "Metric dictionary" }));
    const dict = await within(drawer).findByRole("form", { name: "Metric dictionary" });
    await user.clear(within(dict).getByLabelText("Reporting time zone"));
    await user.type(within(dict).getByLabelText("Reporting time zone"), "Asia/Dubai");
    await user.type(within(dict).getByLabelText("Currency"), "AED");
    await user.click(within(dict).getByLabelText("Refunds table (counted on the refund day)"));
    await user.click(within(dict).getByLabelText("Order items table (top products)"));
    const orders = within(dict).getByRole("group", { name: "Orders" });
    await user.type(within(orders).getByLabelText("Table (schema.table)"), "shop.orders");
    await user.type(within(orders).getByLabelText("Amount column"), "amount_cents");
    const refunds = within(dict).getByRole("group", { name: "Refunds" });
    await user.type(within(refunds).getByLabelText("Table (schema.table)"), "shop.refunds");
    await user.type(within(refunds).getByLabelText("Amount column"), "amount");
    await user.selectOptions(within(refunds).getByLabelText("Amount unit"), "MAJOR");
    const items = within(dict).getByRole("group", { name: "Order items" });
    await user.type(within(items).getByLabelText("Table (schema.table)"), "shop.order_items");
    await user.type(within(items).getByLabelText("Product column"), "product");
    await user.type(within(items).getByLabelText("Amount column"), "amount_cents");

    await user.click(within(dict).getByRole("button", { name: "Save dictionary" }));
    expect((await within(dict).findByRole("alert")).textContent).toMatch(
      /^orders\.idColumn: orders\.idColumn is required to join order items/,
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.type(within(orders).getByLabelText("Order id column (for order items)"), "id");
    await user.click(within(dict).getByRole("button", { name: "Save dictionary" }));
    expect(await within(dict).findByText(/Saved\./)).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      orders: { table: "shop.orders", idColumn: "id" },
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
    });
  });

  it("registers a connector, tests it and saves its metric dictionary", async () => {
    const created = connector({ status: "UNTESTED", hasDictionary: false, environment: "DEV" });
    const calls = business([created], NO_PAYMENTS, {
      "POST /v1/business/connectors": () => json(created, 201),
      [`POST /v1/business/connectors/${CID}/test`]: () =>
        json({
          ok: false,
          testedAt: NOW,
          checks: [
            { name: "credential", ok: true, detail: "shop-prod.json found with mode 0600" },
            { name: "read_only", ok: false, detail: "The role can write to shop.orders" },
          ],
        }),
      [`GET /v1/business/connectors/${CID}/dictionary`]: () =>
        json({ error: { code: "NOT_FOUND", message: "Metric dictionary not found" }, requestId: "r" }, 404),
      [`PUT /v1/business/connectors/${CID}/dictionary`]: (c) => json(c.body),
    });
    const user = userEvent.setup();
    renderApp(`${IN_SHOP}&drawer=business`);
    const drawer = await screen.findByRole("dialog");

    const form = await within(drawer).findByRole("form", { name: "Register a read-only connector" });
    await user.type(within(form).getByLabelText("Name"), "Shop dev");
    await user.type(within(form).getByLabelText("Credential reference"), "Shop Dev");
    await user.type(within(form).getByLabelText("Schemas (comma-separated)"), "shop, sales");
    await user.click(within(form).getByRole("button", { name: "Register" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/^credentialRef:/);
    await user.clear(within(form).getByLabelText("Credential reference"));
    await user.type(within(form).getByLabelText("Credential reference"), "shop-dev");
    await user.click(within(form).getByRole("button", { name: "Register" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/v1/business/connectors")).toBe(true),
    );
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/business/connectors")!.body).toEqual({
      projectId: BIZ_PROJECT_ID,
      name: "Shop dev",
      provider: "POSTGRES",
      environment: "DEV",
      credentialRef: "shop-dev",
      schemaAllowlist: ["shop", "sales"],
      statementTimeoutMs: 5000,
    });

    await user.click(within(drawer).getByRole("button", { name: "Test connection" }));
    const checks = await within(drawer).findByRole("list", { name: "Connection checks" });
    expect(checks.textContent).toContain("fail read_only · The role can write to shop.orders");

    await user.click(within(drawer).getByRole("button", { name: "Metric dictionary" }));
    const dict = await within(drawer).findByRole("form", { name: "Metric dictionary" });
    await user.clear(within(dict).getByLabelText("Reporting time zone"));
    await user.type(within(dict).getByLabelText("Reporting time zone"), "Asia/Dubai");
    await user.type(within(dict).getByLabelText("Currency"), "aed");
    await user.type(within(dict).getByLabelText("Table (schema.table)"), "shop.orders");
    await user.type(within(dict).getByLabelText("Amount column"), "amount_cents");
    await user.click(within(dict).getByRole("button", { name: "Save dictionary" }));
    expect(await within(dict).findByText(/Saved\. Run the connection test again/)).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      reportingTimezone: "Asia/Dubai",
      currency: "AED",
      orders: {
        table: "shop.orders",
        createdAtColumn: "created_at",
        statusColumn: "status",
        amountColumn: "amount_cents",
        amountUnit: "MINOR",
        paidStatuses: ["paid"],
      },
    });
  });
});

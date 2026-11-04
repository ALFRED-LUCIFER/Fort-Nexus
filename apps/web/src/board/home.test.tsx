import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { AgentKey, type Connector, type HomeKpi, type HomeSummary } from "@nexus/contracts";
import { keys } from "../lib/api.ts";
import {
  BIZ_PROJECT_ID,
  IN_PROJECT,
  JOB_ID,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  apiError,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
} from "../test/helpers.tsx";
import { kpiDelta } from "./home/kpis.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const NOW = new Date().toISOString();
const SOON = new Date(Date.now() + 3.5 * 3600_000).toISOString();
const DIVE_ID = "abababab-abab-4bab-8bab-abababababab";
const PLAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const JOB3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const IN_SHOP = `/?ws=business&project=${BIZ_PROJECT_ID}`;

const kpi = (over: Partial<HomeKpi> & Pick<HomeKpi, "key">): HomeKpi => ({
  label: "KPI",
  value: 1,
  unit: "count",
  previous: 1,
  better: "UP",
  series: [1, 1, 1, 1, 1, 1, 1],
  source: "jobs · 7 days",
  ...over,
});

const summary = (over: Partial<HomeSummary> = {}): HomeSummary => ({
  date: "2026-11-04",
  time: "14:32",
  timezone: "Asia/Dubai",
  headline: {
    segments: [
      { text: "4 things are ready for you: ", emphasis: false },
      { text: "a push for #42", emphasis: true },
      { text: " and 1 opportunity.", emphasis: false },
    ],
    sources: 3,
    decisionsWaiting: 4,
  },
  decisions: {
    approvals: 1,
    plans: 1,
    jobDrafts: 1,
    opportunities: 1,
    top: [
      { ref: { kind: "JOB", id: JOB2 }, title: "#42 Cart totals round wrong", expiresAt: SOON },
      { ref: { kind: "PLAN", id: PLAN_ID }, title: "Ship the CSV export", expiresAt: null },
      { ref: { kind: "JOB_DRAFT", id: DRAFT_ID }, title: "#57 CSV export on invoices", expiresAt: null },
      { ref: { kind: "OPPORTUNITY", id: OPP_ID }, title: "Restore the payment timeout", expiresAt: null },
    ],
  },
  kpis: [
    kpi({
      key: "REVIEW_READY_MEDIAN",
      label: "Issue → review-ready",
      value: 38,
      unit: "minutes",
      previous: 50,
      better: "DOWN",
      series: [52, 50, null, 47, 45, 40, 38],
      source: "jobs + approvals · 7 days",
    }),
    kpi({
      key: "TESTS_PASS_RATE",
      label: "Tests pass rate",
      value: null,
      unit: "ratio",
      previous: 0.9,
      series: [null, null, null, null, null, null, null],
      source: "NEXUS test runs · 7 days",
    }),
    kpi({ key: "RUNS_TODAY", label: "Runs today", value: 14, previous: 10, source: "jobs · today" }),
    kpi({
      key: "WAITING_ON_YOU",
      label: "Waiting on you",
      value: 4,
      previous: null,
      better: "DOWN",
      series: [null, null, null, null, null, null, 4],
      source: "approvals, plans, drafts, opportunities",
    }),
  ],
  agents: AgentKey.options.map((agent) =>
    agent === "DEVELOPER"
      ? {
          agent,
          state: "WORKING" as const,
          doing: "#42 cart rounding · test",
          ref: { kind: "JOB" as const, id: JOB_ID },
          costTodayUsd: 0.31,
        }
      : agent === "AI_RESEARCHER"
        ? {
            agent,
            state: "WORKING" as const,
            doing: "Deep dive · payout matching",
            ref: { kind: "DEEP_DIVE" as const, id: DIVE_ID },
            costTodayUsd: 0.09,
          }
        : agent === "QA"
          ? {
              agent,
              state: "WAITING_ON_YOU" as const,
              doing: "#7 docs · review",
              ref: null,
              costTodayUsd: 0.18,
            }
          : { agent, state: "IDLE" as const, doing: null, ref: null, costTodayUsd: 0 },
  ),
  execution: [
    {
      jobId: JOB_ID,
      title: "#42 cart rounding",
      agent: "DEVELOPER",
      status: "RUNNING",
      stage: "test",
      needsYou: false,
      createdAt: NOW,
    },
    {
      jobId: JOB2,
      title: "#7 docs",
      agent: "DEVELOPER",
      status: "AWAITING_APPROVAL",
      stage: "review",
      needsYou: true,
      createdAt: NOW,
    },
    {
      jobId: JOB3,
      title: "#44 LCP fix",
      agent: "DEVELOPER",
      status: "QUEUED",
      stage: null,
      needsYou: false,
      createdAt: NOW,
    },
  ],
  // Out of order on purpose: the page shows them in HomeResultKind order.
  results: [
    { kind: "AI_SPEND", value: 4.1, label: "AI spend", source: "estimates · 7 days" },
    { kind: "PULL_REQUESTS", value: 3, label: "draft PRs GitHub confirmed", source: "GitHub · 7 days" },
    { kind: "ISSUES_CREATED", value: 0, label: "issues created", source: "GitHub · 7 days" },
    { kind: "TESTS_VERIFIED", value: 5, label: "runs with passing tests", source: "NEXUS test runs" },
    { kind: "DEEP_DIVES", value: 1, label: "deep dives completed", source: "research · 7 days" },
  ],
  asOf: NOW,
  ...over,
});

const connector: Connector = {
  id: "44444444-4444-4444-8444-444444444444",
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
};

function home(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/research/opportunities": () => json({ items: [] }),
    "GET /v1/home": () => json(summary()),
    ...extra,
  });
}

const homeMain = () => screen.findByRole("main", { name: "Home" });
const section = (name: string | RegExp) => screen.findByRole("region", { name });
const card = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li")!;

describe("Cofounder home", () => {
  it("is what / shows, and the switch goes to the board", async () => {
    home();
    const user = userEvent.setup();
    renderApp("/", { view: "home" });
    await homeMain();
    expect(screen.queryByRole("main", { name: "Board" })).toBeNull();
    await user.click(
      within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Board" }),
    );
    expect(await screen.findByRole("main", { name: "Board" })).toBeTruthy();
    expect(screen.queryByRole("main", { name: "Home" })).toBeNull();
  });

  it("reads the day for the project: date line, headline with its key phrase, prepared line", async () => {
    const calls = home();
    renderApp(IN_PROJECT, { view: "home" });
    const brief = await section(/^4 things are ready for you:\s*a push for #42\s*and 1 opportunity\.$/);
    expect(within(brief).getByText("a push for #42").tagName).toBe("EM");
    expect(within(brief).getByText("Wednesday 4 November · 14:32 · your cofounder’s read")).toBeTruthy();
    expect(within(brief).getByText("prepared 14:32 · 3 sources · 4 decisions waiting on you")).toBeTruthy();
    // Only this project is asked for.
    const reads = calls.filter((c) => c.path === "/v1/home");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.query.get("projectId") === PROJECT_ID)).toBe(true);
  });

  it("shows the four KPIs with units, worded deltas, sparklines and sources; no data is —, never 0", async () => {
    home();
    renderApp(IN_PROJECT, { view: "home" });
    const kpis = await section("Live · Home");
    expect(within(kpis).getAllByRole("listitem")).toHaveLength(4);

    const review = card("Issue → review-ready");
    expect(review.textContent).toContain("38 min");
    expect(within(review).getByText("12 min faster than last week")).toBeTruthy();
    expect(within(review).getByText("jobs + approvals · 7 days")).toBeTruthy();
    expect(within(review).getByRole("img").getAttribute("aria-label")).toBe(
      "Last 7 days: 52 min, 50 min, no data, 47 min, 45 min, 40 min, 38 min",
    );

    const tests = card("Tests pass rate");
    expect(within(tests).getByText("—")).toBeTruthy();
    expect(within(tests).getByText("no data yet")).toBeTruthy();
    expect(tests.textContent).not.toMatch(/0%/);

    expect(card("Runs today").textContent).toContain("4 more than last week");

    // No honest history: "—" for the past days, today's value, and no delta chip.
    const waiting = card("Waiting on you");
    expect(waiting.textContent).toContain("4");
    expect(waiting.textContent).not.toMatch(/last week/);
    expect(within(waiting).getByRole("img").getAttribute("aria-label")).toBe(
      "Last 7 days: no data, no data, no data, no data, no data, no data, 4",
    );
  });

  it("lists what waits on the owner and opens each record's drawer", async () => {
    home();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    const waiting = await section("Waiting on you");
    expect(within(waiting).getByText("1 approval · 1 plan · 1 job draft · 1 opportunity")).toBeTruthy();
    const rows = within(waiting).getAllByRole("button");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("Push approval");
    expect(rows[0]!.textContent).toContain("expires in 3h");

    const cases: [string, string][] = [
      ["#42 Cart totals round wrong", `run:${JOB2}`], // a push approval comes as its job
      ["Ship the CSV export", `plan:${PLAN_ID}`],
      ["#57 CSV export on invoices", `jobdraft:${DRAFT_ID}`],
      ["Restore the payment timeout", `opp:${OPP_ID}`],
    ];
    for (const [title, drawer] of cases) {
      await user.click(
        within(await section("Waiting on you")).getByRole("button", { name: new RegExp(title) }),
      );
      await waitFor(() => expect(router.state.location.search.drawer).toBe(drawer));
      expect(router.state.location.search.project).toBe(PROJECT_ID);
      expect(router.state.location.search.ws).toBe("dev");
      await act(() => router.navigate({ to: "/", search: { ws: "dev", project: PROJECT_ID } }));
    }
  });

  it("says when nothing waits and nothing runs", async () => {
    home({
      "GET /v1/home": () =>
        json(
          summary({
            decisions: { approvals: 0, plans: 0, jobDrafts: 0, opportunities: 0, top: [] },
            execution: [],
          }),
        ),
    });
    renderApp(IN_PROJECT, { view: "home" });
    const waiting = await section("Waiting on you");
    expect(within(waiting).getByText("Nothing waits on you right now.")).toBeTruthy();
    expect(within(waiting).getByText("nothing waiting")).toBeTruthy();
    expect(within(await section("Execution")).getByText("Nothing running.")).toBeTruthy();
  });

  it("Dev only: a hidden Business workspace hides its agents from Agent activity", async () => {
    home({ "GET /v1/workspaces": () => json(workspaces([project()], [], false)) });
    renderApp(IN_PROJECT, { view: "home" });
    const agents = await section("Agent activity");
    const rows = within(agents).getAllByRole("listitem");
    expect(rows).toHaveLength(AgentKey.options.length - 1);
    expect(rows.some((r) => r.textContent?.includes("Financial analyst"))).toBe(false);
  });

  it("shows every agent with its state in words, what it does and its est. cost; rows open drawers", async () => {
    home();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    const agents = await section("Agent activity");
    const rows = within(agents).getAllByRole("listitem");
    expect(rows).toHaveLength(AgentKey.options.length);
    expect(within(agents).getByText("2 working · 1 waiting on you")).toBeTruthy();
    const dev = rows.find((r) => r.textContent?.includes("Developer"))!;
    expect(within(dev).getByText("working")).toBeTruthy();
    expect(within(dev).getByText("$0.31 est. today")).toBeTruthy();
    const qa = rows.find((r) => r.textContent?.includes("QA"))!;
    expect(within(qa).getByText("waiting on you")).toBeTruthy();
    expect(
      within(rows.find((r) => r.textContent?.includes("Chief of Staff"))!).getByText("idle"),
    ).toBeTruthy();

    await user.click(within(dev).getByRole("button", { name: "Developer" }));
    await waitFor(() => expect(router.state.location.search.drawer).toBe("agent:DEVELOPER"));
    await act(() => router.navigate({ to: "/", search: { ws: "dev", project: PROJECT_ID } }));
    await user.click(
      within(await section("Agent activity")).getByRole("button", { name: "#42 cart rounding · test" }),
    );
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`run:${JOB_ID}`));
    await act(() => router.navigate({ to: "/", search: { ws: "dev", project: PROJECT_ID } }));
    await user.click(
      within(await section("Agent activity")).getByRole("button", { name: "Deep dive · payout matching" }),
    );
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`research:${DIVE_ID}`));
  });

  it("shows each run's stage in words on a six-stage bar, flags what needs the owner, and opens the run", async () => {
    home();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    const exec = await section("Execution");
    const runs = within(exec).getAllByRole("button");
    expect(runs).toHaveLength(3);
    expect(runs[0]!.textContent).toContain("Test · stage 4 of 6");
    expect(runs[0]!.textContent).not.toContain("needs you");
    expect(runs[1]!.textContent).toContain("Review · stage 5 of 6");
    expect(within(runs[1]!).getByText("needs you")).toBeTruthy();
    expect(runs[2]!.textContent).toContain("not started");
    await user.click(runs[1]!);
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`run:${JOB2}`));
  });

  it("shows the five results of the week with their sources, zeros included, AI spend as est.", async () => {
    home();
    renderApp(IN_PROJECT, { view: "home" });
    const results = await section("Results · this week");
    const items = within(results).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "3draft PRs GitHub confirmed✓ source: GitHub · 7 days",
      "0issues created✓ source: GitHub · 7 days",
      "5runs with passing tests✓ source: NEXUS test runs",
      "1deep dives completed✓ source: research · 7 days",
      "$4.10 est.AI spend✓ source: estimates · 7 days",
    ]);
  });

  it("All view: reads every project, says it is read-only, and the noticed cards can't approve", async () => {
    const calls = home({
      "GET /v1/research/opportunities": () =>
        json({
          items: [
            {
              id: OPP_ID,
              projectId: PROJECT_ID,
              deepDiveId: JOB3,
              kind: "RISK",
              title: "Restore the payment timeout",
              problem: "Checkout fails more often.",
              targetUsers: "Buyers",
              impactEstimate: "fewer failed payments",
              confidence: "MEDIUM",
              evidence: [
                { id: 0, text: "Failures doubled.", basis: "OBSERVED", label: "UNVERIFIED", evidence: [] },
              ],
              validationSteps: [],
              agents: ["AI_RESEARCHER"],
              status: "OPEN",
              issue: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
    });
    renderApp("/", { view: "home" });
    expect(
      await screen.findByText(
        /prepared 14:32 · 3 sources · 4 decisions waiting on you · all projects · read-only/,
      ),
    ).toBeTruthy();
    expect(calls.filter((c) => c.path === "/v1/home").every((c) => !c.query.has("projectId"))).toBe(true);
    const noticed = await section("Your cofounder noticed");
    const cardEl = await within(noticed).findByRole("article", { name: "Restore the payment timeout" });
    expect((within(cardEl).getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(cardEl).getByText(PICK_PROJECT)).toBeTruthy();
    // The Dev KPIs read the All aggregate.
    expect(within(await section("Live · all projects")).getAllByRole("listitem")).toHaveLength(4);
  });

  it("Business project: KPIs come from its connector, marked partial, not from the Dev KPIs", async () => {
    const calls = home({
      "GET /v1/business/connectors": () => json({ items: [connector] }),
      "GET /v1/business/metrics/sales-summary": () =>
        json({
          current: {
            status: "AVAILABLE",
            paidOrders: 184,
            grossSales: "41900.00",
            currency: "AED",
            byStatus: [{ status: "paid", count: 184 }],
            excludedStatuses: [],
            provenance: {
              connectorId: connector.id,
              connectorName: "Acme shop",
              environment: "PROD",
              dataset: "shop.orders",
              timezone: "Asia/Dubai",
              from: "2026-11-03T20:00:00.000Z",
              to: NOW,
              filters: {},
              formula: "count(*)",
              queriedAt: NOW,
              latestRecordAt: NOW,
              partial: true,
            },
          },
          previous: null,
        }),
      "GET /v1/business/metrics/payment-failures": () =>
        json({
          current: {
            status: "UNAVAILABLE",
            reason: "NOT_DEFINED",
            message: "Acme shop doesn't define payments",
          },
          previous: null,
        }),
    });
    renderApp(IN_SHOP, { view: "home" });
    const kpis = await section("Live · Shop");
    expect(await within(kpis).findByRole("button", { name: /Paid orders today: 184, partial/ })).toBeTruthy();
    expect(within(kpis).getByRole("button", { name: /Failed payments today: no data/ })).toBeTruthy();
    expect(within(kpis).queryByRole("heading", { name: "Issue → review-ready" })).toBeNull();
    expect(calls.some((c) => c.path === "/v1/home" && c.query.get("projectId") === BIZ_PROJECT_ID)).toBe(
      true,
    );
  });

  it("Business project without a connector: an honest empty card that opens the Business drawer", async () => {
    home({ "GET /v1/business/connectors": () => json({ items: [] }) });
    const user = userEvent.setup();
    const { router } = renderApp(IN_SHOP, { view: "home" });
    const kpis = await section("Live · Shop");
    expect(await within(kpis).findByText(/No sources connected to Shop/)).toBeTruthy();
    await user.click(within(kpis).getByRole("button", { name: "Connect a source" }));
    await waitFor(() => expect(router.state.location.search.drawer).toBe("business"));
  });

  it("loading, then an error with a retry, never an empty read", async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    let fail = true;
    home({
      "GET /v1/home": async () => {
        await first;
        return fail ? apiError(503, "INTERNAL", "NEXUS can't read the home summary.") : json(summary());
      },
    });
    const user = userEvent.setup();
    renderApp(IN_PROJECT, { view: "home" });
    const main = await homeMain();
    expect(await within(main).findByText("Loading your cofounder’s read…")).toBeTruthy();
    release();
    expect((await within(main).findByRole("alert")).textContent).toBe("NEXUS can't read the home summary.");
    expect(within(main).queryByRole("region", { name: "Agent activity" })).toBeNull();
    fail = false;
    await user.click(within(main).getByRole("button", { name: "Try again" }));
    expect(await section("Agent activity")).toBeTruthy();
  });

  it("keeps the last read when a refresh fails, and says so", async () => {
    let fail = false;
    home({
      "GET /v1/home": () => (fail ? apiError(503, "INTERNAL", "Down for a moment.") : json(summary())),
    });
    const { queryClient } = renderApp(IN_PROJECT, { view: "home" });
    await section("Agent activity");
    fail = true;
    await act(() => queryClient.refetchQueries({ queryKey: keys.home(PROJECT_ID) }));
    expect(
      (await screen.findByText(/Can't refresh: Down for a moment\. Showing what NEXUS had at/)).getAttribute(
        "role",
      ),
    ).toBe("status");
    expect(screen.getByRole("region", { name: "Agent activity" })).toBeTruthy();
  });

  it("offline: waits and says so instead of loading forever", async () => {
    home();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    await section("Agent activity");
    onlineManager.setOnline(false);
    try {
      await act(() => router.navigate({ to: "/", search: { ws: "dev", project: OTHER_PROJECT_ID } }));
      const main = await homeMain();
      expect(
        await within(main).findByText(/You're offline\. NEXUS will load your cofounder’s read/),
      ).toBeTruthy();
    } finally {
      onlineManager.setOnline(true);
    }
    expect(await section("Agent activity")).toBeTruthy();
  });

  it("is a landmarked page of headed sections, lists and status text", async () => {
    home();
    renderApp(IN_PROJECT, { view: "home" });
    const main = await homeMain();
    await section("Agent activity");
    expect(
      within(main)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      "4 things are ready for you: a push for #42 and 1 opportunity.",
      "Live · Home",
      "Waiting on you",
      "Your repositories · Home",
      "Your cofounder noticed",
      "Agent activity",
      "Execution",
      "Results · this week",
    ]);
    for (const name of ["Waiting on you", "Agent activity", "Execution", "Results · this week"])
      expect(within(await section(name)).getByRole("list")).toBeTruthy();
    // The Cofounder panel sits beside the page, not inside its main landmark.
    expect(main.contains(screen.getByRole("complementary"))).toBe(false);
  });
});

describe("KPI delta", () => {
  const base = kpi({ key: "REVIEW_READY_MEDIAN", unit: "minutes", better: "DOWN" });
  it("words and colours by direction and by which way is better", () => {
    expect(kpiDelta({ ...base, value: 38, previous: 50 })).toEqual({
      text: "12 min faster than last week",
      tone: "var(--green)",
    });
    expect(kpiDelta({ ...base, value: 60, previous: 50 })).toEqual({
      text: "10 min slower than last week",
      tone: "var(--amber)",
    });
    expect(kpiDelta({ ...base, value: 125, previous: 50 })?.text).toBe("1 h 15 min slower than last week");
    const rate = kpi({ key: "TESTS_PASS_RATE", unit: "ratio", better: "UP" });
    expect(kpiDelta({ ...rate, value: 0.92, previous: 0.95 })).toEqual({
      text: "3 pt lower than last week",
      tone: "var(--amber)",
    });
    expect(kpiDelta({ ...rate, value: 0.95, previous: 0.9 })).toEqual({
      text: "5 pt higher than last week",
      tone: "var(--green)",
    });
    expect(kpiDelta({ ...base, value: 50, previous: 50.2 })?.text).toBe("same as last week");
    expect(kpiDelta({ ...base, value: 50, previous: null })).toBeNull();
    expect(kpiDelta({ ...base, value: null, previous: 50 })?.text).toBe("no data yet");
  });
});

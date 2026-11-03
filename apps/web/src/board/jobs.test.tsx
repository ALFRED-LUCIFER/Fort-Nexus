import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import {
  AgentKey,
  type AgentPerformance,
  type AgentPerformanceRow,
  type GithubStatus,
  type JobHistoryItem,
  type Repository,
} from "@nexus/contracts";
import {
  BIZ_PROJECT_ID,
  FakeEventSource,
  IN_PROJECT,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
  type Call,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const T0 = "2026-10-28T10:00:00.000Z";
const DEV_JOB = "44444444-4444-4444-8444-444444444441";
const DIAG_JOB = "44444444-4444-4444-8444-444444444442";
const NEXT_JOB = "44444444-4444-4444-8444-444444444443";
const PR_URL = "https://github.com/acme/web/pull/7";

const installed: GithubStatus = {
  configured: true,
  appSlug: "nexus-test",
  installUrl: "https://github.com/apps/nexus-test/installations/new",
  syncedAt: T0,
  installations: [
    {
      id: 1,
      account: { login: "acme", type: "Organization" },
      repositorySelection: "selected",
      suspended: false,
      permissions: { issues: "write", pull_requests: "write" },
    },
  ],
};
const repo = (id: string, fullName: string): Repository => ({
  id,
  fullName,
  owner: fullName.split("/")[0]!,
  name: fullName.split("/")[1]!,
  private: true,
  defaultBranch: "main",
  htmlUrl: `https://github.com/${fullName}`,
  pushedAt: T0,
  updatedAt: T0,
  installationId: 1,
});

const devItem = (over: Partial<JobHistoryItem> = {}): JobHistoryItem => ({
  job: job({
    id: DEV_JOB,
    jobType: "DEV_ISSUE_TO_PR",
    status: "COMPLETED",
    riskTier: "R2",
    request: {
      jobType: "DEV_ISSUE_TO_PR",
      repositoryId: "101",
      issueNumber: 42,
      projectId: PROJECT_ID,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    },
    issue: { fullName: "acme/web", issueNumber: 42, title: "Fix the cart totals", workBranch: "nexus/42" },
    agent: "DEVELOPER",
    outcome: "PR_CREATED",
    estimatedCostUsd: 1.234,
    startedAt: T0,
    finishedAt: "2026-10-28T10:01:05.000Z",
  }),
  repositoryId: "101",
  repositoryFullName: "acme/web",
  durationMs: 65_000,
  tests: "passed",
  pullRequest: { number: 7, url: PR_URL },
  approval: { id: "55555555-5555-4555-8555-555555555551", status: "EXECUTED" },
  ...over,
});
const diagItem = (over: Partial<JobHistoryItem> = {}): JobHistoryItem => ({
  job: job({ id: DIAG_JOB, status: "FAILED", runnerId: runner().id }),
  repositoryId: null,
  repositoryFullName: null,
  durationMs: null,
  tests: null,
  pullRequest: null,
  approval: null,
  ...over,
});

const zero = (agent: AgentKey): AgentPerformanceRow => ({
  agent,
  jobs: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  successRate: null,
  pullRequests: 0,
  costUsd: 0,
  costPerPullRequestUsd: null,
  medianMinutesToReviewReady: null,
  approvals: { approved: 0, denied: 0, expired: 0, pending: 0 },
});
const performance = (days: 7 | 30): AgentPerformance => ({
  days,
  from: days === 7 ? "2026-10-28" : "2026-10-05",
  to: "2026-11-03",
  asOf: "2026-11-03T12:00:00.000Z",
  items: AgentKey.options.map((a) =>
    a === "DEVELOPER"
      ? {
          ...zero(a),
          jobs: 5,
          succeeded: 3,
          failed: 1,
          cancelled: 1,
          successRate: 0.75,
          pullRequests: 2,
          costUsd: 4.5,
          costPerPullRequestUsd: 2.25,
          medianMinutesToReviewReady: 72.4,
          approvals: { approved: 2, denied: 1, expired: 0, pending: 1 },
        }
      : zero(a),
  ),
});

let pages: Record<string, { items: JobHistoryItem[]; nextCursor: string | null }>;

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/github/status": () => json(installed),
    "GET /v1/repositories": (c) =>
      json({
        items: c.query.get("projectId")
          ? [repo("101", "acme/web")]
          : [repo("101", "acme/web"), repo("102", "acme/api")],
        syncedAt: T0,
      }),
    "GET /v1/jobs/history": (c) => json(pages[c.query.get("cursor") ?? "first"] ?? pages.first),
    "GET /v1/agents/performance": (c) => json(performance(c.query.get("days") === "30" ? 30 : 7)),
    ...extra,
  });
}

beforeEach(() => {
  pages = { first: { items: [devItem(), diagItem()], nextCursor: null } };
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

const drawer = () => screen.findByRole("dialog");
const IN_DRAWER = `${IN_PROJECT}&drawer=jobs`;
const historyCalls = (calls: Call[]) => calls.filter((c) => c.path === "/v1/jobs/history");
const lastQuery = (calls: Call[]) => Object.fromEntries(historyCalls(calls).at(-1)!.query);
const rows = async () =>
  within(await within(await drawer()).findByRole("list", { name: "Jobs" })).getAllByRole("listitem");
const why = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;

describe("Jobs page: all jobs", () => {
  it("shows every job with its evidence; status as text, cost as an estimate, a PR link only when GitHub gave one", async () => {
    const calls = board();
    renderApp(IN_DRAWER);
    const [dev, diag] = await rows();
    const d = within(dev!);
    expect(d.getByRole("button", { name: "#42 Fix the cart totals, open the run" })).toBeTruthy();
    expect(d.getByText("Completed")).toBeTruthy();
    expect(dev!.textContent).toContain("Repositoryacme/web");
    expect(dev!.textContent).toContain("AgentDeveloper");
    expect(dev!.textContent).toContain("Duration1m 5s");
    expect(dev!.textContent).toContain("Cost$1.23 est.");
    expect(dev!.textContent).toContain("TestsPassed");
    expect(dev!.textContent).toContain("OutcomeDraft PR created");
    const pr = d.getByRole("link", { name: /^#7 on GitHub/ });
    expect(pr.getAttribute("href")).toBe(PR_URL);
    expect(pr.getAttribute("rel")).toBe("noopener noreferrer");

    const g = within(diag!);
    expect(g.getByRole("button", { name: "Diagnostic · node-version, open the run" })).toBeTruthy();
    expect(g.getByText("Failed")).toBeTruthy();
    expect(g.queryByRole("link")).toBeNull();
    for (const term of ["Repository", "Duration", "Cost", "Tests", "Pull request", "Outcome"])
      expect(diag!.textContent).toContain(`${term}—`);
    // A project's page shows only that project's jobs, and no project column.
    expect(lastQuery(calls)).toEqual({ projectId: PROJECT_ID, limit: "25" });
    expect(dev!.textContent).not.toContain("Project");
  });

  it("each filter goes into the query, and changing one starts again from the first page", async () => {
    pages = {
      first: { items: [devItem()], nextCursor: DEV_JOB },
      [DEV_JOB]: { items: [diagItem({ job: job({ id: NEXT_JOB, status: "CANCELLED" }) })], nextCursor: null },
    };
    const calls = board();
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    expect(await rows()).toHaveLength(1);
    await user.click(within(d).getByRole("button", { name: "Load more" }));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect(lastQuery(calls)).toMatchObject({ cursor: DEV_JOB });
    expect(within(d).queryByRole("button", { name: "Load more" })).toBeNull();

    const repoSelect = within(d).getByRole("combobox", { name: "Repository" });
    // In a project: only its bound repositories.
    await waitFor(() => expect(within(repoSelect).getAllByRole("option")).toHaveLength(2));
    await user.selectOptions(repoSelect, "acme/web");
    await waitFor(() =>
      expect(lastQuery(calls)).toEqual({ projectId: PROJECT_ID, limit: "25", repositoryId: "101" }),
    );
    await waitFor(async () => expect(await rows()).toHaveLength(1));

    await user.selectOptions(within(d).getByRole("combobox", { name: "Agent" }), "Developer");
    await user.selectOptions(within(d).getByRole("combobox", { name: "Status" }), "Needs you");
    fireEvent.change(within(d).getByLabelText("Created from"), { target: { value: "2026-10-01" } });
    fireEvent.change(within(d).getByLabelText("to"), { target: { value: "2026-10-31" } });
    await waitFor(() =>
      expect(lastQuery(calls)).toEqual({
        projectId: PROJECT_ID,
        limit: "25",
        repositoryId: "101",
        agent: "DEVELOPER",
        status: "NEEDS_YOU",
        from: "2026-10-01",
        to: "2026-10-31",
      }),
    );
    expect(historyCalls(calls).filter((c) => c.query.has("cursor"))).toHaveLength(1);

    await user.click(within(d).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastQuery(calls)).toEqual({ projectId: PROJECT_ID, limit: "25" }));
    // Back to no filters is a fresh first page, not the two pages loaded earlier.
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(within(d).getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("refuses a from date after the to date without asking the API", async () => {
    const calls = board();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await rows();
    const before = historyCalls(calls).length;
    fireEvent.change(within(d).getByLabelText("Created from"), { target: { value: "2026-11-02" } });
    fireEvent.change(within(d).getByLabelText("to"), { target: { value: "2026-11-01" } });
    expect((await within(d).findByRole("alert")).textContent).toMatch(/from date is after the to date/);
    expect(historyCalls(calls)).toHaveLength(before + 1);
  });

  it("tells no jobs yet apart from no jobs matching the filters", async () => {
    pages = { first: { items: [], nextCursor: null } };
    board();
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    expect(
      await within(d).findByText(/^No jobs yet in Home\. Describe one in plain words with New job/),
    ).toBeTruthy();
    await user.selectOptions(within(d).getByRole("combobox", { name: "Status" }), "Failed");
    expect(await within(d).findByText("No jobs match these filters.")).toBeTruthy();
    expect(within(d).queryByText(/No jobs yet/)).toBeNull();
  });

  it("shows the API's error", async () => {
    board({ "GET /v1/jobs/history": () => apiError(403, "FORBIDDEN", "That project isn't yours.") });
    renderApp(IN_DRAWER);
    expect((await within(await drawer()).findByRole("alert")).textContent).toBe("That project isn't yours.");
  });

  it("says so when the API can't be reached", async () => {
    board({ "GET /v1/jobs/history": () => Promise.reject(new TypeError("Failed to fetch")) });
    renderApp(IN_DRAWER);
    expect((await within(await drawer()).findByRole("alert")).textContent).toMatch(
      /Can't reach the NEXUS API/,
    );
  });

  it("offline: waits and says so instead of loading forever", async () => {
    const calls = board();
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await rows();
    const before = historyCalls(calls).length;
    onlineManager.setOnline(false);
    try {
      await user.selectOptions(within(d).getByRole("combobox", { name: "Status" }), "Failed");
      expect(await within(d).findByText(/You're offline\. NEXUS will load this/)).toBeTruthy();
      expect(historyCalls(calls)).toHaveLength(before);
    } finally {
      onlineManager.setOnline(true);
    }
    expect(await rows()).toHaveLength(2);
    expect(lastQuery(calls)).toMatchObject({ status: "FAILED" });
  });

  it("New job opens the New job drawer in a Dev project", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp(IN_DRAWER);
    await user.click(within(await drawer()).getByRole("button", { name: "New job" }));
    expect(router.state.location.search).toMatchObject({ project: PROJECT_ID, drawer: "newjob" });
  });

  it("All view: every project's jobs with their project, every repository, and New job disabled with the reason", async () => {
    pages = {
      first: {
        items: [devItem(), diagItem({ job: job({ id: DIAG_JOB, projectId: OTHER_PROJECT_ID }) })],
        nextCursor: null,
      },
    };
    const calls = board();
    renderApp("/?drawer=jobs");
    const d = await drawer();
    const [dev, decoy] = await rows();
    expect(dev!.textContent).toContain("ProjectHome");
    expect(decoy!.textContent).toContain("ProjectDecoy");
    expect(lastQuery(calls)).toEqual({ limit: "25" });
    const repoSelect = within(d).getByRole("combobox", { name: "Repository" });
    await waitFor(() => expect(within(repoSelect).getAllByRole("option")).toHaveLength(3));
    const newJob = within(d).getByRole("button", { name: "New job" });
    expect((newJob as HTMLButtonElement).disabled).toBe(true);
    expect(why(newJob)).toBe(PICK_PROJECT);
  });

  it("a Business project can't start a job", async () => {
    board();
    renderApp(`/?ws=business&project=${BIZ_PROJECT_ID}&drawer=jobs`);
    const d = await drawer();
    await waitFor(() =>
      expect((within(d).getByRole("button", { name: "New job" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(why(within(d).getByRole("button", { name: "New job" }))).toMatch(/is a Business project/);
  });

  it("keyboard: arrow keys move between tabs, Enter on a row opens its run", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp(IN_DRAWER);
    const d = await drawer();
    const all = within(d).getByRole("tab", { name: "All jobs" });
    expect(all.getAttribute("aria-selected")).toBe("true");
    all.focus();
    await user.keyboard("{ArrowRight}");
    const perf = within(d).getByRole("tab", { name: "Agent performance" });
    expect(document.activeElement).toBe(perf);
    expect(perf.getAttribute("aria-selected")).toBe("true");
    expect(await within(d).findByRole("list", { name: "Agents" })).toBeTruthy();
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(all);

    const [dev] = await rows();
    within(dev!)
      .getByRole("button", { name: /open the run/ })
      .focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: `run:${DEV_JOB}` }));
  });
});

describe("Jobs page: agent performance", () => {
  it("shows each agent's numbers, the window and as-of, zeros as zeros and — where nothing can be computed", async () => {
    const calls = board();
    const user = userEvent.setup();
    renderApp(IN_DRAWER);
    const d = await drawer();
    await user.click(within(d).getByRole("tab", { name: "Agent performance" }));
    const cards = within(await within(d).findByRole("list", { name: "Agents" })).getAllByRole("listitem");
    expect(cards).toHaveLength(AgentKey.options.length);
    const dev = cards.find((c) => within(c).queryByRole("heading", { name: "Developer" }))!;
    expect(dev.textContent).toContain("Jobs5");
    expect(dev.textContent).toContain("Success rate75% · 3 of 4");
    expect(dev.textContent).toContain("Pull requests2");
    expect(dev.textContent).toContain("Cost$4.50 est.");
    expect(dev.textContent).toContain("Cost per PR$2.25 est.");
    expect(dev.textContent).toContain("Median to review-ready1 h 12 min");
    expect(dev.textContent).toContain("2 approved · 1 denied · 0 expired · 1 pending");

    const qa = cards.find((c) => within(c).queryByRole("heading", { name: "QA" }))!;
    expect(qa.textContent).toContain("Jobs0");
    expect(qa.textContent).toContain("Success rate—");
    expect(qa.textContent).toContain("Pull requests0");
    expect(qa.textContent).toContain("Cost$0.00 est.");
    expect(qa.textContent).toContain("Cost per PR—");
    expect(qa.textContent).toContain("Median to review-ready—");
    expect(qa.textContent).toContain("0 approved · 0 denied · 0 expired · 0 pending");

    expect(within(d).getByText("Costs are provider-reported estimates, not invoices.")).toBeTruthy();
    expect(d.querySelector('time[datetime="2026-10-28"]')).toBeTruthy();
    expect(d.querySelector('time[datetime="2026-11-03T12:00:00.000Z"]')).toBeTruthy();
    const perfCalls = () => calls.filter((c) => c.path === "/v1/agents/performance");
    expect(Object.fromEntries(perfCalls().at(-1)!.query)).toEqual({ projectId: PROJECT_ID, days: "7" });

    const month = within(d).getByRole("button", { name: "30 days" });
    await user.click(month);
    expect(month.getAttribute("aria-pressed")).toBe("true");
    expect(await within(d).findByText((_, el) => el?.getAttribute("datetime") === "2026-10-05")).toBeTruthy();
    expect(Object.fromEntries(perfCalls().at(-1)!.query)).toEqual({ projectId: PROJECT_ID, days: "30" });
  });

  it("All view asks for every project's results; errors are shown", async () => {
    const calls = board({
      "GET /v1/agents/performance": () => apiError(500, "INTERNAL", "Performance is unavailable."),
    });
    const user = userEvent.setup();
    renderApp("/?drawer=jobs");
    const d = await drawer();
    await user.click(within(d).getByRole("tab", { name: "Agent performance" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("Performance is unavailable.");
    expect(Object.fromEntries(calls.filter((c) => c.path === "/v1/agents/performance")[0]!.query)).toEqual({
      days: "7",
    });
  });
});

describe("Code zone", () => {
  it("All jobs beside Recent runs opens the Jobs page; the empty text points to New job", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Code" });
    expect(
      await within(zone).findByText(/^No runs yet\. Describe one in plain words with New job/),
    ).toBeTruthy();
    await user.click(within(zone).getByRole("button", { name: "All jobs" }));
    expect(router.state.location.search).toMatchObject({ project: PROJECT_ID, drawer: "jobs" });
    expect(within(await drawer()).getByRole("heading", { name: "Jobs" })).toBeTruthy();
  });
});

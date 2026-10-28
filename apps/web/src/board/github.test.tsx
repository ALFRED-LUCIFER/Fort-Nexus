import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GITHUB_SETUP_COMMAND,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type GithubStatus,
  type Issue,
  type IssueDetail,
  type Repository,
} from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  PROJECT_ID,
  ME,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";

const SYNCED = new Date().toISOString();
const INSTALL_URL = "https://github.com/apps/nexus-test/installations/new";

const installed: GithubStatus = {
  configured: true,
  appSlug: "nexus-test",
  installUrl: INSTALL_URL,
  syncedAt: SYNCED,
  installations: [
    {
      id: 1,
      account: { login: "acme", type: "Organization" },
      repositorySelection: "selected",
      suspended: false,
      permissions: { issues: "read", pull_requests: "write" },
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
  pushedAt: SYNCED,
  updatedAt: SYNCED,
  installationId: 1,
});
const REPOS = [repo("101", "acme/web"), repo("102", "acme/api")];

const issue = (number: number, over: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
  milestone: null,
  author: "reporter",
  comments: 0,
  createdAt: SYNCED,
  updatedAt: SYNCED,
  htmlUrl: `https://github.com/acme/web/issues/${number}`,
  ...over,
});

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  issue: issue(42, { title: "Cart totals round wrong" }),
  body: "Totals are wrong. <img src=x onerror=alert(1)>",
  comments: [],
  acceptanceCriteria: ["Rounds per currency minor unit", "No change for USD"],
  missingAcceptanceCriteria: false,
  syncedAt: SYNCED,
  ...over,
});

let runners = [runner()];
const mockRunners = (r: ReturnType<typeof runner>[]) => (runners = r);

function board(status: GithubStatus, extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: runners }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json(status),
    "GET /v1/repositories": () => json({ items: REPOS, syncedAt: SYNCED }),
    ...extra,
  });
}

const codeZone = async () => screen.findByRole("region", { name: "Code" });

beforeEach(() => {
  runners = [runner()];
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("Code zone", () => {
  it("shows the setup command when GitHub isn't set up, and asks for no repositories", async () => {
    const calls = board({ configured: false });
    renderApp("/");
    const zone = await codeZone();
    expect((await within(zone).findByText(GITHUB_SETUP_COMMAND)).tagName).toBe("CODE");
    expect(calls.some((c) => c.path === "/v1/repositories")).toBe(false);
  });

  it("links to the app's install page when there is no installation", async () => {
    board({ ...installed, installations: [] });
    renderApp("/");
    const link = await within(await codeZone()).findByRole("link", { name: /Install it on GitHub/ });
    expect(link.getAttribute("href")).toBe(INSTALL_URL);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("lists repositories and opens the repo drawer with accounts and repositories", async () => {
    board(installed, {
      "GET /v1/repositories/102/issues": () => json({ items: [], page: 1, nextPage: null, syncedAt: SYNCED }),
    });
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const zone = await codeZone();
    await user.click(await within(zone).findByRole("button", { name: /acme\/api/ }));

    const drawer = await screen.findByRole("dialog");
    expect(router.state.location.search).toMatchObject({ drawer: "repo:102" });
    expect(within(drawer).getByRole("heading", { name: "acme/api" })).toBeTruthy();
    const accounts = within(drawer).getByRole("list", { name: "GitHub accounts" });
    expect(accounts.textContent).toMatch(/acme.*organization · selected repos · installation 1/);
    const rows = within(within(drawer).getByRole("list", { name: "Repositories" })).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(rows[1]!.textContent).toMatch(/private · main · updated .*PR write/);
    expect(await within(drawer).findByText("No issues match these filters.")).toBeTruthy();
  });
});

describe("repo drawer issues", () => {
  it("applies filters through the URL and keeps them when paging", async () => {
    const calls = board(installed, {
      "GET /v1/repositories/101/issues": (c) =>
        json({
          items: c.query.get("page") === "2" ? [issue(9)] : [issue(1), issue(2, { state: "closed" })],
          page: Number(c.query.get("page") ?? 1),
          nextPage: c.query.get("page") === "2" ? null : 2,
          syncedAt: SYNCED,
        }),
    });
    const user = userEvent.setup();
    const { router } = renderApp("/?drawer=repo:101");
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("Issue 1");

    const form = within(drawer).getByRole("search", { name: "Filter issues" });
    await user.selectOptions(within(form).getByLabelText("State"), "all");
    await user.type(within(form).getByLabelText("Labels"), "bug,ui");
    await user.type(within(form).getByLabelText("Assignee"), "octo");
    await user.type(within(form).getByLabelText("Search text"), "cart");
    await user.click(within(form).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        drawer: "repo:101",
        state: "all",
        labels: "bug,ui",
        assignee: "octo",
        q: "cart",
      }),
    );

    await user.click(await within(drawer).findByRole("button", { name: "Next" }));
    expect(await within(drawer).findByText("Issue 9")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);

    const last = calls.filter((c) => c.path === "/v1/repositories/101/issues").at(-1)!;
    expect(Object.fromEntries(last.query)).toEqual({
      state: "all",
      labels: "bug,ui",
      assignee: "octo",
      q: "cart",
      page: "2",
    });
  });

  it("shows an API error instead of the list", async () => {
    board(installed, {
      "GET /v1/repositories/101/issues": () =>
        json(
          { error: { code: "FORBIDDEN", message: "NEXUS can't access acme/web anymore." }, requestId: "r" },
          403,
        ),
    });
    renderApp("/?drawer=repo:101");
    expect((await screen.findByRole("alert")).textContent).toBe("NEXUS can't access acme/web anymore.");
  });
});

describe("issue drawer", () => {
  it("shows the plain-text body and extracted criteria; Plan only waits for the plan step", async () => {
    const calls = board(installed, { "GET /v1/repositories/101/issues/42": () => json(detail()) });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=issue:101:42`);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("heading", { name: "#42 Cart totals round wrong" })).toBeTruthy();
    expect(await within(drawer).findByText(/Issue · ready · acme\/web/)).toBeTruthy();

    // The body is text: the HTML in it is shown, never rendered.
    expect(within(drawer).getByText("Totals are wrong. <img src=x onerror=alert(1)>")).toBeTruthy();
    expect(drawer.querySelector("img")).toBeNull();

    const ac = within(drawer).getByRole("region", { name: "Acceptance criteria · extracted" });
    expect(
      within(ac)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Rounds per currency minor unit", "No change for USD"]);
    expect(within(drawer).queryByText("Missing acceptance criteria")).toBeNull();

    const plan = within(drawer).getByRole("button", { name: "Plan only" });
    expect(plan.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(plan.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Plan only arrives with the plan step.",
    );
    await user.click(plan);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("previews the run, posts it with one Idempotency-Key reused on retry, and opens the run", async () => {
    let attempts = 0;
    const calls = board(installed, {
      "GET /v1/repositories/101/issues/42": () => json(detail()),
      "POST /v1/jobs": () =>
        ++attempts === 1
          ? apiError(503, "RUNNER_UNAVAILABLE", "Queue is busy, try again.")
          : json({ jobId: JOB_ID, status: "QUEUED", streamUrl: `/v1/jobs/${JOB_ID}/events` }, 202),
      [`GET /v1/jobs/${JOB_ID}`]: () => json(job()),
      "GET /v1/approvals": () => json({ items: [] }),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=issue:101:42`);
    const start = await screen.findByRole("button", { name: "Start run on test-host" });
    expect(start.getAttribute("aria-expanded")).toBe("false");
    await user.click(start);

    const preview = screen.getByRole("region", { name: "Here’s exactly what will happen." });
    expect(start.getAttribute("aria-expanded")).toBe("true");
    const fact = (k: string) =>
      within(preview).getByText(k, { selector: "dt" }).nextElementSibling!.textContent;
    expect(fact("Repository")).toBe("acme/web");
    expect(fact("Issue")).toBe("#42 Cart totals round wrong");
    expect(fact("Work branch")).toBe("nexus/issue-42-…");
    expect(fact("Runs on")).toMatch(/^test-host · online/);
    expect(
      within(preview).getByText("Runs at home in a sandbox. Push and PR always ask you first."),
    ).toBeTruthy();
    const base = within(preview).getByLabelText("Base branch");
    expect((base as HTMLInputElement).value).toBe("main");
    expect(document.activeElement).toBe(base);
    expect(
      ["Time limit (minutes)", "Agent turns", "Model cost cap (USD)"].map(
        (l) => (within(preview).getByLabelText(l) as HTMLInputElement).value,
      ),
    ).toEqual(["45", "60", "5"]);

    await user.clear(base);
    await user.type(base, "develop");
    await user.click(within(preview).getByRole("button", { name: "Confirm and start" }));
    expect((await within(preview).findByRole("alert")).textContent).toBe("Queue is busy, try again.");
    await user.click(within(preview).getByRole("button", { name: "Confirm and start" }));

    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: `run:${JOB_ID}` }));
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/jobs");
    expect(posts).toHaveLength(2);
    const key = posts[0]!.headers.get(IDEMPOTENCY_HEADER);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(posts[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    expect(posts[1]!.body).toEqual({
      jobType: "DEV_ISSUE_TO_PR",
      projectId: PROJECT_ID,
      repositoryId: "101",
      issueNumber: 42,
      baseBranch: "develop",
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    });
  });

  it("rejects a budget over the contract's caps before sending, and says queued runs are held", async () => {
    const calls = board(installed, { "GET /v1/repositories/101/issues/42": () => json(detail()) });
    mockRunners([runner({ status: "OFFLINE" })]);
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=issue:101:42`);
    await user.click(await screen.findByRole("button", { name: "Start run on test-host" }));
    const preview = screen.getByRole("region", { name: "Here’s exactly what will happen." });
    expect(
      within(preview).getByText(/test-host is offline\. The run will be queued and held, not lost/),
    ).toBeTruthy();

    const minutes = within(preview).getByLabelText("Time limit (minutes)");
    await user.clear(minutes);
    await user.type(minutes, "121");
    const cost = within(preview).getByLabelText("Model cost cap (USD)");
    await user.clear(cost);
    await user.type(cost, "50.5");
    expect(minutes.getAttribute("aria-invalid")).toBe("true");
    expect(within(preview).getByText("Enter whole minutes from 5 to 120.")).toBeTruthy();
    expect(within(preview).getByText("Enter an amount above $0 and at most $50.")).toBeTruthy();

    await user.click(within(preview).getByRole("button", { name: "Confirm and start" }));
    expect(document.activeElement).toBe(minutes);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("warns when the issue has no acceptance criteria", async () => {
    board(installed, {
      "GET /v1/repositories/101/issues/42": () =>
        json(detail({ acceptanceCriteria: [], missingAcceptanceCriteria: true })),
    });
    renderApp(`${IN_PROJECT}&drawer=issue:101:42`);
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/Missing acceptance criteria.*found no acceptance criteria/);
    expect(screen.getByText(/Issue · needs info/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Acceptance criteria · extracted" })).toBeNull();
  });

  it("goes back to the repository's issue list", async () => {
    board(installed, {
      "GET /v1/repositories/101/issues/42": () => json(detail()),
      "GET /v1/repositories/101/issues": () =>
        json({ items: [issue(42)], page: 1, nextPage: null, syncedAt: SYNCED }),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=issue:101:42&state=closed`);
    await user.click(await screen.findByRole("button", { name: /acme\/web issues/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ drawer: "repo:101", state: "closed" }),
    );
    expect(await screen.findByRole("list", { name: "Issues" })).toBeTruthy();
  });
});

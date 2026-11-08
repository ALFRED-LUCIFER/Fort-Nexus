import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  GithubStatus,
  Repository,
  RepositoryDetails,
  RepositoryHealth,
  SetupStatus,
  SetupStep,
} from "@nexus/contracts";
import {
  BIZ_WORKSPACE_ID,
  FakeEventSource,
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
} from "../test/helpers.tsx";

// FR-GH-05 repository health and details, the Home setup checklist, and the "Dev only" workspace setting.

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
const SHA = "b".repeat(40);

const installed: GithubStatus = {
  configured: true,
  appSlug: "nexus-test",
  installUrl: "https://github.com/apps/nexus-test/installations/new",
  syncedAt: NOW,
  installations: [
    {
      id: 1,
      account: { login: "acme", type: "Organization" },
      repositorySelection: "selected",
      suspended: false,
      permissions: { pull_requests: "write" },
    },
  ],
};

const repo = (id: string, fullName: string, pushedAt = DAY_AGO): Repository => ({
  id,
  fullName,
  owner: fullName.split("/")[0]!,
  name: fullName.split("/")[1]!,
  private: true,
  defaultBranch: "main",
  htmlUrl: `https://github.com/${fullName}`,
  pushedAt,
  updatedAt: pushedAt,
  installationId: 1,
});
const health = (r: Repository, over: Partial<RepositoryHealth> = {}): RepositoryHealth => ({
  repository: r,
  archived: false,
  openPullRequests: 0,
  draftPullRequests: 0,
  pullRequestsMore: false,
  openIssues: 0,
  ci: { state: "PASSING", sha: SHA, total: 1, failing: [], completedAt: NOW },
  error: null,
  syncedAt: NOW,
  ...over,
});

const QUIET = repo("101", "acme/quiet", HOUR_AGO);
const PRS = repo("102", "acme/prs");
const BROKEN = repo("103", "acme/broken");
const OLD = repo("104", "acme/old");
const HEALTH: RepositoryHealth[] = [
  health(QUIET, { openIssues: 2 }),
  health(PRS, { openPullRequests: 3, draftPullRequests: 1, openIssues: 5 }),
  health(BROKEN, {
    ci: { state: "FAILING", sha: SHA, total: 3, failing: ["test", "e2e"], completedAt: NOW },
  }),
  health(OLD, {
    archived: true,
    ci: { state: "FAILING", sha: SHA, total: 1, failing: ["x"], completedAt: NOW },
  }),
];

const details = (over: Partial<RepositoryDetails> = {}): RepositoryDetails => ({
  repository: BROKEN,
  archived: false,
  openIssues: 1,
  pullRequests: [
    {
      number: 12,
      title: "Fix cart totals",
      draft: true,
      author: "octo",
      headBranch: "nexus/issue-42-x",
      baseBranch: "main",
      nexus: true,
      updatedAt: NOW,
      htmlUrl: "https://github.com/acme/broken/pull/12",
    },
  ],
  pullRequestsMore: false,
  branches: [
    { name: "main", protected: true, default: true, nexus: false },
    { name: "nexus/issue-42-x", protected: false, default: false, nexus: true },
  ],
  branchesMore: false,
  ci: { state: "FAILING", sha: SHA, total: 2, failing: ["test"], completedAt: NOW },
  checks: [
    {
      name: "test",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.com/acme/broken/runs/1",
    },
    { name: "lint", status: "completed", conclusion: "success", htmlUrl: null },
  ],
  syncedAt: NOW,
  ...over,
});

const step = (
  key: SetupStep["key"],
  done: boolean,
  detail: string,
  over: Partial<SetupStep> = {},
): SetupStep => ({
  key,
  done,
  optional: key === "WEB_SEARCH" || key === "CLAUDE_CLOUD",
  detail,
  runbook: null,
  ...over,
});
const NOT_READY: SetupStatus = {
  ready: false,
  checkedAt: NOW,
  steps: [
    step("GITHUB", true, "The NEXUS GitHub App is installed on acme."),
    step("REPOSITORIES", false, "No repositories are bound to Home yet. Bind some in Settings → Workspaces."),
    step("AI_PROVIDER", false, "NEXUS needs an AI provider for this.", {
      runbook: "docs/runbooks/ai-provider.md",
    }),
    step("RUNNER", true, "Runner test-host is online."),
    step("WEB_SEARCH", false, "Web search isn't set up.", { runbook: "docs/runbooks/web-search.md" }),
    step("CLAUDE_CLOUD", false, "No routine in ~/.nexus/claude-cloud.json yet.", {
      runbook: "docs/runbooks/claude-cloud.md",
    }),
  ],
};

function app(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/github/status": () => json(installed),
    "GET /v1/repositories": () => json({ items: [QUIET, PRS, BROKEN, OLD], syncedAt: NOW }),
    "GET /v1/repositories/health": () => json({ items: HEALTH }),
    "GET /v1/repositories/103/details": () => json(details()),
    "GET /v1/repositories/103/issues": () => json({ items: [], page: 1, nextPage: null, syncedAt: NOW }),
    ...extra,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("repositories drawer (FR-GH-05)", () => {
  it("lists the project's repositories, needs-attention first, with CI, PRs and issues in words", async () => {
    const calls = app();
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=repos`);
    const drawer = await screen.findByRole("dialog");
    const list = await within(drawer).findByRole("list", { name: "Repositories" });
    expect(calls.find((c) => c.path === "/v1/repositories/health")!.query.get("projectId")).toBe(PROJECT_ID);

    const rows = within(list).getAllByRole("button");
    // Failing CI, then PRs to review, then quiet by last push; archived last.
    expect(rows.map((r) => r.textContent?.match(/^acme\/[a-z]+?(?=main|archived)/)?.[0])).toEqual([
      "acme/broken",
      "acme/prs",
      "acme/quiet",
      "acme/old",
    ]);
    expect(rows[0]!.textContent).toMatch(/CI failing: test, e2e/);
    expect(rows[0]!.textContent).toMatch(/CI failing/);
    expect(rows[1]!.textContent).toMatch(/2 pull requests to review/);
    expect(rows[1]!.textContent).toMatch(/3 PRs \(1 draft\)/);
    expect(rows[1]!.textContent).toMatch(/5 issues/);
    expect(rows[3]!.textContent).toMatch(/archived/);
    expect(
      within(drawer).getByText(/4 repositories · 1 CI failing · 3 open PRs · 7 open issues/),
    ).toBeTruthy();

    await user.click(within(drawer).getByRole("button", { name: "Needs you (2)" }));
    expect(
      within(within(drawer).getByRole("list", { name: "Repositories" })).getAllByRole("button"),
    ).toHaveLength(2);
    await user.click(within(drawer).getByRole("button", { name: "All (4)" }));
    await user.type(within(drawer).getByLabelText("Find a repository"), "qui");
    const found = within(within(drawer).getByRole("list", { name: "Repositories" })).getAllByRole("button");
    expect(found).toHaveLength(1);
    await user.click(found[0]!);
    expect(router.state.location.search).toMatchObject({ drawer: "repo:101", project: PROJECT_ID });
  });

  it("with nothing chosen yet, says so and opens the picker", async () => {
    app({ "GET /v1/repositories/health": () => json({ items: [] }) });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=repos`);
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByText(/haven't chosen the repositories you work on in Home/),
    ).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: "Choose repositories" }));
    expect(router.state.location.search).toMatchObject({ drawer: "repos:choose", project: PROJECT_ID });
    expect(await screen.findByRole("heading", { name: "Choose your repositories" })).toBeTruthy();
  });

  it("shows GitHub's error instead of an empty list", async () => {
    app({
      "GET /v1/repositories/health": () =>
        json(
          { error: { code: "INTERNAL", message: "GitHub is unavailable right now." }, requestId: "r" },
          502,
        ),
    });
    renderApp(`${IN_PROJECT}&drawer=repos`);
    const drawer = await screen.findByRole("dialog");
    expect((await within(drawer).findByRole("alert")).textContent).toBe("GitHub is unavailable right now.");
  });
});

describe("choosing the repositories you work on", () => {
  it("lists every installed repository, the chosen ones checked; a click binds it to the project", async () => {
    const calls = app({
      [`PUT /v1/projects/${PROJECT_ID}/repositories/103`]: () =>
        json(project({ repositoryIds: ["101", "103"] })),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=repos:choose`);
    const drawer = await screen.findByRole("dialog");
    const picker = await within(drawer).findByRole("region", {
      name: /Repositories you work on in Home · 1 of 4/,
    });
    expect(within(within(picker).getByRole("list", { name: "Chosen" })).getByText("acme/quiet")).toBeTruthy();
    const boxes = within(picker).getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, false, false]);

    await user.type(within(picker).getByLabelText("Find a repository"), "brok");
    await user.click(within(picker).getByRole("checkbox", { name: "acme/broken" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/repositories/103"))).toBe(true),
    );
    await user.click(within(picker).getByRole("button", { name: /^Done · show my/ }));
    expect(router.state.location.search).toMatchObject({ drawer: "repos" });
  });

  it("in the All view, asks to pick a project first", async () => {
    app();
    renderApp("/?drawer=repos:choose");
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText(/chosen per project/)).toBeTruthy();
  });
});

describe("repo drawer details (FR-GH-05)", () => {
  it("shows CI with failing checks first, open PRs with their NEXUS origin, and branches", async () => {
    app();
    renderApp(`${IN_PROJECT}&drawer=repo:103`);
    const drawer = await screen.findByRole("dialog");
    const ci = await within(drawer).findByRole("region", { name: /CI · main/ });
    expect(within(ci).getByText("CI failing")).toBeTruthy();
    const checks = within(within(ci).getByRole("list", { name: "Checks" })).getAllByRole("listitem");
    expect(checks.map((c) => c.textContent)).toEqual([
      "testfailurelog (opens GitHub in a new tab)",
      "lintsuccess",
    ]);
    const prs = within(drawer).getByRole("region", { name: /Open pull requests · 1 · 1 open issue/ });
    expect(within(prs).getByText(/draft · opened by a NEXUS run · nexus\/issue-42-x → main/)).toBeTruthy();
    const link = within(prs).getByRole("link", { name: /#12/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/broken/pull/12");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const branches = within(drawer).getByRole("region", { name: /Branches · 2/ });
    expect(
      within(branches)
        .getAllByRole("listitem")
        .map((b) => b.textContent),
    ).toEqual(["main · default · protected", "nexus/issue-42-x · NEXUS"]);
  });
});

describe("Home: setup checklist and repositories", () => {
  const home = (extra: Parameters<typeof mockFetch>[0] = {}) =>
    app({
      "GET /v1/research/opportunities": () => json({ items: [] }),
      "GET /v1/setup": () => json(NOT_READY),
      ...extra,
    });

  it("lists what NEXUS still needs, in words, with the way to do it", async () => {
    const calls = home();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    const setup = await screen.findByRole("region", { name: "Before NEXUS can work" });
    expect(calls.find((c) => c.path === "/v1/setup")!.query.get("projectId")).toBe(PROJECT_ID);
    expect(within(setup).getByText("2 of 4 done · checked live")).toBeTruthy();
    const items = within(within(setup).getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent?.match(/^(✓ Done|To do|Optional)/)?.[0])).toEqual([
      "✓ Done",
      "To do",
      "To do",
      "✓ Done",
      "Optional",
      "Optional",
    ]);
    expect(within(items[2]!).getByText("docs/runbooks/ai-provider.md")).toBeTruthy();
    expect(within(items[5]!).getByText("Claude cloud handoff")).toBeTruthy();
    expect(within(items[5]!).getByText("docs/runbooks/claude-cloud.md")).toBeTruthy();
    await user.click(within(items[1]!).getByRole("button", { name: "Choose repositories" }));
    expect(router.state.location.search).toMatchObject({ drawer: "repos:choose" });
  });

  it("goes away once NEXUS is ready", async () => {
    home({ "GET /v1/setup": () => json({ ...NOT_READY, ready: true }) });
    renderApp(IN_PROJECT, { view: "home" });
    await screen.findByRole("region", { name: "Your repositories · Home" });
    expect(screen.queryByRole("region", { name: "Before NEXUS can work" })).toBeNull();
  });

  it("in a project, shows every chosen repository, the ones that need the owner first", async () => {
    home();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT, { view: "home" });
    const section = await screen.findByRole("region", { name: "Your repositories · Home" });
    const rows = within(await within(section).findByRole("list", { name: "Your repositories" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent?.match(/^acme\/[a-z]+?(?=main|archived)/)?.[0])).toEqual([
      "acme/broken",
      "acme/prs",
      "acme/quiet",
      "acme/old",
    ]);
    await user.click(within(section).getByRole("button", { name: "Choose repositories" }));
    expect(router.state.location.search).toMatchObject({ drawer: "repos:choose" });
  });

  it("in All, shows only what needs the owner and opens the full list", async () => {
    home();
    const user = userEvent.setup();
    const { router } = renderApp("/", { view: "home" });
    const section = await screen.findByRole("region", { name: "Repositories · all installed" });
    const rows = within(
      await within(section).findByRole("list", { name: "Repositories needing attention" }),
    ).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.match(/^acme\/[a-z]+?(?=main|archived)/)?.[0])).toEqual([
      "acme/broken",
      "acme/prs",
    ]);
    await user.click(within(section).getByRole("button", { name: "All 4 repositories" }));
    expect(router.state.location.search).toMatchObject({ drawer: "repos" });
  });

  it("in All, says when every repository is quiet", async () => {
    home({ "GET /v1/repositories/health": () => json({ items: [health(QUIET)] }) });
    renderApp("/", { view: "home" });
    const section = await screen.findByRole("region", { name: "Repositories · all installed" });
    expect(await within(section).findByText(/All 1 repository are quiet/)).toBeTruthy();
  });
});

describe("Dev only (Settings → Workspaces)", () => {
  const devOnly = workspaces([project()], [], false);

  it("hides the Business switch, zone and agents, and opens on Dev without ws in the URL", async () => {
    app({
      "GET /v1/workspaces": () => json(devOnly),
      "GET /v1/agents": () => json({ items: [] }),
    });
    const { router } = renderApp("/");
    await screen.findByRole("region", { name: "Code" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Workspace" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Business" })).toBeNull();
    const scope = screen.getByRole("navigation", { name: "Scope" });
    expect(within(scope).getByText("Dev")).toBeTruthy();
    // One Dev project: the board opens on it, so it can act.
    await waitFor(() => expect(router.state.location.search).toMatchObject({ project: PROJECT_ID }));
    expect(router.state.location.search.ws).toBeUndefined();
  });

  it("a hidden workspace in the URL shows Dev instead", async () => {
    app({ "GET /v1/workspaces": () => json(devOnly), "GET /v1/agents": () => json({ items: [] }) });
    renderApp("/?ws=business");
    await screen.findByRole("region", { name: "Code" });
    expect(await within(screen.getByRole("navigation", { name: "Scope" })).findByText("Dev")).toBeTruthy();
  });

  it("the switch hides Business (audited by the API) and can't hide the last shown workspace", async () => {
    const calls = app({
      "GET /v1/agents": () => json({ items: [] }),
      [`PATCH /v1/workspaces/${BIZ_WORKSPACE_ID}`]: () => json({ ...devOnly.items[1] }),
    });
    const user = userEvent.setup();
    renderApp("/?drawer=settings#ws");
    const settings = await screen.findByRole("dialog");
    const biz = await within(settings).findByRole("switch", { name: "Show Business: on" });
    expect(biz.getAttribute("aria-checked")).toBe("true");
    await user.click(biz);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        path: `/v1/workspaces/${BIZ_WORKSPACE_ID}`,
        body: { enabled: false },
      }),
    );
  });

  it("with Business hidden, Dev's switch is off-limits and says why", async () => {
    app({ "GET /v1/workspaces": () => json(devOnly), "GET /v1/agents": () => json({ items: [] }) });
    renderApp("/?drawer=settings#ws");
    const settings = await screen.findByRole("dialog");
    const dev = await within(settings).findByRole("switch", { name: "Show Dev: on" });
    expect((dev as HTMLButtonElement).disabled).toBe(true);
    expect(within(settings).getByText(/The only workspace shown/)).toBeTruthy();
    expect(
      within(settings).getByRole("switch", { name: "Show Business: off" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

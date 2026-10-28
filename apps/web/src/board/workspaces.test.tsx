import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Approval, GithubStatus, Project, Repository } from "@nexus/contracts";
import {
  BIZ_PROJECT_ID,
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  WORKSPACES,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
} from "../test/helpers.tsx";

const SYNCED = new Date().toISOString();
const installed: GithubStatus = {
  configured: true,
  appSlug: "nexus-test",
  installUrl: "https://github.com/apps/nexus-test/installations/new",
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
  owner: "acme",
  name: fullName.split("/")[1]!,
  private: true,
  defaultBranch: "main",
  htmlUrl: `https://github.com/${fullName}`,
  pushedAt: SYNCED,
  updatedAt: SYNCED,
  installationId: 1,
});
const REPOS = [repo("101", "acme/web"), repo("102", "acme/api")];
const APPROVAL: Approval = {
  id: "44444444-4444-4444-8444-444444444444",
  jobId: JOB_ID,
  projectId: PROJECT_ID,
  riskTier: "R2",
  status: "PENDING",
  action: {
    type: "github.push_draft_pr",
    repositoryId: "101",
    repositoryFullName: "acme/web",
    issueNumber: 42,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headBranch: "nexus/issue-42-22222222",
    title: "#42: Cart totals",
    body: "Refs #42",
    changesetSha256: "b".repeat(64),
    files: [{ path: "src/a.ts", change: "modified" }],
    stats: { added: 1, removed: 1 },
    verification: {
      status: "passed",
      reason: null,
      source: "package.json",
      install: null,
      test: ["npm", "test"],
      exitCode: 0,
      durationMs: 1000,
      outputTail: "ok",
    },
  },
  actionHash: "c".repeat(64),
  createdAt: SYNCED,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
};

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json(installed),
    // The API filters by project: a project only gets its bound repositories.
    "GET /v1/repositories": (c) =>
      json({
        items: c.query.get("projectId") === PROJECT_ID ? [REPOS[0]] : c.query.get("projectId") ? [] : REPOS,
        syncedAt: SYNCED,
      }),
    "GET /v1/approvals": (c) =>
      json({ items: !c.query.get("projectId") || c.query.get("projectId") === PROJECT_ID ? [APPROVAL] : [] }),
    ...extra,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("workspace switch and project menu", () => {
  it("picks a project from the SCOPE menu, with the design's warning, and keeps it in the URL", async () => {
    board();
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const scope = await screen.findByRole("navigation", { name: "Scope" });
    expect(scope.textContent).toMatch(/All workspaces.*cross-project ▾.*read-only/);

    const button = within(scope).getByRole("button", { name: /^Project: cross-project/ });
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(scope).getByText(
        "switching re-binds connectors and agent profile · the other project’s data leaves this session",
      ),
    ).toBeTruthy();
    const menu = within(scope).getByRole("list", { name: "Projects" });
    expect(
      within(menu)
        .getByRole("button", { name: /All workspaces/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(within(menu).getByRole("button", { name: /Shop/ }).textContent).toMatch(/no sources connected/);
    await user.keyboard("{Escape}");
    expect(within(scope).queryByRole("list", { name: "Projects" })).toBeNull();
    expect(document.activeElement).toBe(button);

    await user.click(button);
    await user.click(within(scope).getByRole("button", { name: /Home.*1 repository bound/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ws: "dev", project: PROJECT_ID }));
    expect(scope.textContent).toMatch(/Dev.*Home ▾.*home runner/);

    // The workspace switch clears the project: Dev without a project is read-only again.
    await user.click(screen.getByRole("button", { name: "Business" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ws: "business" }));
    expect(scope.textContent).toMatch(/Business.*all products ▾/);
  });

  it("filters runs, approvals and repositories by the selected project", async () => {
    const calls = board();
    renderApp(IN_PROJECT);
    await screen.findByRole("button", { name: /^Inbox, 1 pending approval\b/ });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/repositories")).toBe(true));
    // The held-jobs count of the offline banner is about the runner, so it stays owner-wide (status=QUEUED).
    const reads = (path: string) => calls.filter((c) => c.path === path && !c.query.has("limit", "100"));
    // Lists wait for the project to resolve: nothing is ever fetched for another scope first.
    for (const path of ["/v1/jobs", "/v1/approvals", "/v1/repositories"])
      expect(
        reads(path).every((c) => c.query.get("projectId") === PROJECT_ID),
        path,
      ).toBe(true);
    const code = screen.getByRole("region", { name: "Code" });
    expect(await within(code).findByText("acme/web")).toBeTruthy();
    expect(within(code).queryByText("acme/api")).toBeNull();
  });

  it("shows the decoy project's own empty state, never another project's data", async () => {
    board();
    renderApp(`/?ws=dev&project=${OTHER_PROJECT_ID}`);
    const code = await screen.findByRole("region", { name: "Code" });
    expect(
      await within(code).findByText(
        "No repositories are bound to Decoy yet. Bind some in Settings → Workspaces.",
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Inbox, 0 pending approvals/ })).toBeTruthy();
  });

  it("gives a Business project its own empty connector list and nothing to run", async () => {
    const calls = board({
      "GET /v1/business/connectors": (c) =>
        json({ items: c.query.get("projectId") === BIZ_PROJECT_ID ? [] : [{ id: "not-this-project" }] }),
    });
    const user = userEvent.setup();
    renderApp(`/?ws=business&project=${BIZ_PROJECT_ID}`);
    const biz = await screen.findByRole("region", { name: "Business" });
    expect(await within(biz).findByText(/^No sources connected to Shop\./)).toBeTruthy();
    expect(
      calls
        .filter((c) => c.path === "/v1/business/connectors")
        .every((c) => c.query.get("projectId") === BIZ_PROJECT_ID),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "Execute preview" });
    expect(within(preview).getByRole("button", { name: /Queue/ }).hasAttribute("disabled")).toBe(true);
    expect(within(preview).getByText(/Shop is a Business project/)).toBeTruthy();
  });
});

describe("All is read-only", () => {
  it("disables Execute, Start run and Approve with 'pick a project first'", async () => {
    const calls = board({
      "GET /v1/repositories/101/issues/42": () =>
        json({
          issue: {
            number: 42,
            title: "Cart totals",
            state: "open",
            labels: [],
            assignees: [],
            milestone: null,
            author: "reporter",
            comments: 0,
            createdAt: SYNCED,
            updatedAt: SYNCED,
            htmlUrl: "https://github.com/acme/web/issues/42",
          },
          body: "",
          comments: [],
          acceptanceCriteria: [],
          missingAcceptanceCriteria: true,
          syncedAt: SYNCED,
        }),
    });
    const user = userEvent.setup();
    const { router } = renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "Execute preview" });
    const queue = within(preview).getByRole("button", { name: "Queue on test-host" });
    expect(queue.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(queue.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /^Pick a project first/,
    );
    await user.click(within(preview).getByRole("button", { name: "Adjust" }));

    await user.click(screen.getByRole("button", { name: /^Inbox, 1 pending approval\b/ }));
    const inbox = await screen.findByRole("dialog");
    const approve = await within(inbox).findByRole("button", { name: /^Approve/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(within(inbox).getByRole("button", { name: /^Deny/ }).hasAttribute("disabled")).toBe(true);
    expect(within(inbox).getByText(/^Pick a project first/)).toBeTruthy();

    await router.navigate({ to: "/", search: { drawer: "issue:101:42" } });
    const start = await screen.findByRole("button", { name: "Start run on test-host" });
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/^Pick a project first/)).toBeTruthy();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("an approval of another project can't be decided from this one", async () => {
    board({ "GET /v1/approvals": () => json({ items: [{ ...APPROVAL, projectId: OTHER_PROJECT_ID }] }) });
    renderApp(`${IN_PROJECT}&drawer=inbox`);
    const inbox = await screen.findByRole("dialog");
    expect((await within(inbox).findByRole("button", { name: /^Approve/ })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(within(inbox).getByText(/belongs to another project/)).toBeTruthy();
  });

  it("refuses to start a run on a repository the project hasn't bound", async () => {
    board({
      "GET /v1/repositories/102/issues/7": () =>
        json({
          issue: {
            number: 7,
            title: "Speed",
            state: "open",
            labels: [],
            assignees: [],
            milestone: null,
            author: "reporter",
            comments: 0,
            createdAt: SYNCED,
            updatedAt: SYNCED,
            htmlUrl: "https://github.com/acme/api/issues/7",
          },
          body: "",
          comments: [],
          acceptanceCriteria: [],
          missingAcceptanceCriteria: true,
          syncedAt: SYNCED,
        }),
    });
    renderApp(`${IN_PROJECT}&drawer=issue:102:7`);
    const start = await screen.findByRole("button", { name: "Start run on test-host" });
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(
      await screen.findByText("acme/api isn't bound to Home. Bind it in Settings → Workspaces."),
    ).toBeTruthy();
  });
});

describe("Settings → Workspaces", () => {
  it("creates a project, binds a repository, renames and archives", async () => {
    let state = WORKSPACES;
    const created = project({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slug: "my-shop-2",
      name: "My Shop 2",
    });
    const calls = board({
      "GET /v1/workspaces": () => json(state),
      [`POST /v1/workspaces/${WORKSPACES.items[0]!.id}/projects`]: () => {
        state = workspaces([...WORKSPACES.items[0]!.projects, created], WORKSPACES.items[1]!.projects);
        return json(created, 201);
      },
      [`PUT /v1/projects/${OTHER_PROJECT_ID}/repositories/102`]: () => json(project()),
      [`PATCH /v1/projects/${OTHER_PROJECT_ID}`]: (c) =>
        json({ ...project(), ...(c.body as Partial<Project>) }),
    });
    const user = userEvent.setup();
    renderApp("/?drawer=settings");
    await user.click(await screen.findByRole("button", { name: "Workspaces" }));

    const form = await screen.findByRole("form", { name: "New Dev project" });
    await user.click(within(form).getByRole("button", { name: "Create project" }));
    expect(within(form).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    await user.type(within(form).getByLabelText("Name"), "My Shop 2");
    expect((within(form).getByLabelText("Slug") as HTMLInputElement).value).toBe("my-shop-2");
    await user.click(within(form).getByRole("button", { name: "Create project" }));
    expect(await within(form).findByText("Created My Shop 2.")).toBeTruthy();
    expect(await screen.findByText("My Shop 2")).toBeTruthy();

    const dev = screen.getByRole("list", { name: "Dev projects" });
    const decoy = within(dev).getByText("Decoy").closest("li")!;
    await user.click(within(decoy).getByRole("checkbox", { name: "acme/api" }));
    await user.click(within(decoy).getByRole("button", { name: "Rename Decoy" }));
    const name = within(decoy).getByLabelText("New name for Decoy");
    await user.clear(name);
    await user.type(name, "Decoy 2{Enter}");
    await user.click(within(decoy).getByRole("button", { name: "Archive Decoy" }));

    await waitFor(() => expect(calls.filter((c) => c.method !== "GET")).toHaveLength(4));
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body])).toEqual([
      [
        "POST",
        `/v1/workspaces/${WORKSPACES.items[0]!.id}/projects`,
        { name: "My Shop 2", slug: "my-shop-2" },
      ],
      ["PUT", `/v1/projects/${OTHER_PROJECT_ID}/repositories/102`, null],
      ["PATCH", `/v1/projects/${OTHER_PROJECT_ID}`, { name: "Decoy 2" }],
      ["PATCH", `/v1/projects/${OTHER_PROJECT_ID}`, { archived: true }],
    ]);
  });
});

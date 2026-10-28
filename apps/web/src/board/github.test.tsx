import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GITHUB_SETUP_COMMAND,
  type GithubStatus,
  type Issue,
  type IssueDetail,
  type Repository,
} from "@nexus/contracts";
import { FakeEventSource, ME, json, mockFetch, renderApp, runner } from "../test/helpers.tsx";

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

function board(status: GithubStatus, extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json(status),
    "GET /v1/repositories": () => json({ items: REPOS, syncedAt: SYNCED }),
    ...extra,
  });
}

const codeZone = async () => screen.findByRole("region", { name: "Code" });

beforeEach(() => {
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
  it("shows the plain-text body, extracted criteria and ENG-07 buttons that do nothing yet", async () => {
    const calls = board(installed, { "GET /v1/repositories/101/issues/42": () => json(detail()) });
    const user = userEvent.setup();
    renderApp("/?drawer=issue:101:42");
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("heading", { name: "#42 Cart totals round wrong" })).toBeTruthy();
    expect(within(drawer).getByText(/Issue · ready · acme\/web/)).toBeTruthy();

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

    for (const name of ["Plan only", "Start run on test-host"]) {
      const btn = within(drawer).getByRole("button", { name });
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(btn.getAttribute("aria-describedby")!)?.textContent).toMatch(
        /arrives with ENG-07/,
      );
      await user.click(btn);
    }
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("warns when the issue has no acceptance criteria", async () => {
    board(installed, {
      "GET /v1/repositories/101/issues/42": () =>
        json(detail({ acceptanceCriteria: [], missingAcceptanceCriteria: true })),
    });
    renderApp("/?drawer=issue:101:42");
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
    const { router } = renderApp("/?drawer=issue:101:42&state=closed");
    await user.click(await screen.findByRole("button", { name: /acme\/web issues/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ drawer: "repo:101", state: "closed" }),
    );
    expect(await screen.findByRole("list", { name: "Issues" })).toBeTruthy();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  type GithubStatus,
  type JobDraft,
  type JobDraftPreview,
  type Repository,
} from "@nexus/contracts";
import {
  BIZ_PROJECT_ID,
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const NOW = new Date().toISOString();
const DRAFT = "abababab-abab-4bab-8bab-abababababab";
const HASH = "c".repeat(64);
const RUNNER_ID = runner().id;
const IN_DRAFT = `${IN_PROJECT}&drawer=jobdraft:${DRAFT}`;

const github: GithubStatus = {
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
  pushedAt: null,
  updatedAt: null,
  installationId: 1,
});

const draft = (over: Partial<JobDraft> = {}): JobDraft => ({
  id: DRAFT,
  projectId: PROJECT_ID,
  status: "READY",
  text: "add CSV export of orders in acme/web",
  kind: "NEW_ISSUE",
  repository: { id: "101", fullName: "acme/web" },
  candidates: [],
  issue: { title: "Add CSV export of orders", body: "Export orders.\n\n## Acceptance criteria\n- [ ] CSV" },
  issueNumber: null,
  budget: { maxWallClockMinutes: 45, maxTurns: 40, maxCostUsd: 5 },
  unsupportedReason: null,
  createdIssue: null,
  jobId: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const preview = (over: Partial<JobDraftPreview> = {}): JobDraftPreview => ({
  draftId: DRAFT,
  riskTier: "R2",
  rows: [
    { k: "Creates issue", v: "Add CSV export of orders · in acme/web" },
    { k: "Won't do", v: "push, open a PR or merge without your separate approval" },
  ],
  actionHash: HASH,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  ...over,
});

const STARTED = draft({
  status: "STARTED",
  kind: "EXISTING_ISSUE",
  issueNumber: 7,
  createdIssue: { number: 7, url: "https://github.com/acme/web/issues/7" },
  jobId: JOB_ID,
});

function board(handlers: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(job()),
    "GET /v1/github/status": () => json(github),
    "GET /v1/repositories": () => json({ items: [repo("101", "acme/web")], syncedAt: NOW }),
    "GET /v1/job-drafts": () => json({ items: [], nextCursor: null }),
    ...handlers,
  });
}

/** A server whose draft changes with each write, like the real one. */
function server(initial: JobDraft, handlers: Parameters<typeof mockFetch>[0] = {}) {
  const state = { current: initial };
  const calls = board({
    [`GET /v1/job-drafts/${DRAFT}`]: () => json(state.current),
    ...handlers,
  });
  return { state, calls };
}

const drawer = () => screen.findByRole("dialog");
const posts = (calls: ReturnType<typeof mockFetch>, path: string) =>
  calls.filter((c) => c.method !== "GET" && c.path === path);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("New job", () => {
  it("drafts from plain words with the chosen repository; a retry reuses its Idempotency-Key", async () => {
    let down = true;
    const calls = board({
      "POST /v1/job-drafts": () =>
        down ? apiError(429, "RATE_LIMITED", "The model is busy, try again.") : json(draft(), 201),
      [`GET /v1/job-drafts/${DRAFT}`]: () => json(draft()),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=newjob`);
    const d = await drawer();
    const text = within(d).getByRole("textbox", { name: "Describe the job in plain words" });
    await waitFor(() => expect(document.activeElement).toBe(text));
    await user.type(text, "add CSV export of orders");
    await user.selectOptions(await within(d).findByLabelText("Repository (optional)"), "101");
    await user.click(within(d).getByRole("button", { name: "Draft it" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("The model is busy, try again.");

    down = false;
    await user.click(within(d).getByRole("button", { name: "Draft it" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        ws: "dev",
        project: PROJECT_ID,
        drawer: `jobdraft:${DRAFT}`,
      }),
    );
    expect(await screen.findByText("AI-drafted · review before approving")).toBeTruthy();
    const creates = posts(calls, "/v1/job-drafts");
    expect(creates.map((c) => c.body)).toEqual([
      { projectId: PROJECT_ID, text: "add CSV export of orders", repositoryId: "101" },
      { projectId: PROJECT_ID, text: "add CSV export of orders", repositoryId: "101" },
    ]);
    const key = creates[0]!.headers.get(IDEMPOTENCY_HEADER);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(creates[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
  });

  it("says what's missing for empty text and sends nothing", async () => {
    const calls = board();
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=newjob`);
    const d = await drawer();
    await user.click(within(d).getByRole("button", { name: "Draft it" }));
    const text = within(d).getByRole("textbox", { name: "Describe the job in plain words" });
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(text.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /^Describe the job first/,
    );
    expect(document.activeElement).toBe(text);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it.each([
    ["the All view", "/?drawer=newjob", /^Pick a project first/],
    ["a Business project", `/?ws=business&project=${BIZ_PROJECT_ID}&drawer=newjob`, /is a Business project/],
    [
      "a project without repositories",
      `/?ws=dev&project=${OTHER_PROJECT_ID}&drawer=newjob`,
      /^No repositories are bound to Decoy/,
    ],
  ])("is blocked with the reason in %s", async (_, path, reason) => {
    const calls = board();
    const user = userEvent.setup();
    renderApp(path);
    const d = await drawer();
    await user.type(within(d).getByRole("textbox", { name: /Describe the job/ }), "fix the cart");
    const button = within(d).getByRole("button", { name: "Draft it" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toMatch(reason);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("lists the project's recent drafts with status as text; one opens its drawer", async () => {
    const calls = board({
      "GET /v1/job-drafts": () =>
        json({ items: [draft({ status: "NEEDS_REPO", repository: null })], nextCursor: null }),
      [`GET /v1/job-drafts/${DRAFT}`]: () =>
        json(draft({ status: "NEEDS_REPO", repository: null, candidates: [] })),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=newjob`);
    const list = await screen.findByRole("list", { name: "Recent drafts" });
    const item = within(list).getByRole("button", { name: /add CSV export of orders/ });
    expect(item.textContent).toMatch(/Needs a repository/);
    expect(calls.find((c) => c.path === "/v1/job-drafts")!.query.get("projectId")).toBe(PROJECT_ID);
    await user.click(item);
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`jobdraft:${DRAFT}`));
  });

  it("shows the empty and error states of the drafts list", async () => {
    board({ "GET /v1/job-drafts": () => apiError(403, "FORBIDDEN", "Drafts are unavailable.") });
    renderApp(`${IN_PROJECT}&drawer=newjob`);
    expect((await screen.findByRole("alert")).textContent).toBe("Drafts are unavailable.");
  });
});

describe("job draft drawer", () => {
  it("NEEDS_REPO asks which repository with a radio group and saves the choice", async () => {
    const candidates = [
      { id: "101", fullName: "acme/web" },
      { id: "102", fullName: "acme/api" },
    ];
    const { state, calls } = server(draft({ status: "NEEDS_REPO", repository: null, candidates }), {
      [`PATCH /v1/job-drafts/${DRAFT}`]: () => {
        state.current = draft({ repository: candidates[1]!, updatedAt: new Date().toISOString() });
        return json(state.current);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    const group = await within(d).findByRole("group", { name: "Which repository?" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    const use = within(d).getByRole("button", { name: "Use this repository" });
    expect(use.hasAttribute("disabled")).toBe(true);
    await user.click(within(group).getByRole("radio", { name: "acme/api" }));
    await user.click(use);

    const status = await within(d).findByRole("heading", { name: /Status: Ready/ });
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(posts(calls, `/v1/job-drafts/${DRAFT}`).map((c) => c.body)).toEqual([{ repositoryId: "102" }]);
  });

  it("UNSUPPORTED shows the AI-drafted reason; Rewrite returns to New job with the words", async () => {
    server(
      draft({
        status: "UNSUPPORTED",
        kind: null,
        repository: null,
        issue: null,
        text: "run rm -rf on the server",
        unsupportedReason: "That is a shell command, not a code change.",
      }),
    );
    const user = userEvent.setup();
    const { router } = renderApp(IN_DRAFT);
    const d = await drawer();
    expect(await within(d).findByText("That is a shell command, not a code change.")).toBeTruthy();
    expect(within(d).getByText(/^AI-drafted/)).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Rewrite" }));
    await waitFor(() => expect(router.state.location.search.drawer).toBe("newjob"));
    const text = await screen.findByRole("textbox", { name: "Describe the job in plain words" });
    expect((text as HTMLTextAreaElement).value).toBe("run rm -rf on the server");
  });

  it("approves only after a live preview, binding to its hash; Created #n comes from the server", async () => {
    const { state, calls } = server(draft(), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () => json(preview()),
      [`POST /v1/job-drafts/${DRAFT}/approve`]: () => {
        state.current = STARTED;
        return json(STARTED);
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_DRAFT);
    const d = await drawer();
    expect(
      await within(d).findByRole("heading", { name: "AI-drafted · review before approving" }),
    ).toBeTruthy();
    expect((within(d).getByLabelText("Issue title") as HTMLInputElement).value).toBe(
      "Add CSV export of orders",
    );
    expect(within(d).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(within(d).getByText(/^Preview first/)).toBeTruthy();
    expect(within(d).queryByText(/Created #/)).toBeNull();

    await user.click(within(d).getByRole("button", { name: "Preview" }));
    const heading = await within(d).findByRole("heading", { name: /Exactly what will happen · R2/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(within(d).getByText("push, open a PR or merge without your separate approval")).toBeTruthy();
    expect(within(d).getByText("cccccccc…cccc")).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Approve: create the issue and start the run" }));

    const link = await within(d).findByRole("link", { name: /Created #7 on acme\/web/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/issues/7");
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/preview`).map((c) => c.body)).toEqual([
      { runnerId: RUNNER_ID },
    ]);
    const approves = posts(calls, `/v1/job-drafts/${DRAFT}/approve`);
    expect(approves.map((c) => c.body)).toEqual([{ actionHash: HASH }]);
    expect(approves[0]!.headers.get(IDEMPOTENCY_HEADER)).toBe(`jobdraft:${DRAFT}:${HASH}`);
    expect(IdempotencyKey.safeParse(approves[0]!.headers.get(IDEMPOTENCY_HEADER)).success).toBe(true);
    expect(within(d).queryByRole("button", { name: "Discard draft" })).toBeNull();

    await user.click(within(d).getByRole("button", { name: "Open the run" }));
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`run:${JOB_ID}`));
  });

  it("an edit drops the preview; the next preview saves the edit first", async () => {
    const { state, calls } = server(draft(), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () => json(preview()),
      [`PATCH /v1/job-drafts/${DRAFT}`]: (c) => {
        const b = c.body as { title: string; budget?: JobDraft["budget"] };
        state.current = draft({
          issue: { ...state.current.issue!, title: b.title },
          updatedAt: new Date(Date.now() + 1000).toISOString(),
        });
        return json(state.current);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Preview" }));
    expect(await within(d).findByRole("button", { name: /^Approve/ })).toBeTruthy();

    await user.type(within(d).getByLabelText("Issue title"), " as a file");
    expect(within(d).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(within(d).queryByText("Exactly what will happen", { exact: false })).toBeNull();

    await user.click(within(d).getByRole("button", { name: "Preview" }));
    expect(await within(d).findByRole("button", { name: /^Approve/ })).toBeTruthy();
    expect(posts(calls, `/v1/job-drafts/${DRAFT}`).map((c) => c.body)).toEqual([
      { title: "Add CSV export of orders as a file" },
    ]);
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/preview`)).toHaveLength(2);
  });

  it("an invalid budget blocks the preview and focuses the field", async () => {
    const { calls } = server(draft());
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    const turns = await within(d).findByLabelText("Agent turns");
    await user.clear(turns);
    await user.type(turns, "500");
    await user.click(within(d).getByRole("button", { name: "Preview" }));
    expect(document.activeElement).toBe(turns);
    expect(turns.getAttribute("aria-invalid")).toBe("true");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("an expired preview can't be approved", async () => {
    server(draft(), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () =>
        json(preview({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Preview" }));
    const approve = await within(d).findByRole("button", { name: /^Approve/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /preview expired/,
    );
  });

  it("an existing issue is an R1 run, shown with its number and repository", async () => {
    server(draft({ kind: "EXISTING_ISSUE", issue: null, issueNumber: 42 }), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () => json(preview({ riskTier: "R1" })),
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    expect(await within(d).findByText("Existing issue #42")).toBeTruthy();
    expect(within(d).getByText("acme/web")).toBeTruthy();
    expect(within(d).queryByLabelText("Issue title")).toBeNull();
    await user.click(within(d).getByRole("button", { name: "Preview" }));
    expect(await within(d).findByRole("button", { name: "Approve: start the run" })).toBeTruthy();
  });

  it("FAILED after the issue was created previews again (now R1) and approves the new hash", async () => {
    const R1 = "d".repeat(64);
    let previews = 0;
    const failed = draft({
      status: "FAILED",
      kind: "EXISTING_ISSUE",
      issue: null,
      issueNumber: 7,
      error: "Today's budget is used up. Approve again to resume.",
      createdIssue: { number: 7, url: "https://github.com/acme/web/issues/7" },
    });
    const { state, calls } = server(draft(), {
      // Like the real server: once the issue exists, the draft's hash changes and the old preview is refused.
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () =>
        json(++previews === 1 ? preview() : preview({ riskTier: "R1", actionHash: R1 })),
      [`POST /v1/job-drafts/${DRAFT}/approve`]: (c) => {
        if ((c.body as { actionHash: string }).actionHash === HASH) {
          state.current = failed;
          return apiError(409, "BUDGET_EXHAUSTED", "Today's budget is used up.");
        }
        state.current = STARTED;
        return json(STARTED);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Preview" }));
    await user.click(await within(d).findByRole("button", { name: /^Approve/ }));

    expect(await within(d).findByText("Today's budget is used up. Approve again to resume.")).toBeTruthy();
    expect(within(d).getByRole("link", { name: /Created #7/ })).toBeTruthy();
    // The stale R2 preview is gone: Try again builds a fresh one instead of resending the refused hash.
    expect(within(d).queryByText(/Exactly what will happen · R2/)).toBeNull();
    await user.click(within(d).getByRole("button", { name: "Try again" }));
    expect(await within(d).findByRole("heading", { name: /Exactly what will happen · R1/ })).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Try again" }));
    expect(await within(d).findByRole("button", { name: "Open the run" })).toBeTruthy();

    expect(posts(calls, `/v1/job-drafts/${DRAFT}/approve`).map((c) => c.body)).toEqual([
      { actionHash: HASH },
      { actionHash: R1 },
    ]);
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/preview`)).toHaveLength(2);
  });

  it("an unreachable approve keeps the live preview; Try again resends the same hash and key", async () => {
    let attempt = 0;
    const { state, calls } = server(draft(), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () => json(preview()),
      [`POST /v1/job-drafts/${DRAFT}/approve`]: () => {
        if (++attempt === 1) {
          state.current = draft({ status: "FAILED", error: "NEXUS lost the connection." });
          throw new TypeError("Failed to fetch");
        }
        state.current = STARTED;
        return json(STARTED);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Preview" }));
    await user.click(await within(d).findByRole("button", { name: /^Approve/ }));
    await user.click(await within(d).findByRole("button", { name: "Try again" }));
    expect(await within(d).findByRole("button", { name: "Open the run" })).toBeTruthy();

    const approves = posts(calls, `/v1/job-drafts/${DRAFT}/approve`);
    expect(approves.map((c) => c.body)).toEqual([{ actionHash: HASH }, { actionHash: HASH }]);
    expect(new Set(approves.map((c) => c.headers.get(IDEMPOTENCY_HEADER))).size).toBe(1);
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/preview`)).toHaveLength(1);
  });

  it("FAILED without a live preview previews again before approving", async () => {
    const { calls } = server(draft({ status: "FAILED", error: "Budget exhausted for today." }), {
      [`POST /v1/job-drafts/${DRAFT}/preview`]: () => json(preview()),
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Try again" }));
    expect(await within(d).findByRole("button", { name: /^Approve/ })).toBeTruthy();
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/preview`)).toHaveLength(1);
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/approve`)).toHaveLength(0);
  });

  it("Discard leaves a read-only draft", async () => {
    const { state, calls } = server(draft(), {
      [`POST /v1/job-drafts/${DRAFT}/discard`]: () => {
        state.current = draft({ status: "DISCARDED" });
        return json(state.current);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_DRAFT);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Discard draft" }));
    expect(await within(d).findByText(/^Discarded\. Nothing more happens/)).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Preview" })).toBeNull();
    expect(posts(calls, `/v1/job-drafts/${DRAFT}/discard`)).toHaveLength(1);
  });

  it("a draft of another project is read-only here", async () => {
    const { calls } = server(draft({ projectId: OTHER_PROJECT_ID }));
    renderApp(IN_DRAFT);
    const d = await drawer();
    const previewBtn = await within(d).findByRole("button", { name: "Preview" });
    expect(previewBtn.hasAttribute("disabled")).toBe(true);
    expect(within(d).getByRole("button", { name: "Discard draft" }).hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(previewBtn.getAttribute("aria-describedby")!)?.textContent).toBe(
      "This draft belongs to another project: switch to it first.",
    );
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("shows the API's error when the draft can't be loaded", async () => {
    board({ [`GET /v1/job-drafts/${DRAFT}`]: () => apiError(404, "NOT_FOUND", "No such job draft.") });
    renderApp(IN_DRAFT);
    const d = await drawer();
    expect((await within(d).findByRole("alert")).textContent).toBe("No such job draft.");
  });
});

describe("command bar Execute", () => {
  it("with text drafts a job in the current project and opens its draft", async () => {
    const calls = board({
      "POST /v1/job-drafts": () => json(draft(), 201),
      [`GET /v1/job-drafts/${DRAFT}`]: () => json(draft()),
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    const command = await screen.findByRole("textbox", { name: "Command" });
    await user.type(command, "add CSV export of orders in acme/web");
    expect(screen.getByRole("button", { name: "Draft job" })).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`jobdraft:${DRAFT}`));
    expect(screen.queryByRole("region", { name: "Execute preview" })).toBeNull();
    const creates = posts(calls, "/v1/job-drafts");
    expect(creates.map((c) => c.body)).toEqual([
      { projectId: PROJECT_ID, text: "add CSV export of orders in acme/web" },
    ]);
    expect(posts(calls, "/v1/jobs")).toHaveLength(0);
    const hidden = screen.getByRole("textbox", { name: "Command", hidden: true }) as HTMLInputElement;
    expect(hidden.value).toBe("");
  });

  it("with text in the All view says to pick a project and sends nothing", async () => {
    const calls = board();
    const user = userEvent.setup();
    renderApp("/");
    await user.type(await screen.findByRole("textbox", { name: "Command" }), "fix the cart{Enter}");
    const panel = await screen.findByRole("region", { name: "Execute" });
    expect(within(panel).getByRole("status").textContent).toBe(PICK_PROJECT);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a failed draft shows the error, and Enter retries with the same key", async () => {
    let down = true;
    const calls = board({
      "POST /v1/job-drafts": () => {
        if (down) throw new TypeError("Failed to fetch");
        return json(draft(), 201);
      },
      [`GET /v1/job-drafts/${DRAFT}`]: () => json(draft()),
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    await user.type(await screen.findByRole("textbox", { name: "Command" }), "fix the cart{Enter}");
    const panel = await screen.findByRole("region", { name: "Execute" });
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/^Can't reach the NEXUS API/);
    down = false;
    await user.type(screen.getByRole("textbox", { name: "Command" }), "{Enter}");
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`jobdraft:${DRAFT}`));
    const creates = posts(calls, "/v1/job-drafts");
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((c) => c.headers.get(IDEMPOTENCY_HEADER))).size).toBe(1);
  });

  it("with no text keeps the runner diagnostic preview", async () => {
    board();
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    expect(screen.getByRole("region", { name: "Execute preview" })).toBeTruthy();
    expect(screen.getByText("Runner diagnostic")).toBeTruthy();
  });
});

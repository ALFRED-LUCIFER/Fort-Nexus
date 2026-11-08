import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import type { Job, JobHistoryItem } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  OTHER_PROJECT_ID,
  apiError,
  job,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
  type Call,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const NEW_JOB = "22222222-2222-4222-8222-222222222999";
const ORIGINAL = "22222222-2222-4222-8222-222222222111";
const RETRY = `POST /v1/jobs/${JOB_ID}/retry`;
const IN_RUN = `${IN_PROJECT}&drawer=run:${JOB_ID}`;
const QUEUED = { jobId: NEW_JOB, status: "QUEUED", streamUrl: `/v1/jobs/${NEW_JOB}/events` };
const STOP_MESSAGE = "Emergency stop is engaged: nothing new can start.";

const cancelled = (over: Partial<Job> = {}) => job({ status: "CANCELLED", ...over });

function board(j: Job, retry: (c: Call) => Response = () => json(QUEUED, 202)) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [j], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(j),
    [`GET /v1/jobs/${NEW_JOB}`]: () => json(job({ id: NEW_JOB, status: "QUEUED", retryOfJobId: JOB_ID })),
    [`GET /v1/jobs/${ORIGINAL}`]: () => json(job({ id: ORIGINAL, status: "CANCELLED" })),
    [RETRY]: retry,
  });
}

const retries = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/retry"));
const keysOf = (calls: Call[]) => retries(calls).map((c) => c.headers.get("idempotency-key"));
const button = () => screen.findByRole("button", { name: "Run again" });
const drawerOf = (router: { state: { location: { search: { drawer?: string } } } }) =>
  router.state.location.search.drawer;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  // jsdom has no layout; give the virtualized terminal a viewport.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(() => onlineManager.setOnline(true));

describe("run drawer: Run again", () => {
  it.each(["CANCELLED", "COMPLETED", "FAILED", "REJECTED", "EXPIRED"] as const)(
    "offers it on a %s job, without saying it has run",
    async (status) => {
      board(job({ status }));
      renderApp(IN_RUN);
      expect(await button()).toBeTruthy();
      expect(await screen.findByText("Queues a new run. It starts when a runner picks it up.")).toBeTruthy();
    },
  );

  it.each(["QUEUED", "RUNNING", "AWAITING_APPROVAL", "RECOVERY_REQUIRED"] as const)(
    "does not offer it on a %s job",
    async (status) => {
      board(job({ status, runnerId: runner().id }));
      renderApp(IN_RUN);
      await screen.findByRole("region", { name: "Run output" });
      expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    },
  );

  it("queues the rerun, opens the new job and refreshes the job lists", async () => {
    const calls = board(cancelled());
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.click(await button());

    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    expect(retries(calls)).toHaveLength(1);
    expect(retries(calls)[0]!.body).toBeNull();
    // The new job's drawer, which says it is queued, and links back.
    expect(await screen.findByRole("link", { name: `Rerun of ${JOB_ID.slice(0, 8)}` })).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/home").length).toBeGreaterThan(1),
    );
  });

  it("a double click sends one key", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [cancelled()], nextCursor: null }),
      [`GET /v1/jobs/${JOB_ID}`]: () => json(cancelled()),
      [`GET /v1/jobs/${NEW_JOB}`]: () => json(job({ id: NEW_JOB, status: "QUEUED" })),
      [RETRY]: async () => {
        await gate;
        return json(QUEUED, 202);
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.dblClick(await button());

    const pending = await screen.findByRole<HTMLButtonElement>("button", { name: "Queueing…" });
    expect(pending.disabled).toBe(true);
    expect(new Set(keysOf(calls)).size).toBe(1);
    release();
    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    expect(new Set(keysOf(calls)).size).toBe(1);
  });

  it("shows the server's refusal, and a retry reuses the key", async () => {
    let refuse = true;
    const calls = board(cancelled(), () =>
      refuse ? apiError(409, "EMERGENCY_STOP", STOP_MESSAGE) : json(QUEUED, 202),
    );
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.click(await button());

    expect((await screen.findByRole("alert")).textContent).toBe(STOP_MESSAGE);
    expect(drawerOf(router)).toBe(`run:${JOB_ID}`);

    refuse = false;
    await user.click(await button());
    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    const [first, second] = keysOf(calls);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("asks first when the run opened a pull request, saying a second one follows", async () => {
    const calls = board(cancelled({ status: "COMPLETED", outcome: "PR_CREATED" }));
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.click(await button());

    const dialog = await screen.findByRole("alertdialog", { name: "Open a second pull request?" });
    expect(dialog.textContent).toMatch(/opens a second pull request/);
    expect(retries(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Keep the first one only" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(retries(calls)).toHaveLength(0);

    await user.click(await button());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Queue a new run" }),
    );
    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    expect(retries(calls)).toHaveLength(1);
  });

  it("keeps the confirmation open with the error when the request fails, then reuses the key", async () => {
    let refuse = true;
    const calls = board(cancelled({ status: "COMPLETED", outcome: "PR_CREATED" }), () =>
      refuse ? apiError(409, "BUDGET_EXHAUSTED", "Today's budget is used up.") : json(QUEUED, 202),
    );
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.click(await button());
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Queue a new run" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Today's budget is used up.");
    refuse = false;
    await user.click(within(dialog).getByRole("button", { name: "Queue a new run" }));
    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    expect(new Set(keysOf(calls)).size).toBe(1);
    expect(retries(calls)).toHaveLength(2);
  });

  const describedReason = async (text: string | RegExp) => {
    const b = await button();
    await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(true));
    const note = await screen.findByText(text);
    expect(b.getAttribute("aria-describedby")).toBe(note.id);
  };

  it("is disabled with the reason outside any project", async () => {
    board(cancelled());
    renderApp(`/?drawer=run:${JOB_ID}`);
    await describedReason(PICK_PROJECT);
  });

  it("is disabled with the reason on another project's job", async () => {
    board(cancelled({ projectId: OTHER_PROJECT_ID }));
    renderApp(IN_RUN);
    await describedReason("This job belongs to another project: switch to it first.");
  });

  it("is disabled with the reason in an archived project", async () => {
    const calls = mockFetch({
      "GET /v1/workspaces": () => json(workspaces([project({ archivedAt: "2026-11-01T00:00:00.000Z" })])),
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [cancelled()], nextCursor: null }),
      [`GET /v1/jobs/${JOB_ID}`]: () => json(cancelled()),
    });
    renderApp(IN_RUN);
    await describedReason(/Home is archived/);
    expect(retries(calls)).toHaveLength(0);
  });

  it("is disabled with the reason while offline, and never queues for later", async () => {
    const calls = board(cancelled());
    const user = userEvent.setup();
    renderApp(IN_RUN);
    const b = await button();
    onlineManager.setOnline(false);
    await describedReason(/You're offline/);
    await user.click(b);
    expect(retries(calls)).toHaveLength(0);

    onlineManager.setOnline(true);
    await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
    expect(retries(calls)).toHaveLength(0);
  });

  it("links a rerun back to the job it reran", async () => {
    board(cancelled({ retryOfJobId: ORIGINAL }));
    const user = userEvent.setup();
    const { router } = renderApp(IN_RUN);
    await user.click(await screen.findByRole("link", { name: `Rerun of ${ORIGINAL.slice(0, 8)}` }));
    await waitFor(() => expect(drawerOf(router)).toBe(`run:${ORIGINAL}`));
  });

  it("shows no link on a job that isn't a rerun", async () => {
    board(cancelled());
    renderApp(IN_RUN);
    await button();
    expect(screen.queryByRole("link", { name: /Rerun of/ })).toBeNull();
  });
});

describe("Jobs page: Run again", () => {
  const item = (j: Job): JobHistoryItem => ({
    job: j,
    repositoryId: null,
    repositoryFullName: null,
    durationMs: null,
    tests: null,
    pullRequest: null,
    approval: null,
  });
  const FINISHED = "33333333-3333-4333-8333-333333333331";
  const RUNNING = "33333333-3333-4333-8333-333333333332";
  const OPENED_PR = "33333333-3333-4333-8333-333333333333";
  const items = [
    item(job({ id: FINISHED, status: "FAILED" })),
    item(job({ id: RUNNING, status: "RUNNING", runnerId: runner().id })),
    item(job({ id: OPENED_PR, status: "COMPLETED", outcome: "PR_CREATED" })),
  ];
  const list = () =>
    mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      "GET /v1/jobs/history": () => json({ items, nextCursor: null }),
      [`POST /v1/jobs/${FINISHED}/retry`]: () => json(QUEUED, 202),
      [`POST /v1/jobs/${OPENED_PR}/retry`]: () => json(QUEUED, 202),
      [`GET /v1/jobs/${NEW_JOB}`]: () => json(job({ id: NEW_JOB, status: "QUEUED" })),
    });
  const IN_JOBS = `${IN_PROJECT}&drawer=jobs`;
  const buttons = () => screen.findAllByRole("button", { name: /^Run again/ });

  it("is on each finished row and not on a running one", async () => {
    list();
    renderApp(IN_JOBS);
    expect(await buttons()).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Run again: Diagnostic · node-version" })).toHaveLength(2);
  });

  it("queues the rerun with its own key per row and opens the new job", async () => {
    const calls = list();
    const user = userEvent.setup();
    const { router } = renderApp(IN_JOBS);
    await user.click((await buttons())[0]!);

    await waitFor(() => expect(drawerOf(router)).toBe(`run:${NEW_JOB}`));
    expect(retries(calls)).toHaveLength(1);
    expect(retries(calls)[0]!.path).toBe(`/v1/jobs/${FINISHED}/retry`);
  });

  it("asks first on a row that opened a pull request", async () => {
    const calls = list();
    const user = userEvent.setup();
    renderApp(IN_JOBS);
    await user.click((await buttons())[1]!);
    expect(await screen.findByRole("alertdialog", { name: "Open a second pull request?" })).toBeTruthy();
    expect(retries(calls)).toHaveLength(0);
  });

  it("in All, each row is disabled and points at the list's one reason", async () => {
    list();
    renderApp(`/?ws=dev&drawer=jobs`);
    // Dev has two projects in the fixtures: no project is selected, so it's the read-only aggregate.
    const all = await buttons();
    const note = await screen.findByText(PICK_PROJECT);
    await waitFor(() => expect((all[0] as HTMLButtonElement).disabled).toBe(true));
    for (const b of all) expect(b.getAttribute("aria-describedby")).toBe(note.id);
    expect(screen.getAllByText(PICK_PROJECT)).toHaveLength(1);
  });

  it("is disabled with a short reason per row while offline", async () => {
    list();
    renderApp(IN_JOBS);
    const all = await buttons();
    onlineManager.setOnline(false);
    await waitFor(() => expect((all[0] as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getAllByText("You're offline.")).toHaveLength(2);
  });
});

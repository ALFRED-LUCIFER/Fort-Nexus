import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Notification } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
  type Call,
} from "../test/helpers.tsx";

const T0 = "2026-10-28T10:00:00.000Z";
let seq = 0;
const note = (over: Partial<Notification> = {}): Notification => ({
  id: `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`,
  projectId: PROJECT_ID,
  category: "TASK_DONE",
  title: "Finished · node-version diagnostic",
  body: "The command succeeded. Open the run for its output.",
  subject: { jobId: JOB_ID, approvalId: null },
  status: "UNREAD",
  createdAt: T0,
  ...over,
});

function board(notifications: () => Notification[], extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    ...extra,
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(job({ status: "FAILED", projectId: OTHER_PROJECT_ID })),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/notifications": () => {
      const items = notifications();
      return json({ items, unreadCount: items.filter((n) => n.status === "UNREAD").length });
    },
  });
}
const marks = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/notifications/"));

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => vi.useRealTimers());

describe("inbox notifications", () => {
  it("fills the tabs, counts unread on the button, and opening one marks it read and deep-links to its run", async () => {
    const failed = note({
      category: "TASK_FAILED",
      projectId: OTHER_PROJECT_ID,
      title: "Run timed out · node-version diagnostic",
      body: "The command ran past its time limit. Start it again.",
    });
    const items = [
      failed,
      note({ status: "READ" }),
      note({
        category: "SECURITY_CRITICAL",
        projectId: null,
        subject: { jobId: null, approvalId: null },
        title: "Emergency stop engaged",
      }),
      // Its pending approval card stands for it: not listed twice, not counted twice.
      note({ category: "APPROVAL_REQUIRED", title: "Ready for review · acme/web#42" }),
    ];
    const calls = board(() => items);
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);

    await user.click(await screen.findByRole("button", { name: "Inbox, 0 pending approvals, 2 unread" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("list", { name: "Notifications" });
    const tab = (name: string) => within(dialog).getByRole("button", { name: new RegExp(`^${name}`) });
    expect(tab("All").textContent).toBe("All3");
    expect(tab("Approvals").textContent).toBe("Approvals0");
    expect(tab("Failures").textContent).toBe("Failures1");
    expect(tab("Security").textContent).toBe("Security1");
    expect(tab("Done & notices").textContent).toBe("Done & notices1");
    expect(within(dialog).queryByText("Ready for review · acme/web#42")).toBeNull();
    expect(calls.find((c) => c.path === "/v1/notifications")!.query.get("projectId")).toBe(PROJECT_ID);

    await user.click(tab("Blocked"));
    expect(within(dialog).getByText(/^Nothing is blocked\./)).toBeTruthy();
    await user.click(tab("Failures"));
    const rows = within(within(dialog).getByRole("list", { name: "Notifications" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/TASK_FAILED, unread/);
    expect(rows[0]!.textContent).toMatch(/Start it again\./);

    await user.click(within(rows[0]!).getByRole("button", { name: `Open the run: ${failed.title}` }));
    await waitFor(() => expect(marks(calls)).toHaveLength(1));
    expect(marks(calls)[0]).toMatchObject({
      path: `/v1/notifications/${failed.id}/status`,
      body: { status: "READ" },
    });
    // The run opens in its own project, where its approval can be decided.
    expect(router.state.location.search).toEqual({
      ws: "dev",
      project: OTHER_PROJECT_ID,
      drawer: `run:${JOB_ID}`,
    });
  });
});

describe("toasts", () => {
  it("toasts only what arrives after load, once per notification; Later dismisses, Open marks read and deep-links", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backlog = note({ title: "Old news" });
    let items = [backlog];
    const calls = board(() => items);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderApp(IN_PROJECT);
    await screen.findByRole("button", { name: /^Inbox, 0 pending approvals, 1 unread/ });
    expect(screen.queryByRole("region", { name: "New notifications" })).toBeNull();

    const done = note({ title: "Draft PR #7 opened · acme/web#42", body: "Tests passed." });
    items = [done, backlog];
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    const stack = await screen.findByRole("region", { name: "New notifications" });
    const toast = within(stack).getByRole("article", { name: done.title });
    expect(toast.textContent).toMatch(/^TASK_DONE/);
    expect(screen.getByText(`New notification: ${done.title}`).getAttribute("aria-live")).toBe("polite");

    await act(() => vi.advanceTimersByTimeAsync(5_000)); // polled again: still one toast
    expect(within(stack).getAllByRole("article")).toHaveLength(1);
    await user.click(within(toast).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("region", { name: "New notifications" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByRole("region", { name: "New notifications" })).toBeNull(); // Later is not "show again"
    expect(marks(calls)).toEqual([]);

    const failed = note({ category: "TASK_FAILED", title: "Run failed · acme/web#42" });
    items = [failed, done, backlog];
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    const next = await screen.findByRole("article", { name: failed.title });
    await user.click(within(next).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(marks(calls)).toHaveLength(1));
    expect(marks(calls)[0]!.path).toBe(`/v1/notifications/${failed.id}/status`);
    expect(router.state.location.search).toMatchObject({ project: PROJECT_ID, drawer: `run:${JOB_ID}` });
    expect(screen.queryByRole("article", { name: failed.title })).toBeNull();
  });

  it("Talk opens a new thread about the toast's run, in the run's project; a notice without a run can't", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const THREAD = "55555555-5555-4555-8555-555555555555";
    const thread = {
      id: THREAD,
      projectId: OTHER_PROJECT_ID,
      title: "New conversation",
      subjectJobId: JOB_ID,
      createdAt: T0,
      updatedAt: T0,
    };
    let items: Notification[] = [];
    const calls = board(() => items, {
      "POST /v1/conversations": () => json(thread, 201),
      [`GET /v1/conversations/${THREAD}`]: () => json({ thread, turns: [], proposals: [] }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderApp(IN_PROJECT);
    await screen.findByRole("button", { name: /^Inbox, 0 pending approvals, 0 unread/ });

    const failed = note({ category: "TASK_FAILED", projectId: OTHER_PROJECT_ID, title: "Run failed" });
    const stop = note({
      category: "SECURITY_CRITICAL",
      projectId: null,
      subject: { jobId: null, approvalId: null },
      title: "Emergency stop engaged",
    });
    items = [failed, stop];
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    const notice = await screen.findByRole("article", { name: stop.title });
    const disabled = within(notice).getByRole("button", { name: "Talk" }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(document.getElementById(disabled.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /isn't about a run/,
    );

    const toast = screen.getByRole("article", { name: failed.title });
    await user.click(within(toast).getByRole("button", { name: "Talk" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        ws: "dev",
        project: OTHER_PROJECT_ID,
        drawer: `talk:${THREAD}`,
      }),
    );
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/v1/conversations");
    expect(creates.map((c) => c.body)).toEqual([{ projectId: OTHER_PROJECT_ID, subjectJobId: JOB_ID }]);
    expect(screen.queryByRole("article", { name: failed.title })).toBeNull();
  });
});

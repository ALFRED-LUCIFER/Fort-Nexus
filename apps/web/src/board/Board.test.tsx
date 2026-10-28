import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDEMPOTENCY_HEADER, IdempotencyKey, type Job, type Runner } from "@nexus/contracts";
import {
  FakeEventSource,
  JOB_ID,
  ME,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";

function board(runners: Runner[], jobs: Job[] = [], extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: runners }),
    "GET /v1/jobs": (c) =>
      json({
        items: jobs.filter((j) => !c.query.get("status") || j.status === c.query.get("status")),
        nextCursor: null,
      }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(job()),
    ...extra,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("board", () => {
  it("queues the previewed diagnostic with an Idempotency-Key and reuses it on retry", async () => {
    let attempts = 0;
    const calls = board([runner()], [], {
      "POST /v1/jobs": () =>
        ++attempts === 1
          ? apiError(503, "RUNNER_UNAVAILABLE", "Queue is busy, try again.")
          : json({ jobId: JOB_ID, status: "QUEUED", streamUrl: `/v1/jobs/${JOB_ID}/events` }, 202),
    });
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByText("Home host · ONLINE");

    await user.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "Execute preview" });
    expect(within(preview).getByText("Not required")).toBeTruthy();
    await user.selectOptions(within(preview).getByLabelText("Preset"), "git-version");
    await user.click(within(preview).getByRole("button", { name: "Queue on test-host" }));
    expect((await within(preview).findByRole("alert")).textContent).toBe("Queue is busy, try again.");
    await user.click(within(preview).getByRole("button", { name: "Queue on test-host" }));

    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/jobs");
    expect(posts).toHaveLength(2);
    const key = posts[0]!.headers.get(IDEMPOTENCY_HEADER);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(posts[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    expect(posts[0]!.body).toEqual({ jobType: "RUNNER_DIAGNOSTIC", preset: "git-version" });
    // The run drawer opens on the new job.
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("says a job will be held when no runner is online", async () => {
    board([runner({ status: "OFFLINE", name: "home-box" })]);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByText("Home host · OFFLINE");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText(/home-box is offline\. The job will be queued and held, not lost/)).toBeTruthy();
  });

  it("shows the offline banner with the real held-job count", async () => {
    const lastSeen = "2026-10-28T09:00:00.000Z";
    const other = "44444444-4444-4444-8444-444444444444";
    const done = "55555555-5555-4555-8555-555555555555";
    board(
      [runner({ status: "OFFLINE", name: "home-box", lastHeartbeatAt: lastSeen })],
      [job(), job({ id: other }), job({ id: done, status: "COMPLETED" })],
    );
    renderApp("/");
    expect(await screen.findByText("home-box is offline. 2 queued jobs are held, not lost.")).toBeTruthy();
  });

  it("shows the offline banner inside an open run drawer", async () => {
    const held = job();
    board([runner({ status: "OFFLINE", name: "home-box" })], [held], {
      [`GET /v1/jobs/${JOB_ID}`]: () => json(held),
    });
    renderApp(`/?drawer=run:${JOB_ID}`);
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByText("home-box is offline. 1 queued job is held, not lost."),
    ).toBeTruthy();
    expect(screen.getAllByText(/home-box is offline\./)).toHaveLength(1);
  });

  it("has no offline banner while a runner is online", async () => {
    board([runner()]);
    renderApp("/");
    await screen.findByText("Home host · ONLINE");
    expect(screen.queryByText(/is offline/)).toBeNull();
  });

  it("announces controls that arrive in P1 and does nothing on click", async () => {
    const calls = board([runner()]);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByText("Home host · ONLINE");
    for (const name of ["Settings", "STOP ALL", "Voice command"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      const why = document.getElementById(btn.getAttribute("aria-describedby")!);
      expect(why?.textContent).toMatch(/arrive(s)? in P1/);
    }
    await user.click(screen.getByRole("button", { name: "STOP ALL" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("explains that Ask needs the P1 conversation service", async () => {
    board([runner()]);
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Ask", pressed: false }));
    await user.type(screen.getByRole("textbox", { name: "Command" }), "what is running?{Enter}");
    expect(await screen.findByText("Ask needs the conversation service, which arrives in P1.")).toBeTruthy();
  });

  it("pairs a runner when none is paired", async () => {
    board([], [], {
      "POST /v1/runners/pair": () => json({ code: "ABC123", expiresAt: "2026-10-28T10:10:00.000Z" }),
    });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Pair a runner" }));
    expect(await screen.findByText("node apps/runner/src/main.ts pair --code ABC123")).toBeTruthy();
  });

  it("slides a drawer in, keeps focus inside it and closes it on Esc after the exit animation", async () => {
    board([runner()], [], { "GET /v1/approvals": () => json({ items: [] }) });
    const user = userEvent.setup();
    const { router } = renderApp("/");
    const inbox = await screen.findByRole("button", { name: /^Inbox/ });
    await user.click(inbox);

    const drawer = await screen.findByRole("dialog", { name: "What needs you" });
    expect(drawer.style.transform).toMatch(/translateX/);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    for (const shift of [true, true, false, false, false]) {
      await user.tab({ shift });
      expect(drawer.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");
    // The URL (and the drawer) clear only once the exit animation has played.
    expect(router.state.location.search).toEqual({ drawer: "inbox" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({});
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.activeElement).toBe(inbox);
  });

  it("keeps workspace scope in the URL", async () => {
    board([runner()]);
    const user = userEvent.setup();
    const { router } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Business" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ ws: "business" }));
  });
});

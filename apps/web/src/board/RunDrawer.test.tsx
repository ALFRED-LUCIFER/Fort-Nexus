import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { SSE_RUN_EVENT, type Job } from "@nexus/contracts";
import {
  FakeEventSource,
  JOB_ID,
  ME,
  event,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { explain } from "./runEvents.ts";

const RUNNER_ID = runner().id;

function open(j: Job) {
  mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [j], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(j),
  });
  renderApp(`/?drawer=run:${JOB_ID}`);
}

const seqs = () =>
  [...screen.getByRole("region", { name: "Run output" }).querySelectorAll<HTMLElement>("[data-seq]")].map(
    (el) => Number(el.dataset.seq),
  );

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // jsdom has no layout; give the virtualized terminal a viewport.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(() => vi.useRealTimers());

describe("run drawer", () => {
  it("renders events in sequence order and drops replays after a reconnect", async () => {
    open(job({ status: "RUNNING", runnerId: RUNNER_ID }));
    await screen.findByRole("dialog");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe(`/v1/jobs/${JOB_ID}/events`);

    act(() => {
      first.open();
      first.emit(SSE_RUN_EVENT, event(1, "job.state.changed", { to: "RUNNING" }));
      first.emit(SSE_RUN_EVENT, event(3, "agent.started", { argv: ["node", "--version"] }));
      first.emit(SSE_RUN_EVENT, event(2, "workspace.created", { hostname: "box", pid: 42, cwd: "/tmp/x" }));
    });
    await waitFor(() => expect(seqs()).toEqual([1, 2, 3]));
    expect(screen.getByText("Running node --version on box, pid 42.")).toBeTruthy();

    // Browser auto-reconnect replays from Last-Event-ID; the overlap must not duplicate lines.
    act(() => {
      first.onerror?.();
      first.emit(SSE_RUN_EVENT, event(2, "workspace.created", { hostname: "box", pid: 42, cwd: "/tmp/x" }));
      first.emit(SSE_RUN_EVENT, event(3, "agent.started", { argv: ["node", "--version"] }));
      first.emit(SSE_RUN_EVENT, event(4, "process.output", { stream: "stdout", text: "v24.1.0" }));
    });
    await waitFor(() => expect(seqs()).toEqual([1, 2, 3, 4]));

    // A closed stream is reopened by us from the last seen sequence.
    act(() => first.fail());
    expect(screen.getByRole("status").textContent).toMatch(/reconnecting/);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe(`/v1/jobs/${JOB_ID}/events?afterSequence=4`);
    act(() => {
      second.open();
      second.emit(SSE_RUN_EVENT, event(4, "process.output", { stream: "stdout", text: "v24.1.0" }));
      second.emit(SSE_RUN_EVENT, event(5, "tool.completed", { exitCode: 0, durationMs: 31 }));
      second.emit("end", {});
    });
    await waitFor(() => expect(seqs()).toEqual([1, 2, 3, 4, 5]));
    expect(screen.getAllByText("v24.1.0")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/stream ended/);
    expect(second.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("offers Cancel only for a live job and shows its stats", async () => {
    open(job({ status: "COMPLETED", runnerId: RUNNER_ID, lastEventSequence: 9 }));
    await screen.findByRole("heading", { name: "node-version on test-host" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    const tile = (k: string) =>
      screen.getByText(k, { selector: "span.font-mono" }).parentElement!.textContent;
    expect(tile("status")).toBe("statusCompleted");
    expect(tile("runner")).toBe("runnertest-host");
    expect(tile("exit code")).toBe("exit code—");
  });

  it("lets the owner cancel a queued job", async () => {
    let cancelled = false;
    const calls = mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner({ status: "OFFLINE" })] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      [`GET /v1/jobs/${JOB_ID}`]: () => json(job({ status: cancelled ? "CANCELLED" : "QUEUED" })),
      [`POST /v1/jobs/${JOB_ID}/cancel`]: () => ((cancelled = true), json(job({ status: "CANCELLED" }), 202)),
    });
    renderApp(`/?drawer=run:${JOB_ID}`);
    expect(
      await screen.findByText(/Queued and held, not lost\. It starts when test-host comes online\./),
    ).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Cancel run" }).click());
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull());
  });

  it("does not call a run needing recovery live", async () => {
    open(job({ status: "RECOVERY_REQUIRED", runnerId: RUNNER_ID }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]!.open());
    expect(await screen.findByText(/^Output from /)).toBeTruthy();
    expect(screen.queryByText(/^Live on /)).toBeNull();
  });

  it("shows the sandbox runtime and warns when the job ran on the host", async () => {
    open(job({ status: "RUNNING", runnerId: RUNNER_ID }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.open();
      es.emit(
        SSE_RUN_EVENT,
        event(1, "workspace.created", { hostname: "box", sandbox: { runtime: "bogus" } }),
      );
    });
    await waitFor(() => expect(seqs()).toEqual([1]));
    expect(screen.queryByText(/Not sandboxed/)).toBeNull(); // invalid payloads are ignored

    act(() =>
      es.emit(
        SSE_RUN_EVENT,
        event(2, "workspace.created", { hostname: "box", sandbox: { runtime: "none" } }),
      ),
    );
    expect((await screen.findByRole("note")).textContent).toMatch(
      /Not sandboxed.*directly on the home machine/,
    );
    expect(screen.getByText("none · host")).toBeTruthy();
  });

  it("names the container runtime without a warning when sandboxed", async () => {
    open(job({ status: "RUNNING", runnerId: RUNNER_ID }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.open();
      es.emit(
        SSE_RUN_EVENT,
        event(1, "workspace.created", {
          sandbox: { runtime: "docker-rootless", image: "nexus-sandbox:1", container: "nx-1" },
        }),
      );
    });
    expect(await screen.findByText("docker-rootless · nexus-sandbox:1")).toBeTruthy();
    expect(screen.queryByText(/Not sandboxed/)).toBeNull();
  });
});

describe("explain", () => {
  it("explains RECOVERY_REQUIRED plainly", () => {
    expect(explain("RECOVERY_REQUIRED", {}, "box", false)).toMatch(
      /stopped reporting.*will not be retried automatically/,
    );
  });
});

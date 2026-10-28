import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESET_ARGV } from "./presets.ts";
import { startJob } from "./run.ts";
import { startRunner } from "./runner.ts";
import { eventsOf, fakeApi, hasOutput, json, leaseFor, terminal, timeline } from "./test-support.ts";

const h = vi.hoisted(() => ({
  spawned: [] as { cmd: string; args: readonly string[]; options: SpawnOptions; child: ChildProcess }[],
  script: undefined as string | undefined,
}));

// Records every spawn call. When a test sets `h.script`, a node script with controllable behaviour
// (slow, ignores SIGTERM, fails) runs instead of the preset; the recorded call is still the preset's.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: readonly string[], options: SpawnOptions) => {
      const child = h.script
        ? real.spawn(process.execPath, ["-e", h.script], options)
        : real.spawn(cmd, args, options);
      h.spawned.push({ cmd, args, options, child });
      return child;
    },
  };
});

// Host-process lifecycle tests (RUNNER_SANDBOX=none); the Docker path is covered in sandbox.test.ts.
const FAST = { timeoutMs: 5_000, killGraceMs: 200, flushMs: 20, log: () => {}, sandbox: "none" as const };
const SLOW = "setInterval(() => console.log('tick'), 20)";

const isGone = (child: ChildProcess) => {
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(() => process.kill(child.pid!, 0)).toThrow(); // ESRCH: no such process
};

afterEach(() => {
  for (const { child } of h.spawned)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  h.spawned.length = 0;
  h.script = undefined;
});

describe("presets", () => {
  it("map to fixed argv arrays", () => {
    expect(PRESET_ARGV).toEqual({
      "host-info": ["uname", "-a"],
      "node-version": ["node", "--version"],
      "git-version": ["git", "--version"],
    });
  });

  it.each([
    ["unknown preset", { jobType: "RUNNER_DIAGNOSTIC", preset: "rm -rf /" }],
    ["unknown job type", { jobType: "SHELL", preset: "node-version" }],
    ["extra command field", { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", cmd: "ls" }],
  ])("reports FAILED and never executes on %s", async (_, request) => {
    const { api, appends } = fakeApi();
    await startJob(api, leaseFor(request), FAST).done;
    expect(h.spawned).toHaveLength(0);
    expect(timeline(appends)).toEqual(["job.failed", "→FAILED"]);
    expect(eventsOf(appends, "job.failed")[0]?.payload).toMatchObject({ reason: "invalid_request" });
  });
});

describe("job execution", () => {
  it("runs node-version on the host only with RUNNER_SANDBOX=none: no shell, minimal env, temp cwd", async () => {
    const { api, appends } = fakeApi();
    await startJob(api, leaseFor(), FAST).done;

    expect(timeline(appends)).toEqual([
      "workspace.created",
      "→RUNNING",
      "agent.started",
      "process.output",
      "tool.completed",
      "→VERIFYING",
      "job.completed",
      "→COMPLETED",
    ]);
    expect(terminal(appends)).toEqual({ to: "COMPLETED", outcome: "COMMAND_SUCCEEDED" });
    expect(appends.every((a) => a.fencingToken === 7)).toBe(true);
    expect(eventsOf(appends, "process.output").map((e) => e.payload)).toEqual([
      { stream: "stdout", text: expect.stringMatching(/^v\d+\.\d+\.\d+\n$/) },
    ]);
    expect(eventsOf(appends, "workspace.created")[0]?.payload).toMatchObject({
      sandbox: { runtime: "none" },
    });
    expect(eventsOf(appends, "tool.completed")[0]?.payload).toMatchObject({ exitCode: 0 });

    const [call] = h.spawned;
    expect(call).toMatchObject({ cmd: "node", args: ["--version"] });
    expect(call!.options.shell).toBe(false);
    expect(Object.keys(call!.options.env!)).toEqual(["PATH"]);
    expect(String(call!.options.cwd).startsWith(tmpdir())).toBe(true);
    expect(existsSync(String(call!.options.cwd))).toBe(false);
  });

  it("reports FAILED/COMMAND_FAILED on a non-zero exit, with secrets redacted", async () => {
    h.script =
      "console.log('Authorization: Bearer abcdefghijklmnop'); console.error('password=hunter2'); process.exit(3)";
    const { api, appends } = fakeApi();
    await startJob(api, leaseFor(), FAST).done;

    expect(timeline(appends)).toEqual([
      "workspace.created",
      "→RUNNING",
      "agent.started",
      "process.output",
      "tool.completed",
      "→VERIFYING",
      "job.failed",
      "→FAILED",
    ]);
    expect(terminal(appends)).toEqual({ to: "FAILED", outcome: "COMMAND_FAILED" });
    expect(eventsOf(appends, "tool.completed")[0]?.payload).toMatchObject({ exitCode: 3 });
    const sent = JSON.stringify(appends);
    expect(sent).not.toContain("hunter2");
    expect(sent).not.toContain("abcdefghijklmnop");
    expect(sent).toContain("[REDACTED]");
  });

  it("kills a run that exceeds the timeout and reports TIMED_OUT", async () => {
    h.script = "setInterval(() => {}, 1000)";
    const { api, appends } = fakeApi();
    await startJob(api, leaseFor(), { ...FAST, timeoutMs: 300 }).done;

    expect(timeline(appends)).toEqual([
      "workspace.created",
      "→RUNNING",
      "agent.started",
      "tool.completed",
      "→VERIFYING",
      "job.failed",
      "→FAILED",
    ]);
    expect(terminal(appends)).toEqual({ to: "FAILED", outcome: "TIMED_OUT" });
    isGone(h.spawned[0]!.child);
  });

  it("on STALE_LEASE kills the child and never appends again", async () => {
    h.script = SLOW;
    const stale = json(409, {
      error: { code: "STALE_LEASE", message: "fencing token is old" },
      requestId: "r",
    });
    const { api, appends } = fakeApi({
      onAppend: (req) => (req.events.some((e) => e.type === "process.output") ? stale : undefined),
    });
    await startJob(api, leaseFor(), FAST).done;

    const count = appends.length;
    await sleep(200);
    expect(appends).toHaveLength(count);
    expect(appends.at(-1)!.events.some((e) => e.type === "process.output")).toBe(true);
    expect(terminal(appends)).toBeUndefined();
    isGone(h.spawned[0]!.child);
  });
});

describe("runner loop", () => {
  it("owner cancel via heartbeat: SIGTERM, SIGKILL after grace, confirmed exit, then CANCELLED", async () => {
    h.script = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
    const { api, appends } = fakeApi({ lease: leaseFor(), cancel: hasOutput });
    const runner = startRunner(api, { ...FAST, heartbeatMs: 30 });
    await vi.waitFor(() => expect(terminal(appends)).toBeDefined(), { timeout: 5_000 });
    await runner.stop();

    expect(timeline(appends)).toEqual([
      "workspace.created",
      "→RUNNING",
      "agent.started",
      "process.output",
      "tool.completed",
      "job.cancelled",
      "→CANCELLED",
    ]);
    expect(eventsOf(appends, "job.cancelled")[0]?.payload).toEqual({ terminated: true });
    const { child } = h.spawned[0]!;
    expect(child.signalCode).toBe("SIGKILL"); // it ignored SIGTERM
    isGone(child);
  });

  it("graceful shutdown terminates the child and reports FAILED runner_shutdown", async () => {
    h.script = SLOW;
    const { api, appends } = fakeApi({ lease: leaseFor() });
    const runner = startRunner(api, { ...FAST, heartbeatMs: 30 });
    await vi.waitFor(() => expect(hasOutput(appends)).toBe(true), { timeout: 5_000 });
    await runner.stop();

    expect(timeline(appends).slice(-3)).toEqual(["tool.completed", "job.failed", "→FAILED"]);
    expect(eventsOf(appends, "job.failed")[0]?.payload).toEqual({ reason: "runner_shutdown" });
    isGone(h.spawned[0]!.child);
  });

  it("kills the child and drops the job when heartbeats fail for longer than the lease TTL", async () => {
    h.script = SLOW;
    const { api, appends } = fakeApi({
      lease: leaseFor(),
      heartbeat: () => new Response("down", { status: 503 }),
    });
    const runner = startRunner(api, { ...FAST, heartbeatMs: 30, leaseTtlMs: 300 });
    await vi.waitFor(() => isGone(h.spawned[0]!.child), { timeout: 5_000 });
    await runner.stop();

    expect(terminal(appends)).toBeUndefined();
  });

  it("stops with an error when the token is rejected", async () => {
    const { api } = fakeApi({
      heartbeat: () => json(401, { error: { code: "UNAUTHENTICATED", message: "revoked" }, requestId: "r" }),
    });
    await expect(startRunner(api, { ...FAST, heartbeatMs: 30 }).done).rejects.toThrow(
      /pair this runner again/,
    );
  });
});

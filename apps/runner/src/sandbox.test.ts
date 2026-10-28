import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startJob } from "./run.ts";
import { startRunner } from "./runner.ts";
import {
  SANDBOX_BUILD_COMMAND,
  SANDBOX_IMAGE,
  containerName,
  detectRuntime,
  docker,
  dockerRunArgs,
  imageExists,
  removeLeftovers,
} from "./sandbox.ts";
import { eventsOf, fakeApi, json, leaseFor, stdoutOf, terminal, timeline } from "./test-support.ts";

// Test-only long-running argv behind an existing key, so cancel/timeout/shutdown can hit a live
// container. The public allowlist is unchanged (run.test.ts asserts it).
vi.mock("./presets.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./presets.ts")>();
  return {
    PRESET_ARGV: { ...real.PRESET_ARGV, "git-version": ["sh", "-c", "echo started; exec sleep 300"] },
  };
});

const ID = "6f1c1d3e-8a4b-4c1e-9f00-00000000000a";

describe("dockerRunArgs", () => {
  it("builds the exact hardened argv with the workspace as the only mount", () => {
    const args = dockerRunArgs({
      jobId: ID,
      runnerLabel: "r1",
      workspace: "/var/nexus/work/x",
      argv: ["node", "--version"],
    });
    expect(args).toEqual([
      "run",
      "--rm",
      "--name",
      `nexus-job-${ID}`,
      "--label",
      "nexus.runner=r1",
      "--label",
      `nexus.job=${ID}`,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "--cpus",
      "2",
      "--init",
      "--mount",
      "type=bind,source=/var/nexus/work/x,target=/workspace",
      "--env",
      "HOME=/tmp",
      "--workdir",
      "/workspace",
      SANDBOX_IMAGE,
      "node",
      "--version",
    ]);
    expect(args.filter((a) => ["--mount", "-v", "--volume", "--volumes-from"].includes(a))).toEqual([
      "--mount",
    ]);
    expect(args.join(" ")).not.toMatch(/docker\.sock|SSH_AUTH_SOCK|--privileged|--env-file/);
  });

  it.each([
    ["the root", "/"],
    ["$HOME", homedir()],
    ["a relative path", "work/x"],
    ["a path that smuggles mount options", "/tmp/x,target=/etc"],
  ])("refuses to mount %s", (_, workspace) => {
    expect(() => dockerRunArgs({ jobId: ID, runnerLabel: "r1", workspace, argv: ["true"] })).toThrow(
      /refusing to mount/,
    );
  });

  it("rejects a non-uuid job id and odd labels (they become container name and filter)", () => {
    const base = { runnerLabel: "r1", workspace: "/tmp/x", argv: ["true"] as [string] };
    expect(() => dockerRunArgs({ ...base, jobId: "../../x" })).toThrow(/uuid/);
    expect(() => dockerRunArgs({ ...base, jobId: ID, runnerLabel: "a b" })).toThrow(/label/);
  });

  it("sandbox:build tags the image the runner uses", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["sandbox:build"]).toBe(`docker build -t ${SANDBOX_IMAGE} ../../infra/sandbox`);
    expect(SANDBOX_BUILD_COMMAND).toBe("pnpm --filter @nexus/runner sandbox:build");
  });
});

const dockerUp = (await docker(["info"], 10_000)).ok;
if (!dockerUp) console.warn("SKIPPING real Docker tests: the docker daemon is not reachable");

describe.skipIf(!dockerUp)("real Docker sandbox", () => {
  const runnerLabel = `nexus-test-${process.pid}`;
  const OPTS = { timeoutMs: 30_000, killGraceMs: 2_000, flushMs: 20, log: () => {}, runnerLabel };
  const gone = async (jobId: string) => !(await docker(["container", "inspect", containerName(jobId)])).ok;
  const inspect = async (jobId: string, format: string) => {
    const r = await docker(["container", "inspect", "--format", format, containerName(jobId)]);
    if (!r.ok) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };
  const SLEEP = { jobType: "RUNNER_DIAGNOSTIC", preset: "git-version" }; // mocked: prints, then sleeps 300 s

  beforeAll(async () => {
    if (await imageExists(SANDBOX_IMAGE)) return;
    const infra = fileURLToPath(new URL("../../../infra/sandbox", import.meta.url));
    const built = await docker(["build", "-t", SANDBOX_IMAGE, infra], 600_000);
    if (!built.ok) throw new Error(`building ${SANDBOX_IMAGE} failed: ${built.stderr}`);
  }, 600_000);
  afterAll(() => removeLeftovers(runnerLabel));

  it("runs node-version in a fresh container on this host and removes it", async () => {
    const jobId = randomUUID();
    const { api, appends } = fakeApi({ jobId });
    await startJob(api, leaseFor(undefined, jobId), OPTS).done;

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
    expect(stdoutOf(appends)).toMatch(/^v24\.\d+\.\d+\n$/); // the image's Node, not necessarily the host's
    expect(eventsOf(appends, "workspace.created")[0]?.payload).toMatchObject({
      hostname: hostname(),
      pid: process.pid,
      sandbox: { runtime: await detectRuntime(), image: SANDBOX_IMAGE, container: containerName(jobId) },
    });
    expect(eventsOf(appends, "agent.started")[0]?.payload).toMatchObject({ argv: ["node", "--version"] });
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("host-info reports the container's Linux kernel, not the host shell", async () => {
    const jobId = randomUUID();
    const { api, appends } = fakeApi({ jobId });
    await startJob(api, leaseFor({ jobType: "RUNNER_DIAGNOSTIC", preset: "host-info" }, jobId), OPTS).done;

    expect(terminal(appends)).toEqual({ to: "COMPLETED", outcome: "COMMAND_SUCCEEDED" });
    expect(stdoutOf(appends)).toMatch(/^Linux /);
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("enforces the isolation flags on a live container; owner cancel stops it and confirms it is gone", async () => {
    const jobId = randomUUID();
    let cancel = false;
    const { api, appends } = fakeApi({ jobId, lease: leaseFor(SLEEP, jobId), cancel: () => cancel });
    const runner = startRunner(api, { ...OPTS, heartbeatMs: 50 });
    try {
      await vi.waitFor(() => inspect(jobId, "{{json .State.Running}}").then((r) => expect(r).toBe(true)), {
        timeout: 15_000,
        interval: 100,
      });
      const host = await inspect(jobId, "{{json .HostConfig}}");
      expect(host).toMatchObject({
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Privileged: false,
        PidsLimit: 256,
        Memory: 1024 ** 3,
        NanoCpus: 2e9,
        Init: true,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
      });
      expect(await inspect(jobId, "{{json .Config.User}}")).toBe("10001:10001");
      const mounts: { Type: string; Destination: string }[] = await inspect(jobId, "{{json .Mounts}}");
      expect(mounts.map((m) => [m.Type, m.Destination])).toEqual([["bind", "/workspace"]]);
      // No route out: an outbound connection fails immediately inside the container.
      const probe =
        "require('net').connect(443,'1.1.1.1').on('connect',()=>console.log('CONNECTED')).on('error',e=>console.log(e.code))";
      const net = await docker(["exec", containerName(jobId), "node", "-e", probe]);
      expect(net.stdout.trim()).toBe("ENETUNREACH");

      cancel = true;
      await vi.waitFor(() => expect(terminal(appends)).toBeDefined(), { timeout: 15_000 });
    } finally {
      await runner.stop();
    }
    expect(timeline(appends).slice(-3)).toEqual(["tool.completed", "job.cancelled", "→CANCELLED"]);
    expect(eventsOf(appends, "job.cancelled")[0]?.payload).toEqual({ terminated: true });
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("timeout stops the container and reports TIMED_OUT", async () => {
    const jobId = randomUUID();
    const { api, appends } = fakeApi({ jobId });
    await startJob(api, leaseFor(SLEEP, jobId), { ...OPTS, timeoutMs: 1_500 }).done;

    expect(terminal(appends)).toEqual({ to: "FAILED", outcome: "TIMED_OUT" });
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("runner shutdown stops the container and reports FAILED runner_shutdown", async () => {
    const jobId = randomUUID();
    const { api, appends } = fakeApi({ jobId, lease: leaseFor(SLEEP, jobId) });
    const runner = startRunner(api, { ...OPTS, heartbeatMs: 50 });
    await vi.waitFor(() => inspect(jobId, "{{json .State.Running}}").then((r) => expect(r).toBe(true)), {
      timeout: 15_000,
      interval: 100,
    });
    await runner.stop();

    expect(eventsOf(appends, "job.failed")[0]?.payload).toEqual({ reason: "runner_shutdown" });
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("STALE_LEASE stops the container and never appends again", async () => {
    const jobId = randomUUID();
    const stale = json(409, { error: { code: "STALE_LEASE", message: "old token" }, requestId: "r" });
    const { api, appends } = fakeApi({
      jobId,
      onAppend: (req) => (req.events.some((e) => e.type === "process.output") ? stale : undefined),
    });
    await startJob(api, leaseFor(SLEEP, jobId), OPTS).done;

    expect(terminal(appends)).toBeUndefined();
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("fails with sandbox_image_missing and never runs on the host when the image is absent", async () => {
    const jobId = randomUUID();
    const { api, appends } = fakeApi({ jobId });
    await startJob(api, leaseFor(undefined, jobId), { ...OPTS, image: "nexus-sandbox:does-not-exist" }).done;

    expect(timeline(appends)).toEqual(["job.failed", "→FAILED"]);
    expect(eventsOf(appends, "job.failed")[0]?.payload).toMatchObject({
      reason: "sandbox_image_missing",
      message: expect.stringContaining(SANDBOX_BUILD_COMMAND),
    });
    expect(await gone(jobId)).toBe(true);
  }, 30_000);

  it("crash cleanup removes only this runner's leftover containers", async () => {
    const mine = containerName(randomUUID());
    const other = containerName(randomUUID());
    const start = (name: string, label: string) =>
      docker([
        "run",
        "-d",
        "--rm",
        "--init",
        "--name",
        name,
        "--label",
        `nexus.runner=${label}`,
        SANDBOX_IMAGE,
        "sleep",
        "300",
      ]);
    expect((await start(mine, runnerLabel)).ok).toBe(true);
    expect((await start(other, `${runnerLabel}-other`)).ok).toBe(true);
    try {
      expect(await removeLeftovers(runnerLabel)).toEqual([mine]);
      expect((await docker(["container", "inspect", mine])).ok).toBe(false);
      expect((await docker(["container", "inspect", other])).ok).toBe(true);
    } finally {
      await removeLeftovers(`${runnerLabel}-other`);
    }
  }, 30_000);
});

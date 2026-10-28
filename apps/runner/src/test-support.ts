// Test helpers shared by run.test.ts and sandbox.test.ts. Not imported by runtime code.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppendEventsRequest, HeartbeatRequest, UploadChangesetRequest } from "@nexus/contracts";
import { createApi } from "./api.ts";

export const JOB = "6f1c1d3e-8a4b-4c1e-9f00-000000000001";

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const leaseFor = (
  request: unknown = { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version" },
  jobId = JOB,
) => ({
  jobId,
  request,
  fencingToken: 7,
  leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
});

export type FakeOptions = {
  jobId?: string;
  lease?: unknown;
  cancel?: (appends: AppendEventsRequest[]) => boolean;
  heartbeat?: () => Response;
  onAppend?: (body: AppendEventsRequest) => Response | undefined;
  onChangeset?: (body: UploadChangesetRequest) => Response | undefined;
};

// In-process fake of the runner endpoints, going through the real client (and its schema checks).
export function fakeApi(opts: FakeOptions = {}) {
  const { jobId = JOB } = opts;
  const appends: AppendEventsRequest[] = [];
  const changesets: UploadChangesetRequest[] = [];
  const heartbeats: HeartbeatRequest[] = [];
  let leased = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (path === "/v1/runner/heartbeat") heartbeats.push(body as HeartbeatRequest);
    if (path === "/v1/runner/heartbeat")
      return opts.heartbeat?.() ?? json(200, { cancelJobIds: opts.cancel?.(appends) ? [jobId] : [] });
    if (path === "/v1/runner/lease") {
      if (opts.lease && !leased) {
        leased = true;
        return json(200, opts.lease);
      }
      await sleep(50, undefined, { signal: init?.signal ?? undefined });
      return new Response(null, { status: 204 });
    }
    if (path === `/v1/runner/jobs/${jobId}/events`) {
      const req = body as AppendEventsRequest;
      appends.push(req);
      return (
        opts.onAppend?.(req) ??
        json(200, { lastSequence: appends.length, status: req.transition?.to ?? "RUNNING" })
      );
    }
    if (path === `/v1/runner/jobs/${jobId}/changeset`) {
      const req = body as UploadChangesetRequest;
      changesets.push(req);
      return opts.onChangeset?.(req) ?? json(200, { approvalId: jobId, actionHash: "a".repeat(64) });
    }
    return json(404, { error: { code: "NOT_FOUND", message: path }, requestId: "r" });
  };
  return {
    api: createApi({ baseUrl: "http://127.0.0.1:8787", token: "t", fetch }),
    appends,
    changesets,
    heartbeats,
  };
}

// Event types and `→TRANSITION` markers in submission order; consecutive output batches collapse into one.
export const timeline = (appends: AppendEventsRequest[]) =>
  appends
    .flatMap((a) => [...a.events.map((e) => e.type), ...(a.transition ? [`→${a.transition.to}`] : [])])
    .filter((t, i, all) => !(t === "process.output" && all[i - 1] === "process.output"));
export const eventsOf = (appends: AppendEventsRequest[], type: string) =>
  appends.flatMap((a) => a.events).filter((e) => e.type === type);
export const terminal = (appends: AppendEventsRequest[]) =>
  appends.map((a) => a.transition).find((t) => t && t.to !== "RUNNING" && t.to !== "VERIFYING");
export const hasOutput = (appends: AppendEventsRequest[]) => eventsOf(appends, "process.output").length > 0;
export const stdoutOf = (appends: AppendEventsRequest[]) =>
  eventsOf(appends, "process.output")
    .filter((e) => e.payload.stream === "stdout")
    .map((e) => e.payload.text)
    .join("");

// Looks like a real provider key, so the generic redaction patterns would also catch it.
// Generated per run so no key-shaped literal lives in the repo (secret scanning).
export const FAKE_KEY = `sk-ant-api03-TESTKEY_${randomBytes(24).toString("hex")}`;

export const git = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  }).trim();

// A source repo with one commit on `main`, mirrored bare into <dir>/<owner>/<name>.git.
export async function bareRepo(dir: string, owner = "acme", name = "demo", defaultBranch = "main") {
  const src = await mkdtemp(join(tmpdir(), "nexus-src-"));
  git(["init", "-q", "-b", defaultBranch, src]);
  await writeFile(join(src, "README.md"), "hello\n");
  git(["-C", src, "add", "."]);
  git(["-C", src, "commit", "-q", "-m", "init"]);
  const mirror = join(dir, owner, `${name}.git`);
  await mkdir(join(dir, owner), { recursive: true });
  git(["clone", "-q", "--mirror", src, mirror]);
  await rm(src, { recursive: true, force: true });
  return mirror;
}

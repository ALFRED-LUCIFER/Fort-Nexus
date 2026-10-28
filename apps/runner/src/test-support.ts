// Test helpers shared by run.test.ts and sandbox.test.ts. Not imported by runtime code.
import { setTimeout as sleep } from "node:timers/promises";
import type { AppendEventsRequest } from "@nexus/contracts";
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
};

// In-process fake of the runner endpoints, going through the real client (and its schema checks).
export function fakeApi(opts: FakeOptions = {}) {
  const { jobId = JOB } = opts;
  const appends: AppendEventsRequest[] = [];
  let leased = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
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
    return json(404, { error: { code: "NOT_FOUND", message: path }, requestId: "r" });
  };
  return { api: createApi({ baseUrl: "http://127.0.0.1:8787", token: "t", fetch }), appends };
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

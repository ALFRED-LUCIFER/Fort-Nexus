import { render } from "@testing-library/react";
import { vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { Job, RunEvent, Runner } from "@nexus/contracts";
import { createApp } from "../router.tsx";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message }, requestId: "req-test" }, status);

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}
type Handler = (call: Call) => Response | Promise<Response>;

/** Stubs global fetch with `"METHOD /path"` handlers; unknown routes answer 404. Returns the call log. */
export function mockFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : undefined;
      const url = new URL(req ? req.url : String(input), window.location.origin);
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const raw = init?.body ?? null;
      const call: Call = {
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: new Headers(init?.headers ?? req?.headers),
        body: typeof raw === "string" ? JSON.parse(raw) : raw,
      };
      calls.push(call);
      const h = handlers[`${method} ${url.pathname}`];
      return h ? h(call) : apiError(404, "NOT_FOUND", `no mock for ${method} ${url.pathname}`);
    }),
  );
  return calls;
}

/** Minimal EventSource stand-in; tests drive it with `emit`. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  emit(type: string, data: unknown, id?: number) {
    const e = new MessageEvent<string>(type, {
      data: JSON.stringify(data),
      lastEventId: id === undefined ? "" : String(id),
    });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

export function renderApp(path: string) {
  const { router, queryClient } = createApp(createMemoryHistory({ initialEntries: [path] }));
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

export const ME = { id: "u1", email: "owner@example.com", name: "Owner" };
const T0 = "2026-10-28T10:00:00.000Z";

export const runner = (over: Partial<Runner> = {}): Runner => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "test-host",
  os: "darwin",
  version: "0.1.0",
  capacity: 1,
  status: "ONLINE",
  lastHeartbeatAt: new Date().toISOString(),
  createdAt: T0,
  ...over,
});

export const JOB_ID = "22222222-2222-4222-8222-222222222222";
export const job = (over: Partial<Job> = {}): Job => ({
  id: JOB_ID,
  jobType: "RUNNER_DIAGNOSTIC",
  status: "QUEUED",
  riskTier: "R0",
  request: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version" },
  runnerId: null,
  outcome: null,
  stateVersion: 1,
  lastEventSequence: 0,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

export const event = (
  sequence: number,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {},
): RunEvent => ({
  eventId: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
  jobId: JOB_ID,
  sequence,
  occurredAt: new Date(Date.parse(T0) + sequence * 1000).toISOString(),
  type,
  stage: null,
  actor: "runner",
  payload,
});

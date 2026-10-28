import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  ApiError,
  AppendEventsRequest,
  AppendEventsResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseResponse,
  RUNNER_LEASE_POLL_MS,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from "@nexus/contracts";

const REQUEST_TIMEOUT_MS = 10_000;

// `request` is re-validated by the job, so a lease with an unknown request can still be reported FAILED.
const LeaseEnvelope = LeaseResponse.extend({ request: z.unknown() });
export type Lease = z.infer<typeof LeaseEnvelope>;

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "ApiCallError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const isAuthError = (err: unknown): boolean =>
  err instanceof ApiCallError && (err.status === 401 || err.status === 403);

export type RunnerApi = ReturnType<typeof createApi>;

export function createApi(opts: { baseUrl: string; token?: string; fetch?: typeof fetch }) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method: "POST",
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch (err) {
      if (signal?.aborted) throw err; // caller gave up; not an API failure
      throw new ApiCallError(
        `${path}: ${err instanceof Error ? err.message : String(err)}`,
        0,
        "NETWORK",
        true,
      );
    }
    const json: unknown = res.status === 204 ? null : await res.json().catch(() => undefined);
    if (!res.ok) {
      const apiErr = ApiError.safeParse(json);
      const code = apiErr.success ? apiErr.data.error.code : `HTTP_${res.status}`;
      const detail = apiErr.success ? `: ${apiErr.data.error.message}` : "";
      throw new ApiCallError(
        `${path}: ${res.status} ${code}${detail}`,
        res.status,
        code,
        res.status >= 500 || res.status === 429,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ApiCallError(`${path}: response failed validation`, res.status, "INVALID_RESPONSE", false);
    return parsed.data;
  }

  return {
    register: (req: z.input<typeof RunnerRegisterRequest>) =>
      post("/v1/runner/register", RunnerRegisterRequest.parse(req), RunnerRegisterResponse),
    heartbeat: (req: HeartbeatRequest, signal?: AbortSignal) =>
      post("/v1/runner/heartbeat", HeartbeatRequest.parse(req), HeartbeatResponse, signal),
    // Long-poll: null means nothing was queued within RUNNER_LEASE_POLL_MS (204).
    lease: (signal?: AbortSignal) =>
      post(
        "/v1/runner/lease",
        undefined,
        LeaseEnvelope.nullable(),
        signal,
        RUNNER_LEASE_POLL_MS + REQUEST_TIMEOUT_MS,
      ),
    appendEvents: (jobId: string, req: z.input<typeof AppendEventsRequest>, signal?: AbortSignal) =>
      post(
        `/v1/runner/jobs/${encodeURIComponent(jobId)}/events`,
        AppendEventsRequest.parse(req),
        AppendEventsResponse,
        signal,
      ),
  };
}

// Retries transient failures (network, timeout, 5xx, 429) with exponential backoff until `forMs` has passed.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { forMs: number; signal?: AbortSignal },
): Promise<T> {
  const deadline = Date.now() + opts.forMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ApiCallError) || !err.retryable || Date.now() >= deadline) throw err;
      await sleep(Math.min(250 * 2 ** attempt, 5_000), undefined, { signal: opts.signal });
    }
  }
}

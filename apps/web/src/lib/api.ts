import { z } from "zod";
import {
  ApiError,
  CreateJobResponse,
  IDEMPOTENCY_HEADER,
  Job,
  JobList,
  Me,
  PairingCodeResponse,
  RunnerList,
  type CreateJobRequest,
  type JobStatus,
} from "@nexus/contracts";

export type { Me } from "@nexus/contracts";

/** Thrown for every failed API call; `message` is safe to show to the owner. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const UNREACHABLE = "Can't reach the NEXUS API. Check that it is running on the home machine.";

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError(UNREACHABLE, 0, "UNREACHABLE");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(body);
    if (err.success) throw new ApiRequestError(err.data.error.message, res.status, err.data.error.code);
    // The dev proxy answers 5xx without an ApiError body when the API is down.
    throw new ApiRequestError(
      res.status >= 500 ? UNREACHABLE : `Request failed (HTTP ${res.status}).`,
      res.status,
      "HTTP",
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiRequestError(
      "The API sent a response NEXUS doesn't understand.",
      res.status,
      "BAD_RESPONSE",
    );
  return parsed.data;
}

const post = (headers: Record<string, string> = {}, body?: unknown): RequestInit => ({
  method: "POST",
  headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => request("/v1/me", Me),
  runners: () => request("/v1/runners", RunnerList).then((r) => r.items),
  pairRunner: () => request("/v1/runners/pair", PairingCodeResponse, post()),
  jobs: (q: { limit: number; status?: JobStatus }) =>
    request(
      `/v1/jobs?${new URLSearchParams({ limit: String(q.limit), ...(q.status && { status: q.status }) })}`,
      JobList,
    ),
  job: (id: string) => request(`/v1/jobs/${encodeURIComponent(id)}`, Job),
  createJob: (body: CreateJobRequest, idempotencyKey: string) =>
    request("/v1/jobs", CreateJobResponse, post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body)),
  cancelJob: (id: string) => request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, Job, post()),
};

export const keys = {
  me: ["me"] as const,
  runners: ["runners"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["jobs", id] as const,
};

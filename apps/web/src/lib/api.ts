import { z } from "zod";
import {
  ActionProposal,
  ApiError,
  Approval,
  ApprovalList,
  ConnectionTestResult,
  Connector,
  ConnectorList,
  CreateJobResponse,
  GithubStatus,
  IDEMPOTENCY_HEADER,
  IssueDetail,
  IssueList,
  Job,
  JobList,
  Me,
  MetricDictionary,
  PairingCodeResponse,
  PaymentFailuresResponse,
  RepositoryList,
  RunnerList,
  SalesSummaryResponse,
  PostTurnResponse,
  Thread,
  ThreadDetail,
  ThreadList,
  type ApprovalDecisionRequest,
  type ApprovalStatus,
  type CreateConnectorRequest,
  type CreateJobRequest,
  type JobStatus,
  type UpdateConnectorRequest,
  type ProposalDecisionRequest,
} from "@nexus/contracts";

export type { Me } from "@nexus/contracts";

/** Thrown for every failed API call; `message` is safe to show to the owner. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Issue-list filters as they live in the board URL; the API validates them (IssueListQuery). */
export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string;
  assignee?: string;
  q?: string;
  page?: number;
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
    if (err.success)
      throw new ApiRequestError(
        err.data.error.message,
        res.status,
        err.data.error.code,
        err.data.error.details,
      );
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

// The board always shows today against the same clock window yesterday (BIZ-G01).
const metricQuery = (connectorId: string) =>
  new URLSearchParams({ connectorId, day: "today", compare: "true" });

const send = (method: "PATCH" | "PUT", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
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
  githubStatus: () => request("/v1/github/status", GithubStatus),
  repositories: () => request("/v1/repositories", RepositoryList),
  issues: (repoId: string, f: IssueFilters) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request(`/v1/repositories/${encodeURIComponent(repoId)}/issues?${params}`, IssueList);
  },
  issue: (repoId: string, number: number) =>
    request(`/v1/repositories/${encodeURIComponent(repoId)}/issues/${number}`, IssueDetail),
  approvals: (q: ApprovalQuery) =>
    request(`/v1/approvals?${new URLSearchParams(q)}`, ApprovalList).then((l) => l.items),
  // Answers only after the push finished: EXECUTED with result, or FAILED with error.
  decide: (id: string, body: ApprovalDecisionRequest) =>
    request(`/v1/approvals/${encodeURIComponent(id)}/decision`, Approval, post({}, body)),
  connectors: () => request("/v1/business/connectors", ConnectorList).then((l) => l.items),
  createConnector: (body: CreateConnectorRequest) =>
    request("/v1/business/connectors", Connector, post({}, body)),
  updateConnector: (id: string, body: UpdateConnectorRequest) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}`, Connector, send("PATCH", body)),
  testConnector: (id: string) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}/test`, ConnectionTestResult, post()),
  dictionary: (id: string) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}/dictionary`, MetricDictionary),
  putDictionary: (id: string, body: MetricDictionary) =>
    request(
      `/v1/business/connectors/${encodeURIComponent(id)}/dictionary`,
      MetricDictionary,
      send("PUT", body),
    ),
  salesSummary: (connectorId: string) =>
    request(`/v1/business/metrics/sales-summary?${metricQuery(connectorId)}`, SalesSummaryResponse),
  paymentFailures: (connectorId: string) =>
    request(`/v1/business/metrics/payment-failures?${metricQuery(connectorId)}`, PaymentFailuresResponse),
  threads: () => request("/v1/conversations?limit=50", ThreadList),
  thread: (id: string) => request(`/v1/conversations/${encodeURIComponent(id)}`, ThreadDetail),
  createThread: () => request("/v1/conversations", Thread, post({}, {})),
  postTurn: (threadId: string, text: string, idempotencyKey: string) =>
    request(
      `/v1/conversations/${encodeURIComponent(threadId)}/turns`,
      PostTurnResponse,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, { text }),
    ),
  decideProposal: (id: string, body: ProposalDecisionRequest) =>
    request(`/v1/conversations/proposals/${encodeURIComponent(id)}/decision`, ActionProposal, post({}, body)),
};

export type ApprovalQuery = { status: ApprovalStatus } | { jobId: string };

export const keys = {
  me: ["me"] as const,
  runners: ["runners"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["jobs", id] as const,
  github: ["github"] as const,
  repositories: ["github", "repositories"] as const,
  issues: (repoId: string, f: IssueFilters) => ["github", "issues", repoId, f] as const,
  issue: (repoId: string, number: number) => ["github", "issue", repoId, number] as const,
  approvals: ["approvals"] as const,
  approvalsBy: (q: ApprovalQuery) => ["approvals", q] as const,
  connectors: ["business", "connectors"] as const,
  dictionary: (id: string) => ["business", "dictionary", id] as const,
  metric: (name: "sales" | "payments", connectorId: string) =>
    ["business", "metric", name, connectorId] as const,
  threads: ["conversations"] as const,
  thread: (id: string) => ["conversations", id] as const,
};

import { z } from "zod";
import {
  ApiError,
  Approval,
  ApprovalList,
  CreateJobResponse,
  GithubStatus,
  IDEMPOTENCY_HEADER,
  IssueDetail,
  IssueList,
  Job,
  JobList,
  Me,
  Notification,
  NotificationList,
  OwnerSessionList,
  PairingCodeResponse,
  Project,
  RepositoryList,
  Runner,
  RunnerList,
  SystemControls,
  WorkspaceList,
  type ApprovalDecisionRequest,
  type ApprovalStatus,
  type CreateJobRequest,
  type CreateProjectRequest,
  type JobStatus,
  type UpdateProjectRequest,
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

const post = (headers: Record<string, string> = {}, body?: unknown, method = "POST"): RequestInit => ({
  method,
  headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => request("/v1/me", Me),
  runners: () => request("/v1/runners", RunnerList).then((r) => r.items),
  pairRunner: () => request("/v1/runners/pair", PairingCodeResponse, post()),
  revokeRunner: (id: string) => request(`/v1/runners/${encodeURIComponent(id)}/revoke`, Runner, post()),
  system: () => request("/v1/system", SystemControls),
  setEmergencyStop: (engaged: boolean) =>
    request("/v1/system/emergency-stop", SystemControls, post({}, { engaged }, "PUT")),
  setDailyBudget: (dailyCapUsd: number) =>
    request("/v1/system/budget", SystemControls, post({}, { dailyCapUsd }, "PUT")),
  sessions: () => request("/v1/sessions", OwnerSessionList).then((l) => l.items),
  // 204: no body.
  revokeSession: (id: string) =>
    request(`/v1/sessions/${encodeURIComponent(id)}`, z.null(), post({}, undefined, "DELETE")),
  // projectId omitted = the owner-wide aggregate (the read-only "All" view).
  jobs: (q: { limit: number; status?: JobStatus; projectId?: string }) =>
    request(
      `/v1/jobs?${new URLSearchParams({
        limit: String(q.limit),
        ...(q.status && { status: q.status }),
        ...(q.projectId && { projectId: q.projectId }),
      })}`,
      JobList,
    ),
  job: (id: string) => request(`/v1/jobs/${encodeURIComponent(id)}`, Job),
  createJob: (body: CreateJobRequest, idempotencyKey: string) =>
    request("/v1/jobs", CreateJobResponse, post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body)),
  cancelJob: (id: string) => request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, Job, post()),
  githubStatus: () => request("/v1/github/status", GithubStatus),
  // With a project: only the repositories bound to it. Without: every installed repository (binding UI).
  repositories: (projectId?: string) =>
    request(`/v1/repositories${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`, RepositoryList),
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
  // Newest 100 of the scope; owner-wide notices (projectId null) are in every project's list.
  notifications: (projectId?: string) =>
    request(
      `/v1/notifications?${new URLSearchParams({ limit: "100", ...(projectId && { projectId }) })}`,
      NotificationList,
    ),
  setNotificationStatus: (id: string, status: "READ" | "ACKNOWLEDGED") =>
    request(`/v1/notifications/${encodeURIComponent(id)}/status`, Notification, post({}, { status })),
  workspaces: () => request("/v1/workspaces", WorkspaceList),
  createProject: (workspaceId: string, body: CreateProjectRequest) =>
    request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`, Project, post({}, body)),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    request(`/v1/projects/${encodeURIComponent(id)}`, Project, post({}, body, "PATCH")),
  bindRepository: (projectId: string, repoId: string, bound: boolean) =>
    request(
      `/v1/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repoId)}`,
      Project,
      post({}, undefined, bound ? "PUT" : "DELETE"),
    ),
};

export type ApprovalQuery = { status: ApprovalStatus; projectId?: string } | { jobId: string };

export const keys = {
  me: ["me"] as const,
  runners: ["runners"] as const,
  system: ["system"] as const,
  sessions: ["sessions"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["jobs", id] as const,
  github: ["github"] as const,
  repositories: ["github", "repositories"] as const,
  repositoriesOf: (projectId: string | undefined) => ["github", "repositories", projectId ?? "all"] as const,
  issues: (repoId: string, f: IssueFilters) => ["github", "issues", repoId, f] as const,
  issue: (repoId: string, number: number) => ["github", "issue", repoId, number] as const,
  approvals: ["approvals"] as const,
  approvalsBy: (q: ApprovalQuery) => ["approvals", q] as const,
  workspaces: ["workspaces"] as const,
  notifications: ["notifications"] as const,
  notificationsOf: (projectId: string | undefined) => ["notifications", projectId ?? "all"] as const,
};

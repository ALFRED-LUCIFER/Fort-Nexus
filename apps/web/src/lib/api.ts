import { z } from "zod";
import {
  ActionProposal,
  ApiError,
  Approval,
  ApprovalList,
  AutomationClient,
  AutomationClientList,
  AutomationClientSecret,
  AutomationRunList,
  ConnectionTestResult,
  Connector,
  ConnectorList,
  CreateJobResponse,
  Finding,
  FindingExplanation,
  FindingList,
  GithubStatus,
  HealthCheck,
  IDEMPOTENCY_HEADER,
  Incident,
  IncidentTriage,
  IssueDetail,
  IssueList,
  Job,
  JobList,
  Me,
  MetricDictionary,
  MonitoredApp,
  MonitoredAppList,
  Notification,
  NotificationList,
  OwnerSessionList,
  PairingCodeResponse,
  PaymentFailuresResponse,
  PostTurnResponse,
  Project,
  RepositoryList,
  ResearchBrief,
  ResearchRun,
  ResearchRunList,
  RevenueSummaryResponse,
  Runner,
  RunnerList,
  SalesSummaryResponse,
  SystemControls,
  Thread,
  ThreadDetail,
  ThreadList,
  TopProductsResponse,
  Watchlist,
  WatchlistList,
  WorkspaceList,
  type ApprovalDecisionRequest,
  type ApprovalStatus,
  type CreateAutomationClientRequest,
  type CreateConnectorRequest,
  type CreateJobRequest,
  type CreateMonitoredAppRequest,
  type CreateProjectRequest,
  type CreateThreadRequest,
  type CreateWatchlistRequest,
  type FindingSearchQuery,
  type JobStatus,
  type ProposalDecisionRequest,
  type UpdateAutomationClientRequest,
  type UpdateConnectorRequest,
  type UpdateMonitoredAppRequest,
  type UpdateProjectRequest,
  type UpdateWatchlistRequest,
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

const post = (headers: Record<string, string> = {}, body?: unknown, method = "POST"): RequestInit => ({
  method,
  headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// The board always shows today against the same clock window yesterday (BIZ-G01).
const metricQuery = (connectorId: string) =>
  new URLSearchParams({ connectorId, day: "today", compare: "true" });

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
  connectors: (projectId?: string) =>
    request(
      `/v1/business/connectors${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      ConnectorList,
    ).then((l) => l.items),
  createConnector: (body: CreateConnectorRequest) =>
    request("/v1/business/connectors", Connector, post({}, body)),
  updateConnector: (id: string, body: UpdateConnectorRequest) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}`, Connector, post({}, body, "PATCH")),
  testConnector: (id: string) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}/test`, ConnectionTestResult, post()),
  dictionary: (id: string) =>
    request(`/v1/business/connectors/${encodeURIComponent(id)}/dictionary`, MetricDictionary),
  putDictionary: (id: string, body: MetricDictionary) =>
    request(
      `/v1/business/connectors/${encodeURIComponent(id)}/dictionary`,
      MetricDictionary,
      post({}, body, "PUT"),
    ),
  salesSummary: (connectorId: string) =>
    request(`/v1/business/metrics/sales-summary?${metricQuery(connectorId)}`, SalesSummaryResponse),
  paymentFailures: (connectorId: string) =>
    request(`/v1/business/metrics/payment-failures?${metricQuery(connectorId)}`, PaymentFailuresResponse),
  revenue: (connectorId: string) =>
    request(`/v1/business/metrics/revenue?${metricQuery(connectorId)}`, RevenueSummaryResponse),
  topProducts: (connectorId: string) =>
    request(`/v1/business/metrics/top-products?${metricQuery(connectorId)}`, TopProductsResponse),
  // projectId omitted = the read-only "All" view across the owner's projects.
  threads: (projectId?: string) =>
    request(
      `/v1/conversations?${new URLSearchParams({ limit: "50", ...(projectId && { projectId }) })}`,
      ThreadList,
    ),
  thread: (id: string) => request(`/v1/conversations/${encodeURIComponent(id)}`, ThreadDetail),
  createThread: (body: CreateThreadRequest) => request("/v1/conversations", Thread, post({}, body)),
  postTurn: (threadId: string, text: string, idempotencyKey: string) =>
    request(
      `/v1/conversations/${encodeURIComponent(threadId)}/turns`,
      PostTurnResponse,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, { text }),
    ),
  decideProposal: (id: string, body: ProposalDecisionRequest) =>
    request(`/v1/conversations/proposals/${encodeURIComponent(id)}/decision`, ActionProposal, post({}, body)),
  watchlists: (projectId: string | undefined) =>
    request(
      `/v1/research/watchlists${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      WatchlistList,
    ).then((l) => l.items),
  createWatchlist: (body: z.input<typeof CreateWatchlistRequest>) =>
    request("/v1/research/watchlists", Watchlist, post({}, body)),
  updateWatchlist: (id: string, body: UpdateWatchlistRequest) =>
    request(`/v1/research/watchlists/${encodeURIComponent(id)}`, Watchlist, post({}, body, "PATCH")),
  runWatchlist: (id: string, idempotencyKey: string) =>
    request(
      `/v1/research/watchlists/${encodeURIComponent(id)}/run`,
      ResearchRun,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }),
    ),
  researchRuns: (watchlistId: string) =>
    request(`/v1/research/runs?${new URLSearchParams({ watchlistId })}`, ResearchRunList).then(
      (l) => l.items,
    ),
  brief: (runId: string) => request(`/v1/research/runs/${encodeURIComponent(runId)}`, ResearchBrief),
  findings: (q: FindingFilters & { cursor?: string }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request(`/v1/research/findings?${params}`, FindingList);
  },
  readFinding: (id: string) =>
    request(`/v1/research/findings/${encodeURIComponent(id)}/read`, Finding, post()),
  // Cache-once on the server: a repeat returns the stored explanation without calling the model.
  explainFinding: (id: string) =>
    request(`/v1/research/findings/${encodeURIComponent(id)}/explain`, FindingExplanation, post()),
  // projectId omitted = the read-only "All" view.
  automationClients: (projectId?: string) =>
    request(
      `/v1/automations/clients${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      AutomationClientList,
    ).then((l) => l.items),
  createAutomationClient: (body: z.input<typeof CreateAutomationClientRequest>) =>
    request("/v1/automations/clients", AutomationClientSecret, post({}, body)),
  updateAutomationClient: (id: string, body: UpdateAutomationClientRequest) =>
    request(`/v1/automations/clients/${encodeURIComponent(id)}`, AutomationClient, post({}, body, "PATCH")),
  rotateAutomationClient: (id: string) =>
    request(`/v1/automations/clients/${encodeURIComponent(id)}/rotate`, AutomationClientSecret, post()),
  automationRuns: (projectId?: string) =>
    request(
      `/v1/automations/runs${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      AutomationRunList,
    ).then((l) => l.items),
  // With a project: its apps. Without: every project's apps (the read-only "All" view).
  monitoredApps: (projectId?: string) =>
    request(
      `/v1/monitoring/apps${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      MonitoredAppList,
    ).then((l) => l.items),
  createMonitoredApp: (body: z.input<typeof CreateMonitoredAppRequest>) =>
    request("/v1/monitoring/apps", MonitoredApp, post({}, body)),
  updateMonitoredApp: (id: string, body: UpdateMonitoredAppRequest) =>
    request(`/v1/monitoring/apps/${encodeURIComponent(id)}`, MonitoredApp, post({}, body, "PATCH")),
  checkApp: (id: string) =>
    request(`/v1/monitoring/apps/${encodeURIComponent(id)}/check`, HealthCheck, post()),
  incident: (id: string) => request(`/v1/incidents/${encodeURIComponent(id)}`, Incident),
  setIncidentStatus: (id: string, status: "ACKNOWLEDGED" | "RESOLVED") =>
    request(`/v1/incidents/${encodeURIComponent(id)}/status`, Incident, post({}, { status })),
  triageIncident: (id: string) =>
    request(`/v1/incidents/${encodeURIComponent(id)}/triage`, IncidentTriage, post()),
};

export type FindingFilters = Partial<Omit<FindingSearchQuery, "cursor">>;

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
  connectors: ["business", "connectors"] as const,
  connectorsOf: (projectId: string | undefined) => ["business", "connectors", projectId ?? "all"] as const,
  dictionary: (id: string) => ["business", "dictionary", id] as const,
  metric: (name: "sales" | "payments" | "revenue" | "topProducts", connectorId: string) =>
    ["business", "metric", name, connectorId] as const,
  threads: ["conversations"] as const,
  threadsOf: (projectId: string | undefined) => ["conversations", "list", projectId ?? "all"] as const,
  thread: (id: string) => ["conversations", id] as const,
  research: ["research"] as const,
  watchlists: ["research", "watchlists"] as const,
  watchlistsOf: (projectId: string | undefined) => ["research", "watchlists", projectId ?? "all"] as const,
  researchRuns: (watchlistId: string) => ["research", "runs", watchlistId] as const,
  brief: (runId: string) => ["research", "brief", runId] as const,
  findings: (f: FindingFilters) => ["research", "findings", f] as const,
  automations: ["automations"] as const,
  automationClients: (projectId: string | undefined) =>
    ["automations", "clients", projectId ?? "all"] as const,
  automationRuns: (projectId: string | undefined) => ["automations", "runs", projectId ?? "all"] as const,
  monitoring: ["monitoring"] as const,
  monitoredApps: (projectId: string | undefined) => ["monitoring", "apps", projectId ?? "all"] as const,
  incident: (id: string) => ["monitoring", "incident", id] as const,
};

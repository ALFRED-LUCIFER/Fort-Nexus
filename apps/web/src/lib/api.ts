import { z } from "zod";
import {
  ActionProposal,
  AgentList,
  AgentPerformance,
  HomeSummary,
  NotificationPreferences,
  PushDevice,
  PushDeviceList,
  TestPushResponse,
  type SubscribePushRequest,
  Transcript,
  VoiceStatus,
  type SpeakRequest,
  type UpdateVoiceSettingsRequest,
  JobDraft,
  JobDraftList,
  JobDraftPreview,
  JobHistoryList,
  type AgentPerformanceQuery,
  type ApproveJobDraftRequest,
  type CreateJobDraftRequest,
  type JobDraftPreviewRequest,
  type JobHistoryQuery,
  type JobFeedbackRequest,
  type KeepFixingRequest,
  type UpdateJobDraftRequest,
  AgentProfileVersion,
  AgentProfileVersionList,
  ApiError,
  Approval,
  ApprovalList,
  AutomationClient,
  AutomationClientList,
  AutomationClientSecret,
  AutomationRunList,
  CloudHandoff,
  CloudHandoffPreview,
  CloudHandoffState,
  ConnectionTestResult,
  Connector,
  ConnectorList,
  CreateJobResponse,
  DeepDive,
  DeepDiveDetail,
  DeepDiveList,
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
  IssuePreview,
  Job,
  JobFeedback,
  JobFeedbackList,
  JobList,
  Me,
  MetricDictionary,
  MonitoredApp,
  MonitoredAppList,
  Notification,
  NotificationList,
  Opportunity,
  OpportunityList,
  ResearchDomain,
  ResearchDomainList,
  OwnerSessionList,
  PairingCodeResponse,
  PaymentFailuresResponse,
  Plan,
  PlanList,
  PostTurnResponse,
  Project,
  RepositoryDetails,
  RepositoryHealthList,
  RepositoryList,
  SetupStatus,
  Workspace,
  ResearchBrief,
  ResearchRun,
  ResearchRunList,
  RemoteAccessStatus,
  RevenueSummaryResponse,
  Runner,
  RunnerList,
  SalesSummaryResponse,
  SearchProviderStatus,
  SystemControls,
  Thread,
  ThreadDetail,
  ThreadList,
  TopProductsResponse,
  Watchlist,
  WatchlistList,
  WorkspaceList,
  type AgentKey,
  type ApprovalDecisionRequest,
  type ApprovalStatus,
  type CreateAutomationClientRequest,
  type CreateCloudHandoffRequest,
  type CreateConnectorRequest,
  type CreateDeepDiveRequest,
  type CreateJobRequest,
  type CreateMonitoredAppRequest,
  type CreateOpportunityIssueRequest,
  type CreatePlanRequest,
  type PutResearchDomainRequest,
  type CreateProjectRequest,
  type CreateThreadRequest,
  type CreateWatchlistRequest,
  type FindingSearchQuery,
  type JobStatus,
  type OpportunityStatus,
  type PlanDecisionRequest,
  type ProposalDecisionRequest,
  type SetAgentProfileRequest,
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
  remoteAccess: () => request("/v1/remote-access", RemoteAccessStatus),
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
  retryJob: (id: string, idempotencyKey: string) =>
    request(
      `/v1/jobs/${encodeURIComponent(id)}/retry`,
      CreateJobResponse,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }),
    ),
  // Keep fixing: a new job from this one's stored changes (or the owner's answer to its questions).
  keepFixing: (id: string, idempotencyKey: string, note?: KeepFixingRequest["note"]) =>
    request(
      `/v1/jobs/${encodeURIComponent(id)}/keep-fixing`,
      CreateJobResponse,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, note === undefined ? undefined : { note }),
    ),
  sendFeedback: (id: string, text: JobFeedbackRequest["text"], idempotencyKey: string) =>
    request(
      `/v1/jobs/${encodeURIComponent(id)}/feedback`,
      JobFeedback,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, { text }),
    ),
  jobFeedback: (id: string) =>
    request(`/v1/jobs/${encodeURIComponent(id)}/feedback`, JobFeedbackList).then((l) => l.items),
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
  // The issue's routine status and newest Claude cloud handoff in this project (docs/specs/cloud-handoff.md).
  cloudHandoff: (repoId: string, number: number, projectId: string) =>
    request(
      `/v1/repositories/${encodeURIComponent(repoId)}/issues/${number}/cloud-handoff?${new URLSearchParams({ projectId })}`,
      CloudHandoffState,
    ),
  previewCloudHandoff: (repoId: string, number: number, projectId: string) =>
    request(
      `/v1/repositories/${encodeURIComponent(repoId)}/issues/${number}/cloud-handoff/preview`,
      CloudHandoffPreview,
      post({}, { projectId }),
    ),
  // Fires the routine once; answers only after Anthropic did (STARTED), or with an error (FAILED / UNKNOWN).
  createCloudHandoff: (
    repoId: string,
    number: number,
    body: CreateCloudHandoffRequest,
    idempotencyKey: string,
  ) =>
    request(
      `/v1/repositories/${encodeURIComponent(repoId)}/issues/${number}/cloud-handoff`,
      CloudHandoff,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body),
    ),
  // FR-GH-05: PRs, issues and CI per repository (the project's bound ones, or every installed one in All).
  repositoryHealth: (projectId?: string) =>
    request(
      `/v1/repositories/health${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`,
      RepositoryHealthList,
    ),
  repositoryDetails: (repoId: string) =>
    request(`/v1/repositories/${encodeURIComponent(repoId)}/details`, RepositoryDetails),
  setup: (projectId?: string) =>
    request(`/v1/setup${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`, SetupStatus),
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
  setWorkspaceEnabled: (id: string, enabled: boolean) =>
    request(`/v1/workspaces/${encodeURIComponent(id)}`, Workspace, post({}, { enabled }, "PATCH")),
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
  deepDives: (projectId: string | undefined) =>
    request(
      `/v1/research/deep-dives?${new URLSearchParams({ limit: "50", ...(projectId && { projectId }) })}`,
      DeepDiveList,
    ),
  deepDive: (id: string) => request(`/v1/research/deep-dives/${encodeURIComponent(id)}`, DeepDiveDetail),
  // A retry with the same key returns the same dive: the cap is reserved once.
  createDeepDive: (body: CreateDeepDiveRequest, idempotencyKey: string) =>
    request("/v1/research/deep-dives", DeepDive, post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body)),
  cancelDeepDive: (id: string) =>
    request(`/v1/research/deep-dives/${encodeURIComponent(id)}/cancel`, DeepDive, post()),
  searchProvider: () => request("/v1/research/search-provider", SearchProviderStatus),
  // Research → Sources: the workspace's domain rules (owner policy for the researcher's web reading).
  domains: (workspaceId: string) =>
    request(`/v1/research/domains?${new URLSearchParams({ workspaceId })}`, ResearchDomainList).then(
      (l) => l.items,
    ),
  putDomain: (body: PutResearchDomainRequest) =>
    request("/v1/research/domains", ResearchDomain, post({}, body, "PUT")),
  // 204: no body.
  deleteDomain: (id: string) =>
    request(`/v1/research/domains/${encodeURIComponent(id)}`, z.null(), post({}, undefined, "DELETE")),
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
  // Profiles resolve per project, so these need one.
  agents: (projectId: string) =>
    request(`/v1/agents?${new URLSearchParams({ projectId })}`, AgentList).then((l) => l.items),
  agentVersions: (agent: AgentKey, projectId: string) =>
    request(
      `/v1/agents/${agent}/versions?${new URLSearchParams({ projectId })}`,
      AgentProfileVersionList,
    ).then((l) => l.items),
  setAgentProfile: (agent: AgentKey, body: SetAgentProfileRequest) =>
    request(`/v1/agents/${agent}/profile`, AgentProfileVersion, post({}, body, "PUT")),
  // projectId omitted = the read-only "All" view.
  plans: (projectId?: string) =>
    request(`/v1/plans${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`, PlanList).then(
      (l) => l.items,
    ),
  plan: (id: string) => request(`/v1/plans/${encodeURIComponent(id)}`, Plan),
  // Drafting calls the model: a retry with the same key returns the same plan.
  createPlan: (body: CreatePlanRequest, idempotencyKey: string) =>
    request("/v1/plans", Plan, post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body)),
  decidePlan: (id: string, body: PlanDecisionRequest) =>
    request(`/v1/plans/${encodeURIComponent(id)}/decision`, Plan, post({}, body)),
  cancelPlan: (id: string) => request(`/v1/plans/${encodeURIComponent(id)}/cancel`, Plan, post()),
  // projectId omitted = the read-only "All" view. Ranked by the server (confidence, verified evidence, newest).
  opportunities: (q: { projectId?: string; status?: OpportunityStatus }) =>
    request(
      `/v1/research/opportunities?${new URLSearchParams({ limit: "20", ...(q.projectId && { projectId: q.projectId }), ...(q.status && { status: q.status }) })}`,
      OpportunityList,
    ).then((l) => l.items),
  opportunity: (id: string) => request(`/v1/research/opportunities/${encodeURIComponent(id)}`, Opportunity),
  dismissOpportunity: (id: string) =>
    request(`/v1/research/opportunities/${encodeURIComponent(id)}/dismiss`, Opportunity, post()),
  previewIssue: (id: string, repositoryId: string) =>
    request(
      `/v1/research/opportunities/${encodeURIComponent(id)}/issue-preview`,
      IssuePreview,
      post({}, { repositoryId }),
    ),
  // Answers only after GitHub did: ISSUE_CREATED with the issue, or an error.
  createOpportunityIssue: (id: string, body: CreateOpportunityIssueRequest, idempotencyKey: string) =>
    request(
      `/v1/research/opportunities/${encodeURIComponent(id)}/issue`,
      Opportunity,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body),
    ),
  // Jobs page: projectId omitted = the read-only "All" view.
  jobHistory: (q: Partial<JobHistoryQuery>) => request(`/v1/jobs/history?${searchOf(q)}`, JobHistoryList),
  agentPerformance: (q: Partial<AgentPerformanceQuery>) =>
    request(`/v1/agents/performance?${searchOf(q)}`, AgentPerformance),
  // Drafting calls the model once: a retry with the same key returns the same draft.
  createJobDraft: (body: CreateJobDraftRequest, idempotencyKey: string) =>
    request("/v1/job-drafts", JobDraft, post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body)),
  jobDrafts: (projectId?: string) =>
    request(`/v1/job-drafts${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`, JobDraftList),
  jobDraft: (id: string) => request(`/v1/job-drafts/${encodeURIComponent(id)}`, JobDraft),
  updateJobDraft: (id: string, body: UpdateJobDraftRequest) =>
    request(`/v1/job-drafts/${encodeURIComponent(id)}`, JobDraft, post({}, body, "PATCH")),
  previewJobDraft: (id: string, body: JobDraftPreviewRequest) =>
    request(`/v1/job-drafts/${encodeURIComponent(id)}/preview`, JobDraftPreview, post({}, body)),
  // Answers after GitHub created the issue (if any) and the job exists: STARTED with jobId, or an error.
  approveJobDraft: (id: string, body: ApproveJobDraftRequest, idempotencyKey: string) =>
    request(
      `/v1/job-drafts/${encodeURIComponent(id)}/approve`,
      JobDraft,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }, body),
    ),
  discardJobDraft: (id: string) =>
    request(`/v1/job-drafts/${encodeURIComponent(id)}/discard`, JobDraft, post()),
  // Cofounder home: projectId omitted = the read-only "All" view.
  home: (projectId?: string) =>
    request(`/v1/home${projectId ? `?${new URLSearchParams({ projectId })}` : ""}`, HomeSummary),
  voiceStatus: () => request("/v1/voice/status", VoiceStatus),
  updateVoiceSettings: (body: UpdateVoiceSettingsRequest) =>
    request("/v1/voice/settings", VoiceStatus, post({}, body, "PUT")),
  // The raw clip as recorded; the server sends it to the owner's speech provider and returns the words to review.
  transcribe: (projectId: string, audio: Blob, durationMs: number) =>
    request(`/v1/voice/transcribe?${new URLSearchParams({ projectId })}`, Transcript, {
      method: "POST",
      headers: { "content-type": audio.type, "x-audio-duration-ms": String(Math.round(durationMs)) },
      body: audio,
    }),
  // audio/mpeg of the reply, spoken by the owner's configured voice.
  speak: (body: SpeakRequest) => requestBlob("/v1/voice/speak", post({}, body)),
  // Phone push (Settings → Notifications).
  devices: () => request("/v1/devices", PushDeviceList),
  subscribeDevice: (body: SubscribePushRequest) => request("/v1/devices", PushDevice, post({}, body)),
  revokeDevice: (id: string) =>
    request(`/v1/devices/${encodeURIComponent(id)}`, PushDevice, post({}, undefined, "DELETE")),
  testPush: (id: string, idempotencyKey: string) =>
    request(
      `/v1/devices/${encodeURIComponent(id)}/test`,
      TestPushResponse,
      post({ [IDEMPOTENCY_HEADER]: idempotencyKey }),
    ),
  notificationPreferences: () => request("/v1/notification-preferences", NotificationPreferences),
  updateNotificationPreferences: (body: NotificationPreferences) =>
    request("/v1/notification-preferences", NotificationPreferences, post({}, body, "PUT")),
};

/** Like `request`, for endpoints that answer a binary body (audio); errors are the same ApiRequestError. */
async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError(UNREACHABLE, 0, "UNREACHABLE");
  }
  if (res.ok) return res.blob();
  const body: unknown = await res.json().catch(() => null);
  const err = ApiError.safeParse(body);
  if (err.success)
    throw new ApiRequestError(
      err.data.error.message,
      res.status,
      err.data.error.code,
      err.data.error.details,
    );
  throw new ApiRequestError(
    res.status >= 500 ? UNREACHABLE : `Request failed (HTTP ${res.status}).`,
    res.status,
    "HTTP",
  );
}

// Drops undefined and empty values so the server's defaults apply.
const searchOf = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(q).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])),
  );

export type FindingFilters = Partial<Omit<FindingSearchQuery, "cursor">>;

export type ApprovalQuery = { status: ApprovalStatus; projectId?: string } | { jobId: string };

export const keys = {
  me: ["me"] as const,
  remoteAccess: ["remote-access"] as const,
  runners: ["runners"] as const,
  system: ["system"] as const,
  sessions: ["sessions"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["jobs", id] as const,
  jobFeedback: (id: string) => ["jobs", id, "feedback"] as const,
  github: ["github"] as const,
  repositories: ["github", "repositories"] as const,
  repositoriesOf: (projectId: string | undefined) => ["github", "repositories", projectId ?? "all"] as const,
  issues: (repoId: string, f: IssueFilters) => ["github", "issues", repoId, f] as const,
  issue: (repoId: string, number: number) => ["github", "issue", repoId, number] as const,
  cloudHandoff: (repoId: string, number: number, projectId: string) =>
    ["github", "cloud-handoff", repoId, number, projectId] as const,
  repositoryHealth: (projectId: string | undefined) => ["github", "health", projectId ?? "all"] as const,
  repositoryDetails: (repoId: string) => ["github", "details", repoId] as const,
  setup: (projectId: string | undefined) => ["setup", projectId ?? "all"] as const,
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
  deepDivesOf: (projectId: string | undefined) => ["research", "deep-dives", projectId ?? "all"] as const,
  deepDive: (id: string) => ["research", "deep-dive", id] as const,
  searchProvider: ["research", "search-provider"] as const,
  researchDomains: (workspaceId: string) => ["research", "domains", workspaceId] as const,
  automations: ["automations"] as const,
  automationClients: (projectId: string | undefined) =>
    ["automations", "clients", projectId ?? "all"] as const,
  automationRuns: (projectId: string | undefined) => ["automations", "runs", projectId ?? "all"] as const,
  monitoring: ["monitoring"] as const,
  monitoredApps: (projectId: string | undefined) => ["monitoring", "apps", projectId ?? "all"] as const,
  incident: (id: string) => ["monitoring", "incident", id] as const,
  agents: ["agents"] as const,
  agentsOf: (projectId: string | undefined) => ["agents", "list", projectId ?? "none"] as const,
  agentVersions: (agent: AgentKey, projectId: string | undefined) =>
    ["agents", "versions", agent, projectId ?? "none"] as const,
  plans: ["plans"] as const,
  plansOf: (projectId: string | undefined) => ["plans", "list", projectId ?? "all"] as const,
  plan: (id: string) => ["plans", id] as const,
  opportunities: ["research", "opportunities"] as const,
  opportunitiesOf: (projectId: string | undefined) =>
    ["research", "opportunities", "list", projectId ?? "all"] as const,
  opportunity: (id: string) => ["research", "opportunities", id] as const,
  issuePreview: (id: string) => ["research", "opportunities", id, "preview"] as const,
  // Under "jobs" so every job mutation's invalidation refreshes the Jobs page too.
  jobHistory: (q: Partial<JobHistoryQuery>) => ["jobs", "history", q] as const,
  agentPerformance: (q: Partial<AgentPerformanceQuery>) => ["jobs", "performance", q] as const,
  jobDrafts: ["job-drafts"] as const,
  jobDraftsOf: (projectId: string | undefined) => ["job-drafts", "list", projectId ?? "all"] as const,
  jobDraft: (id: string) => ["job-drafts", id] as const,
  // Every Home variant (each project and "All"): what any decision or new job changes.
  homeAll: ["home"] as const,
  home: (projectId: string | undefined) => ["home", projectId ?? "all"] as const,
  voice: ["voice"] as const,
  devices: ["push", "devices"] as const,
  notificationPreferences: ["push", "preferences"] as const,
};

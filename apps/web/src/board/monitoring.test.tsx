import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HealthCheck, Incident, IncidentTriage, MonitoredApp, Notification } from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  apiError,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";

const NOW = new Date().toISOString();
const STALE = new Date(Date.now() - 3 * 3600_000).toISOString();
const INC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let n = 0;
const app = (over: Partial<MonitoredApp> = {}): MonitoredApp => ({
  id: `eeeeeeee-eeee-4eee-8eee-${String(++n).padStart(12, "0")}`,
  projectId: PROJECT_ID,
  name: "storefront-web",
  environment: "PROD",
  healthUrl: "https://shop.example.com/health?token=secret",
  repositoryId: null,
  intervalSeconds: 300,
  timeoutMs: 5000,
  failureThreshold: 3,
  disabled: false,
  health: "HEALTHY",
  consecutiveFailures: 0,
  lastCheckedAt: NOW,
  openIncidentId: null,
  createdAt: NOW,
  ...over,
});
const check = (over: Partial<HealthCheck> = {}): HealthCheck => ({
  id: `ffffffff-ffff-4fff-8fff-${String(++n).padStart(12, "0")}`,
  appId: "eeeeeeee-eeee-4eee-8eee-000000000000",
  checkedAt: NOW,
  ok: false,
  statusCode: 503,
  latencyMs: 40,
  error: "HTTP_STATUS",
  ...over,
});
const incident = (over: Partial<Incident> = {}): Incident => ({
  id: INC,
  projectId: PROJECT_ID,
  appId: "eeeeeeee-eeee-4eee-8eee-000000000000",
  fingerprint: "app:eeeeeeee-eeee-4eee-8eee-000000000000:PROD:http",
  severity: "SEV2",
  status: "OPEN",
  title: "checkout-api (PROD) health check failing",
  openedAt: NOW,
  acknowledgedAt: null,
  recoveredAt: null,
  resolvedAt: null,
  evidenceCount: 3,
  evidence: [check(), check({ error: "TIMEOUT", statusCode: null }), check()],
  ...over,
});

let apps: MonitoredApp[];
let current: Incident;

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/github/status": () => json({ configured: false }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/monitoring/apps": () => json({ items: apps }),
    [`GET /v1/incidents/${INC}`]: () => json(current),
    [`POST /v1/incidents/${INC}/status`]: (c) => {
      const status = (c.body as { status: "ACKNOWLEDGED" | "RESOLVED" }).status;
      current = { ...current, status, [status === "ACKNOWLEDGED" ? "acknowledgedAt" : "resolvedAt"]: NOW };
      return json(current);
    },
    ...extra,
  });
}

beforeEach(() => {
  apps = [
    app(),
    app({
      name: "checkout-api",
      health: "DOWN",
      consecutiveFailures: 3,
      openIncidentId: INC,
    }),
    app({ name: "email-worker", environment: "STAGING", health: "UNKNOWN", lastCheckedAt: STALE }),
  ];
  current = incident();
});

const drawer = () => screen.findByRole("dialog");

describe("Systems zone", () => {
  it("lists apps of the project with health in text, never colour alone; UNKNOWN says the home host can't see it", async () => {
    const calls = board();
    renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Systems" });
    const nodes = await within(zone).findAllByRole("button", { name: /PROD|STAGING/ });
    expect(nodes.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^Healthy · PRODstorefront-webchecked/),
      expect.stringMatching(/^Down · PRODcheckout-apichecked/),
      expect.stringMatching(/^Unknown · STAGINGemail-workerhome host can't see it · checked 3h ago/),
    ]);
    expect(within(zone).getByText(/Checks run on the home host/)).toBeTruthy();
    expect(within(zone).getByText(/3 apps · 1 failing/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/monitoring/apps")!.query.get("projectId")).toBe(PROJECT_ID);
  });

  it("a failing app opens its incident; the drawer shows status, timeline, evidence and acknowledges then resolves", async () => {
    const calls = board();
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Systems" });
    await user.click(await within(zone).findByRole("button", { name: /checkout-api/ }));
    expect(router.state.location.search).toMatchObject({ project: PROJECT_ID, drawer: `incident:${INC}` });

    const d = await drawer();
    expect(await within(d).findByRole("heading", { name: current.title })).toBeTruthy();
    expect(within(d).getByText("Open")).toBeTruthy();
    expect(within(d).getByText(/3 failed checks · observer: home host, same failure domain/)).toBeTruthy();
    const evidence = within(within(d).getByRole("list", { name: /Evidence/ })).getAllByRole("listitem");
    expect(evidence.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/HTTP error · HTTP 503$/),
      expect.stringMatching(/Timed out$/),
      expect.stringMatching(/HTTP error · HTTP 503$/),
    ]);
    expect((within(d).getByRole("button", { name: "Triage" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(d).getByRole("button", { name: "Create fix issue" }).getAttribute("aria-disabled")).toBe(
      "true",
    );

    await user.click(within(d).getByRole("button", { name: "Acknowledge" }));
    await within(d).findByText("Acknowledged", { selector: "span" });
    await user.click(within(d).getByRole("button", { name: "Resolve" }));
    await within(d).findByText(/Resolved is final/);
    const posts = calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]);
    expect(posts).toEqual([
      [`/v1/incidents/${INC}/status`, { status: "ACKNOWLEDGED" }],
      [`/v1/incidents/${INC}/status`, { status: "RESOLVED" }],
    ]);
    const timeline = within(within(d).getByRole("list", { name: "Timeline" })).getAllByRole("listitem");
    expect(timeline.map((li) => li.textContent?.replace(/^[\d:]+/, ""))).toEqual([
      "Opened",
      "Acknowledged",
      "Resolved",
    ]);
  });

  it("in All, or for another project's incident, decisions are disabled with the reason", async () => {
    const calls = board();
    renderApp(`/?drawer=incident:${INC}`);
    const d = await drawer();
    const ack = await within(d).findByRole("button", { name: "Acknowledge" });
    expect((ack as HTMLButtonElement).disabled).toBe(true);
    expect(within(d).getByText(/Pick a project first/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/monitoring/apps")!.query.get("projectId")).toBeNull();
  });

  it("another project's incident can't be decided from this project", async () => {
    board();
    current = incident({ projectId: OTHER_PROJECT_ID });
    renderApp(`${IN_PROJECT}&drawer=incident:${INC}`);
    const d = await drawer();
    expect(((await within(d).findByRole("button", { name: "Resolve" })) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(d).getByText("This belongs to another project: switch to it first.")).toBeTruthy();
  });
});

describe("FR-MON-07 incident triage", () => {
  const triage = (): IncidentTriage => ({
    incidentId: INC,
    hypotheses: [
      {
        text: "The upstream returns 503 under load.",
        confidence: "MEDIUM",
        evidenceCheckIds: [current.evidence[0]!.id, current.evidence[2]!.id],
      },
      {
        text: "The home host's network dropped.",
        confidence: "LOW",
        evidenceCheckIds: [current.evidence[1]!.id],
      },
    ],
    suggestedNextStep: "Look at the app's own logs around the first failure.",
    model: "claude-test-model",
    profileVersionId: null,
    createdAt: NOW,
  });

  it("shows hypotheses labelled as unverified AI inference, each with its confidence and links to the cited checks", async () => {
    const calls = board({ [`POST /v1/incidents/${INC}/triage`]: () => json(triage(), 201) });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=incident:${INC}`);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Triage" }));
    const panel = await within(d).findByRole("region", { name: "Triage" });
    expect(within(panel).getByText("AI inference: unverified · claude-test-model")).toBeTruthy();
    const items = within(within(panel).getByRole("list", { name: "Hypotheses" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(
        /^The upstream returns 503 under load\.medium confidence · evidence:check at .+check at /,
      ),
      expect.stringMatching(/^The home host's network dropped\.low confidence · evidence:check at /),
    ]);
    expect(within(panel).getByText(/Look at the app's own logs/)).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Triage" })).toBeNull();

    await user.click(within(items[1]!).getByRole("button", { name: /check at/ }));
    const evidence = within(within(d).getByRole("list", { name: /Evidence/ })).getAllByRole("listitem");
    expect(document.activeElement).toBe(evidence[1]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `/v1/incidents/${INC}/triage`,
    ]);
  });

  it("not configured shows the setup hint; a failure shows the error and the button stays", async () => {
    let reply = json(
      {
        error: {
          code: "CONFLICT",
          message: "NEXUS needs an AI provider for this. On the home machine create ~/.nexus/ai.json.",
          details: { reason: "ai_provider_not_configured", runbook: "docs/runbooks/ai-provider.md" },
        },
        requestId: "req-x",
      },
      409,
    );
    board({ [`POST /v1/incidents/${INC}/triage`]: () => reply });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=incident:${INC}`);
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: "Triage" }));
    expect(await within(d).findByText("AI isn't set up yet")).toBeTruthy();
    expect(within(d).getByText(/create ~\/\.nexus\/ai\.json/)).toBeTruthy();

    reply = apiError(
      502,
      "INTERNAL",
      "The model didn't produce a valid answer. Nothing was saved; try again.",
    );
    await user.click(within(d).getByRole("button", { name: "Triage" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/Nothing was saved; try again/);
  });

  it("in All the Triage button is disabled with Pick a project first", async () => {
    const calls = board();
    renderApp(`/?drawer=incident:${INC}`);
    const btn = (await within(await drawer()).findByRole("button", { name: "Triage" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.getElementById(btn.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /Pick a project first/,
    );
    expect(calls.some((c) => c.path.endsWith("/triage"))).toBe(false);
  });
});

describe("Systems drawer", () => {
  it("registers an app in the project after validating it; https only", async () => {
    let created: unknown;
    const calls = board({
      "POST /v1/monitoring/apps": (c) => {
        created = c.body;
        return json(app({ name: "api", health: "UNKNOWN", lastCheckedAt: null }), 201);
      },
    });
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Systems" });
    await user.click(await within(zone).findByRole("button", { name: "Manage apps" }));
    const d = await drawer();
    const rows = await within(d).findByRole("list", { name: "Monitored apps" });
    expect(within(rows).getByRole("listitem", { name: "email-worker" }).textContent).toMatch(
      /Unknown, home host can't see it/,
    );
    // The URL's query (it may hold a token) is never shown: host only.
    expect(rows.textContent).not.toContain("token");

    await user.click(within(d).getByRole("button", { name: "Register an app" }));
    const form = within(d).getByRole("form", { name: "Register an app" });
    await user.type(within(form).getByLabelText("Name"), "api");
    await user.type(within(form).getByLabelText(/Health URL/), "http://api.example.com/health");
    await user.click(within(form).getByRole("button", { name: "Register app" }));
    expect(await within(form).findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.clear(within(form).getByLabelText(/Health URL/));
    await user.type(within(form).getByLabelText(/Health URL/), "https://api.example.com/health");
    await user.click(within(form).getByRole("button", { name: "Register app" }));
    await waitFor(() =>
      expect(created).toEqual({
        projectId: PROJECT_ID,
        name: "api",
        environment: "PROD",
        healthUrl: "https://api.example.com/health",
        intervalSeconds: 300,
        timeoutMs: 5000,
        failureThreshold: 3,
      }),
    );
  });

  it("checks an app now and pauses it; registration needs a project", async () => {
    const calls = board({
      [`POST /v1/monitoring/apps/${apps[0]!.id}/check`]: () =>
        json(check({ ok: true, statusCode: 200, latencyMs: 87, error: null })),
      [`PATCH /v1/monitoring/apps/${apps[0]!.id}`]: () => json({ ...apps[0]!, disabled: true }),
    });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=systems`);
    const row = await within(await drawer()).findByRole("listitem", { name: "storefront-web" });
    await user.click(within(row).getByRole("button", { name: "Check now" }));
    expect(await within(row).findByText("Checked now: Passed · HTTP 200 · 87 ms")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Pause checks" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ disabled: true }));
  });

  it("in All, register and check are disabled with Pick a project first", async () => {
    board();
    renderApp("/?drawer=systems");
    const d = await drawer();
    expect((within(d).getByRole("button", { name: "Register an app" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const row = await within(d).findByRole("listitem", { name: "storefront-web" });
    expect((within(row).getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByText(/Pick a project first/)).toBeTruthy();
  });
});

describe("incident notification", () => {
  it("opens the incident drawer in the incident's project from the inbox", async () => {
    const note: Notification = {
      id: "44444444-4444-4444-8444-000000000001",
      projectId: PROJECT_ID,
      category: "TASK_FAILED",
      title: "SEV2 · checkout-api (PROD) health check failing",
      body: "3 consecutive failed checks of shop.example.com.",
      subject: { jobId: null, approvalId: null, incidentId: INC },
      status: "READ",
      createdAt: NOW,
    };
    board({ "GET /v1/notifications": () => json({ items: [note], unreadCount: 0 }) });
    const user = userEvent.setup();
    const { router } = renderApp("/?drawer=inbox");
    const d = await drawer();
    await user.click(await within(d).findByRole("button", { name: `Open the incident: ${note.title}` }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        ws: "dev",
        project: PROJECT_ID,
        drawer: `incident:${INC}`,
      }),
    );
  });
});

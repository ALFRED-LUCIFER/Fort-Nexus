import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentKey, AgentProfileSettings, AgentProfileVersion, AgentSummary } from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  workspaces,
} from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const T0 = "2026-10-28T10:00:00.000Z";
const DEV_WS = project().workspaceId;
const V_PROJECT = "0190f0a0-0000-7000-8000-0000000000a2";
const V_WORKSPACE = "0190f0a0-0000-7000-8000-0000000000a1";
const THREAD = "55555555-5555-4555-8555-555555555555";

const settings = (over: Partial<AgentProfileSettings> = {}): AgentProfileSettings => ({
  engine: "MESSAGES_API",
  autonomy: "ACT_WITH_APPROVAL",
  tools: ["jobs.read", "github.read"],
  maxCostUsdPerTask: 1,
  maxTurns: 10,
  responseDetail: "STANDARD",
  ...over,
});
const LABEL: Record<AgentKey, string> = {
  CHIEF_OF_STAFF: "Chief of Staff",
  DEVELOPER: "Developer",
  QA: "QA",
  DEVOPS: "DevOps",
  PRODUCT: "Product",
  AI_RESEARCHER: "AI researcher",
  FINANCIAL_ANALYST: "Financial analyst",
};
const summary = (agent: AgentKey, over: Partial<AgentSummary["effective"]> = {}): AgentSummary => ({
  agent,
  label: LABEL[agent],
  description: `${LABEL[agent]} does its job.`,
  effective: {
    agent,
    versionId: null,
    level: "DEFAULT",
    version: 0,
    settings: settings(),
    ceilingApplied: [],
    ...over,
  },
  record: { stepsSucceeded: 2, stepsFailed: 1, lastActiveAt: null },
});
const version = (over: Partial<AgentProfileVersion> = {}): AgentProfileVersion => ({
  id: V_PROJECT,
  agent: "QA",
  level: "PROJECT",
  workspaceId: DEV_WS,
  projectId: PROJECT_ID,
  version: 3,
  settings: settings(),
  createdAt: T0,
  ...over,
});
// QA's project v3 asked for the coding engine on Autonomous; the server capped nothing for QA but shows a note.
const QA_STORED = settings({ engine: "CLAUDE_AGENT_SDK", autonomy: "AUTONOMOUS", tools: ["jobs.read"] });
const AGENTS = (Object.keys(LABEL) as AgentKey[]).map((k) =>
  k === "QA"
    ? summary("QA", {
        versionId: V_PROJECT,
        level: "PROJECT",
        version: 3,
        settings: { ...QA_STORED, maxTurns: 10 },
        ceilingApplied: ["maxTurns capped to 200"],
      })
    : k === "PRODUCT"
      ? summary("PRODUCT", { settings: settings({ autonomy: "DRAFT" }) })
      : summary(k),
);
const VERSIONS = [
  version({ settings: QA_STORED }),
  version({ id: V_WORKSPACE, level: "WORKSPACE", projectId: null, version: 1 }),
];

const base = (extra: Parameters<typeof mockFetch>[0] = {}) =>
  mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/agents": () => json({ items: AGENTS }),
    "GET /v1/agents/QA/versions": () => json({ items: VERSIONS }),
    ...extra,
  });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});

describe("Agents on the board (FR-AGT-07)", () => {
  it("shows the project's agents and switches to one swim-lane per agent", async () => {
    const calls = base();
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    const zone = within(await screen.findByRole("list", { name: "Agents" }));
    expect(zone.getByRole("button", { name: /^Autonomous\s*QA\s*1 tool · v3 · this project$/ })).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/agents")!.query.get("projectId")).toBe(PROJECT_ID);

    const grouping = screen.getByRole("group", { name: "Board grouping" });
    await user.click(within(grouping).getByRole("button", { name: "Agents" }));
    expect(within(grouping).getByRole("button", { name: "Agents" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const lane = within(await screen.findByRole("region", { name: "Product" }));
    // Effective autonomy as text, not only the dot colour.
    expect(lane.getAllByRole("definition")[0]!.textContent).toBe("Draft");
    expect(lane.getByText("github.read · R0")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Code" })).toBeNull();
    await user.click(within(screen.getByRole("region", { name: "QA" })).getByRole("button", { name: /QA/ }));
    expect(await screen.findByRole("dialog", { name: "QA" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(await within(grouping).findByRole("button", { name: "Domains" }));
    expect(await screen.findByRole("region", { name: "Code" })).toBeTruthy();
  });

  it("in All asks for a project instead of resolving profiles", async () => {
    const calls = base();
    renderApp("/");
    expect(await screen.findByText(/Pick a project to see its agents/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/v1/agents")).toBe(false);
  });
});

describe("agent drawer (FR-WKS-04/05, C-04)", () => {
  it("edits from the stored version, shows the ceiling and saves a new workspace version", async () => {
    const calls = base({
      "PUT /v1/agents/QA/profile": (c) =>
        json(
          version({
            id: "0190f0a0-0000-7000-8000-0000000000a3",
            level: "WORKSPACE",
            projectId: null,
            version: 2,
            settings: (c.body as { settings: AgentProfileSettings }).settings,
          }),
        ),
    });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=agent:QA`);
    const dialog = within(await screen.findByRole("dialog", { name: "QA" }));
    expect(
      await dialog.findByText(/In effect in Home: v3 · this project · Autonomous · Claude Agent SDK/),
    ).toBeTruthy();
    expect(dialog.getByText("Ceiling: maxTurns capped to 200")).toBeTruthy();
    expect(dialog.getByText(/No profile can loosen the global ceiling/)).toBeTruthy();
    // The form starts from what the owner stored, not the capped effective copy.
    expect((dialog.getByLabelText("Engine") as HTMLSelectElement).value).toBe("CLAUDE_AGENT_SDK");
    expect((dialog.getByRole("radio", { name: /Autonomous/ }) as HTMLInputElement).checked).toBe(true);
    const history = within(dialog.getByRole("region", { name: "Version history" }));
    expect(history.getAllByRole("listitem")[0]!.textContent).toMatch(/^v3 · this project · .* · in effect$/);

    await user.click(dialog.getByRole("radio", { name: /Draft/ }));
    await user.click(dialog.getByRole("checkbox", { name: /monitoring\.read/ }));
    await user.click(dialog.getByRole("radio", { name: /Whole workspace/ }));
    await user.click(dialog.getByRole("button", { name: "Save new version" }));
    expect((await dialog.findByRole("status")).textContent).toBe("Saved as workspace version v2.");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.body)).toEqual([
      {
        level: { kind: "WORKSPACE", workspaceId: DEV_WS },
        settings: { ...QA_STORED, autonomy: "DRAFT", tools: ["jobs.read", "monitoring.read"] },
      },
    ]);
  });

  it("an archived project's profiles are read-only", async () => {
    const calls = base({
      "GET /v1/workspaces": () => json(workspaces([project({ archivedAt: T0 })])),
    });
    renderApp(`${IN_PROJECT}&drawer=agent:QA`);
    const dialog = within(await screen.findByRole("dialog", { name: "QA" }));
    const save = await dialog.findByRole("button", { name: "Save new version" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.getByText(/Home is archived: its agent profiles are read-only/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("validates limits on the client", async () => {
    const calls = base();
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=agent:QA`);
    const dialog = within(await screen.findByRole("dialog", { name: "QA" }));
    const turns = await dialog.findByLabelText("Max turns");
    await user.clear(turns);
    await user.type(turns, "500");
    await user.click(dialog.getByRole("button", { name: "Save new version" }));
    expect((await dialog.findByRole("alert")).textContent).toMatch(/1–200 whole turns/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("in All asks for a project", async () => {
    base();
    renderApp("/?drawer=agent:QA");
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(PICK_PROJECT)).toBeTruthy();
  });
});

describe("Settings → Agent profiles", () => {
  it("lists the version in effect per agent and opens its drawer", async () => {
    base();
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=settings`);
    await user.click(await screen.findByRole("button", { name: "Agent profiles" }));
    const list = within(await screen.findByRole("list", { name: "Agent profiles" }));
    expect(list.getByText(/v3 · this project · Autonomous · 1 tool · capped by the ceiling/)).toBeTruthy();
    await user.click(list.getByRole("button", { name: "Edit QA" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ ws: "dev", project: PROJECT_ID, drawer: "agent:QA" }),
    );
  });
});

describe("Talk pinned profile (FR-WKS-05)", () => {
  const detail = (profileVersionId: string | null) => ({
    thread: {
      id: THREAD,
      projectId: PROJECT_ID,
      title: "Hello",
      subjectJobId: null,
      profileVersionId,
      createdAt: T0,
      updatedAt: T0,
    },
    turns: [],
    proposals: [],
  });

  it("names the pinned Chief of Staff version, or the default", async () => {
    base({
      [`GET /v1/conversations/${THREAD}`]: () => json(detail(V_WORKSPACE)),
      "GET /v1/agents/CHIEF_OF_STAFF/versions": () =>
        json({
          items: [version({ id: V_WORKSPACE, agent: "CHIEF_OF_STAFF", level: "WORKSPACE", version: 4 })],
        }),
    });
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    expect(await screen.findByText("Chief of Staff v4 (workspace)")).toBeTruthy();
  });

  it("shows default when nothing was pinned", async () => {
    const calls = base({ [`GET /v1/conversations/${THREAD}`]: () => json(detail(null)) });
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    expect(await screen.findByText("Chief of Staff default")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/versions"))).toBe(false);
  });
});

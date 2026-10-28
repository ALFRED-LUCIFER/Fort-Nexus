import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutomationClient, AutomationRun } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";

const T0 = new Date().toISOString();
const CLIENT: AutomationClient = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: PROJECT_ID,
  name: "n8n morning brief",
  allowedActions: ["research.run"],
  allowedJobTypes: [],
  rateLimitPerMinute: 10,
  disabled: false,
  keyVersion: 1,
  lastUsedAt: null,
  createdAt: T0,
};
const RUN: AutomationRun = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  clientId: CLIENT.id,
  action: null,
  status: "REJECTED",
  reason: "Request validation failed",
  result: null,
  receivedAt: T0,
};
const KEY = "k".repeat(43);

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/automations/clients": () => json({ items: [CLIENT] }),
    "GET /v1/automations/runs": () => json({ items: [RUN] }),
    ...extra,
  });
}

async function openTab(path: string) {
  const user = userEvent.setup();
  renderApp(`${path}${path.includes("?") ? "&" : "?"}drawer=settings`);
  const drawer = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(drawer).getByRole("button", { name: "Automations" }));
  return { user, drawer };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("Settings → Automations", () => {
  it("creates a client in the current project and shows its key once, with a copy button", async () => {
    const calls = board({
      "POST /v1/automations/clients": (c) =>
        json(
          {
            client: { ...CLIENT, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...(c.body as object) },
            signingKey: KEY,
          },
          201,
        ),
    });
    const { user } = await openTab(IN_PROJECT);
    expect(await screen.findByText("n8n morning brief")).toBeTruthy();
    expect(screen.getByText(/invalid request/)).toBeTruthy();
    expect(screen.getByText(/Request validation failed/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/automations/clients")!.query.get("projectId")).toBe(PROJECT_ID);

    await user.click(screen.getByRole("button", { name: "Create client" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Give it a name/);
    await user.type(screen.getByLabelText("Name"), "n8n deploy hook");
    await user.click(screen.getByRole("checkbox", { name: "jobs.create" }));
    await user.click(screen.getByRole("checkbox", { name: "RUNNER_DIAGNOSTIC" }));
    await user.click(screen.getByRole("button", { name: "Create client" }));

    const panel = await screen.findByRole("region", { name: "New signing key" });
    expect(panel.textContent).toMatch(/won.t be shown again/);
    expect((within(panel).getByLabelText("Signing key") as HTMLInputElement).value).toBe(KEY);
    await user.click(within(panel).getByRole("button", { name: "Copy signing key" }));
    expect(await navigator.clipboard.readText()).toBe(KEY);
    expect(within(panel).getByText("Signing key copied.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      {
        projectId: PROJECT_ID,
        name: "n8n deploy hook",
        allowedActions: ["research.run", "jobs.create"],
        allowedJobTypes: ["RUNNER_DIAGNOSTIC"],
        rateLimitPerMinute: 10,
      },
    ]);

    await user.click(within(panel).getByRole("button", { name: "I've stored it" }));
    expect(screen.queryByRole("region", { name: "New signing key" })).toBeNull();
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("in All lists every project's clients read-only and can't create one", async () => {
    const calls = board();
    await openTab("/");
    expect(await screen.findByText("n8n morning brief")).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/automations/clients")!.query.has("projectId")).toBe(false);
    expect((screen.getByRole("button", { name: "Create client" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Pick a project first/)).toBeTruthy();
  });

  it("disables a client and rotates its key only after confirming", async () => {
    let client = CLIENT;
    const calls = board({
      "GET /v1/automations/clients": () => json({ items: [client] }),
      [`PATCH /v1/automations/clients/${CLIENT.id}`]: (c) => {
        client = { ...client, ...(c.body as object) };
        return json(client);
      },
      [`POST /v1/automations/clients/${CLIENT.id}/rotate`]: () => {
        client = { ...client, keyVersion: 2 };
        return json({ client, signingKey: KEY });
      },
    });
    const { user } = await openTab(IN_PROJECT);
    await user.click(await screen.findByRole("button", { name: "Disable n8n morning brief" }));
    expect(await screen.findByRole("button", { name: "Enable n8n morning brief" })).toBeTruthy();
    expect(screen.getByText("disabled")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rotate key of n8n morning brief" }));
    expect(screen.getByText(/current key stops working at once/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep key" }));
    await user.click(screen.getByRole("button", { name: "Rotate key of n8n morning brief" }));
    await user.click(screen.getByRole("button", { name: "Confirm rotate n8n morning brief" }));
    const panel = await screen.findByRole("region", { name: "New signing key" });
    expect(panel.textContent).toMatch(/version 2/);
    await waitFor(() =>
      expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body])).toEqual([
        ["PATCH", `/v1/automations/clients/${CLIENT.id}`, { disabled: true }],
        ["POST", `/v1/automations/clients/${CLIENT.id}/rotate`, null],
      ]),
    );
  });

  it("shows an API failure instead of an empty list", async () => {
    board({
      "GET /v1/automations/clients": () =>
        json({ error: { code: "INTERNAL", message: "Internal server error" }, requestId: "r" }, 500),
    });
    await openTab(IN_PROJECT);
    expect(await screen.findByText(/Internal server error|Can't reach/)).toBeTruthy();
  });
});

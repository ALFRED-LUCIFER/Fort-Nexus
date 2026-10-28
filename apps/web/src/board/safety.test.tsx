import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Approval, Job, OwnerSession, Runner, SystemControls } from "@nexus/contracts";
import {
  FakeEventSource,
  JOB_ID,
  ME,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";

const controls = (engaged = false, over: Partial<SystemControls["budget"]> = {}): SystemControls => ({
  emergencyStop: { engaged, changedAt: engaged ? "2026-10-28T10:00:00.000Z" : null },
  budget: {
    dailyCapUsd: 20,
    spentTodayUsd: 4.5,
    timezone: "Asia/Dubai",
    resetsAt: "2026-10-28T20:00:00.000Z",
    exhausted: false,
    ...over,
  },
});

const session = (over: Partial<OwnerSession>): OwnerSession => ({
  id: "s-current",
  createdAt: "2026-10-27T10:00:00.000Z",
  expiresAt: "2099-11-03T10:00:00.000Z",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  ipAddress: "100.64.0.2",
  current: true,
  ...over,
});

function board(o: {
  system?: SystemControls;
  jobs?: Job[];
  runners?: Runner[];
  extra?: Parameters<typeof mockFetch>[0];
}) {
  let system = o.system ?? controls();
  const calls = mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: o.runners ?? [runner()] }),
    "GET /v1/jobs": (c) =>
      json({
        items: (o.jobs ?? []).filter((j) => !c.query.get("status") || j.status === c.query.get("status")),
        nextCursor: null,
      }),
    "GET /v1/system": () => json(system),
    "PUT /v1/system/emergency-stop": (c) => {
      system = controls((c.body as { engaged: boolean }).engaged);
      return json(system);
    },
    ...o.extra,
  });
  return calls;
}
const puts = (calls: ReturnType<typeof mockFetch>, path: string) =>
  calls.filter((c) => c.method === "PUT" && c.path === path).map((c) => c.body);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("emergency stop", () => {
  it("asks before stopping, then shows the emergency banner until released", async () => {
    const calls = board({});
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "STOP ALL" }));
    const dialog = screen.getByRole("alertdialog", { name: "Stop everything now?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(puts(calls, "/v1/system/emergency-stop")).toEqual([]);

    await user.click(screen.getByRole("button", { name: "STOP ALL" }));
    await user.click(screen.getByRole("button", { name: "Stop everything" }));
    const banner = await screen.findByText("Emergency stop engaged — nothing is running.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(puts(calls, "/v1/system/emergency-stop")).toEqual([{ engaged: true }]);

    await user.click(
      within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Release" }),
    );
    await waitFor(() => expect(screen.queryByText(/Emergency stop engaged/)).toBeNull());
    expect(puts(calls, "/v1/system/emergency-stop")).toEqual([{ engaged: true }, { engaged: false }]);
    expect(screen.getByRole("button", { name: "STOP ALL" })).toBeTruthy();
  });

  it("doesn't claim nothing is running while a run is still stopping", async () => {
    board({ system: controls(true), jobs: [job({ status: "RUNNING", runnerId: runner().id })] });
    renderApp("/");
    expect(await screen.findByText("Emergency stop engaged — waiting for 1 run to stop.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release the emergency stop" }).textContent).toBe("RESUME");
  });

  it("shows why an approval can't execute while stopped", async () => {
    const approval: Approval = {
      id: "44444444-4444-4444-8444-444444444444",
      jobId: JOB_ID,
      riskTier: "R2",
      status: "PENDING",
      action: {
        type: "github.push_draft_pr",
        repositoryId: "101",
        repositoryFullName: "acme/web",
        issueNumber: 42,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        headBranch: "nexus/issue-42-22222222",
        title: "#42: Cart totals",
        body: "Refs #42",
        changesetSha256: "b".repeat(64),
        files: [{ path: "src/a.ts", change: "modified" }],
        stats: { added: 1, removed: 1 },
        verification: {
          status: "passed",
          source: "nexus.json",
          install: null,
          test: ["pnpm", "test"],
          exitCode: 0,
          durationMs: 1000,
          outputTail: "",
        },
      },
      actionHash: "c".repeat(64),
      createdAt: "2026-10-28T10:00:00.000Z",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      decidedAt: null,
      result: null,
      error: null,
    };
    const message =
      "Emergency stop is engaged: nothing new can start and approvals can't execute until you release it.";
    board({
      extra: {
        "GET /v1/approvals": () => json({ items: [approval] }),
        [`POST /v1/approvals/${approval.id}/decision`]: () => apiError(409, "EMERGENCY_STOP", message),
      },
    });
    const user = userEvent.setup();
    renderApp("/?drawer=inbox");
    await user.click(await screen.findByRole("button", { name: /^Approve/ }));
    await user.click(screen.getByRole("button", { name: "Approve push" }));
    expect((await screen.findByText(message)).getAttribute("role")).toBe("alert");
  });
});

describe("settings", () => {
  it("opens from the toolbar on Security & devices and keeps the other tabs honest", async () => {
    board({ extra: { "GET /v1/sessions": () => json({ items: [session({})] }) } });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const drawer = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(drawer).getByRole("button", { name: "Security & devices" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await within(drawer).findByText("Chrome on Mac")).toBeTruthy();
    expect(within(drawer).getByText("this browser")).toBeTruthy();

    await user.click(within(drawer).getByRole("button", { name: "Backups" }));
    expect(within(drawer).getByText(/Viewing them here arrives in P1/)).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: "Budgets & limits" }));
    const meter = await within(drawer).findByRole("meter", { name: "Today's AI spend · estimate" });
    expect(meter.getAttribute("aria-valuetext")).toBe("$4.50 of $20.00");
    expect(within(drawer).getByText(/resets .* \(Asia\/Dubai\)/)).toBeTruthy();
  });

  it("revokes another session, and signing out this one goes to the login page", async () => {
    let sessions = [
      session({}),
      session({ id: "s-phone", current: false, userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" }),
    ];
    const calls = board({
      extra: {
        "GET /v1/sessions": () => json({ items: sessions }),
        "DELETE /v1/sessions/s-phone": () => {
          sessions = sessions.filter((s) => s.id !== "s-phone");
          return new Response(null, { status: 204 });
        },
        "DELETE /v1/sessions/s-current": () => new Response(null, { status: 204 }),
        "GET /v1/auth/status": () => json({ github: { configured: true, ownerLogin: "owner" } }),
      },
    });
    const user = userEvent.setup();
    renderApp("/?drawer=settings");
    await user.click(await screen.findByRole("button", { name: "Revoke Safari on iPhone/iPad" }));
    await waitFor(() => expect(screen.queryByText("Safari on iPhone/iPad")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sessions/s-phone")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Sign out Chrome on Mac" }));
    expect(await screen.findByRole("button", { name: "Continue with GitHub" })).toBeTruthy();
  });

  it("revokes a runner only after confirming", async () => {
    let r = runner({ name: "home-studio" });
    const calls = board({
      runners: [],
      extra: {
        "GET /v1/sessions": () => json({ items: [] }),
        "GET /v1/runners": () => json({ items: [r] }),
        [`POST /v1/runners/${r.id}/revoke`]: () => {
          r = { ...r, status: "REVOKED" };
          return json(r);
        },
      },
    });
    const user = userEvent.setup();
    renderApp("/?drawer=settings");
    await user.click(await screen.findByRole("button", { name: "Revoke home-studio" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    await user.click(screen.getByRole("button", { name: "Revoke home-studio" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke home-studio" }));
    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("validates the daily cap before saving it", async () => {
    let system = controls();
    const calls = board({
      extra: {
        "GET /v1/system": () => json(system),
        "PUT /v1/system/budget": (c) => {
          system = controls(false, { dailyCapUsd: (c.body as { dailyCapUsd: number }).dailyCapUsd });
          return json(system);
        },
      },
    });
    const user = userEvent.setup();
    renderApp("/?drawer=settings");
    await user.click(await screen.findByRole("button", { name: "Budgets & limits" }));
    const input = await screen.findByLabelText("Daily AI budget (USD)");
    for (const bad of ["0", "1001", "0.001"]) {
      await user.clear(input);
      await user.type(input, bad);
      await user.click(screen.getByRole("button", { name: "Save cap" }));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText("Enter an amount from $0.01 to $1000.")).toBeTruthy();
    }
    expect(puts(calls, "/v1/system/budget")).toEqual([]);

    await user.clear(input);
    await user.type(input, "25.5");
    await user.click(screen.getByRole("button", { name: "Save cap" }));
    expect(await screen.findByText("Saved: $25.50 a day.")).toBeTruthy();
    expect(puts(calls, "/v1/system/budget")).toEqual([{ dailyCapUsd: 25.5 }]);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe("$4.50 of $25.50");
  });
});

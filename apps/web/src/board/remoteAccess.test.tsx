import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import type { RemoteAccessReport, RemoteAccessStatus } from "@nexus/contracts";
import { ME, apiError, json, mockFetch, renderApp, runner } from "../test/helpers.tsx";

// Settings → Remote access against a mocked API.

const ORIGIN = "https://alfreds-macbook-pro.tail2a3f3c.ts.net";
const AT = "2026-11-09T09:07:00.000Z";
const at = new Date(AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const report = (over: Partial<RemoteAccessReport> = {}): RemoteAccessReport => ({
  state: "RUNNING",
  url: ORIGIN,
  serving: true,
  funnel: false,
  devices: [
    { name: "alfreds-macbook-pro", os: "macOS", online: true, self: true },
    { name: "ipad171", os: "iOS", online: false, self: false },
  ],
  ...over,
});
const status = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  publicOrigin: ORIGIN,
  runnerName: "home-mac",
  reportedAt: AT,
  stale: false,
  report: report(),
  ...over,
});
const none: RemoteAccessStatus = {
  publicOrigin: ORIGIN,
  runnerName: null,
  reportedAt: null,
  stale: false,
  report: null,
};

const open = (remote: () => Response | Promise<Response>) => {
  const calls = mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/remote-access": remote,
  });
  return { calls, ...renderApp("/?drawer=settings#remote") };
};
const serves = (s: RemoteAccessStatus) => open(() => json(s));
const commands = () => Array.from(document.querySelectorAll("code.select-all")).map((c) => c.textContent);

afterEach(() => {
  act(() => void window.dispatchEvent(new Event("online")));
});

describe("Settings → Remote access", () => {
  it("shows a loading state while the status is on its way", async () => {
    open(() => new Promise<Response>(() => {}));
    expect((await screen.findByText("Loading…")).getAttribute("role")).toBe("status");
  });

  it("shows the request error", async () => {
    open(() => apiError(500, "INTERNAL", "The server had a problem."));
    expect((await screen.findByRole("alert")).textContent).toContain("The server had a problem.");
  });

  it("says so when the browser is offline and nothing has loaded", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    open(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await screen.findByText("This device is offline")).toBeTruthy();
    expect(screen.getByText(/can't be asked for the status/)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("keeps the last status on screen, labelled, when the browser goes offline", async () => {
    serves(status());
    await screen.findByText("Private to your tailnet");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(await screen.findByText("This device is offline")).toBeTruthy();
    expect(screen.getByText("This is the last status it received.")).toBeTruthy();
    expect(screen.getByText("Private to your tailnet")).toBeTruthy();
  });

  it("keeps the last status and says a refresh failed", async () => {
    let up = true;
    const { queryClient } = open(() =>
      up ? json(status()) : apiError(500, "INTERNAL", "The server had a problem."),
    );
    await screen.findByText("Private to your tailnet");
    up = false;
    await act(() => queryClient.refetchQueries({ queryKey: ["remote-access"] }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't refresh the status");
    expect(screen.getByText("Private to your tailnet")).toBeTruthy();
  });

  it("explains that a runner must report, without inventing a status", async () => {
    serves(none);
    expect(await screen.findByText("No runner has reported yet")).toBeTruthy();
    expect(screen.getByText(/Pair a runner/)).toBeTruthy();
    expect(screen.queryByText(/Private to your tailnet/)).toBeNull();
    expect(screen.queryByText("Tailscale Serve")).toBeNull();
    expect(commands()).toEqual([]);
  });

  it("shows a healthy home machine in words, with no controls and no fixes", async () => {
    serves(status());
    const section = await screen.findByRole("region", { name: "Status" });
    const rows = within(section);
    expect(rows.getByText(ORIGIN)).toBeTruthy();
    expect(rows.getByText("connected")).toBeTruthy();
    expect(rows.getByText("Tailscale Serve")).toBeTruthy();
    expect(rows.getByText("on")).toBeTruthy();
    expect(rows.getByText("Private to your tailnet")).toBeTruthy();
    expect(rows.getByText("Reported by home-mac")).toBeTruthy();
    expect(rows.getByText(new RegExp(`at ${at}`))).toBeTruthy();

    const devices = within(screen.getByRole("region", { name: "Devices on your tailnet" }));
    expect(devices.getByText("alfreds-macbook-pro (home machine)")).toBeTruthy();
    expect(devices.getByText("online")).toBeTruthy();
    expect(devices.getByText("ipad171")).toBeTruthy();
    expect(devices.getByText("offline")).toBeTruthy();

    expect(screen.getByText(/changes are made on the home machine/)).toBeTruthy();
    expect(screen.getByText(/could cut off the connection/)).toBeTruthy();
    expect(commands()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(section.querySelectorAll("button, input, select, a")).toHaveLength(0);
  });

  it("warns prominently when Funnel is on and gives the two commands in order", async () => {
    serves(status({ report: report({ funnel: true }) }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Warning: NEXUS is published to the public internet");
    expect(commands()).toEqual(["tailscale funnel reset", "tailscale serve --bg 8787"]);
    expect(screen.getByText("Public: Tailscale Funnel is on")).toBeTruthy();
    expect(screen.queryByText("Private to your tailnet")).toBeNull();
  });

  it("gives only the Funnel fix when Funnel is on and NEXUS isn't served", async () => {
    serves(status({ report: report({ funnel: true, serving: false }) }));
    await screen.findByRole("alert");
    expect(commands()).toEqual(["tailscale funnel reset", "tailscale serve --bg 8787"]);
  });

  it("marks a stale report, and stops prescribing fixes for a problem that may be gone", async () => {
    serves(status({ stale: true, report: report({ serving: false }) }));
    expect(await screen.findByText(`Last reported at ${at} by home-mac, may have changed`)).toBeTruthy();
    expect(commands()).toEqual([]);
  });

  it("still warns about Funnel on a stale report", async () => {
    serves(status({ stale: true, report: report({ funnel: true }) }));
    expect((await screen.findByRole("alert")).textContent).toContain("public internet");
    expect(commands()).toEqual(["tailscale funnel reset", "tailscale serve --bg 8787"]);
  });

  it("warns when Tailscale's address isn't the one sign-in is set up for", async () => {
    serves(status({ publicOrigin: "http://127.0.0.1:8787" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Sign-in only works at http://127.0.0.1:8787",
    );
  });

  it("doesn't warn about the address when NEXUS isn't being served there", async () => {
    serves(status({ publicOrigin: "http://127.0.0.1:8787", report: report({ serving: false }) }));
    await screen.findByText("Tailscale Serve");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the Serve command only when NEXUS isn't served", async () => {
    serves(status({ report: report({ serving: false, url: null }) }));
    expect(await screen.findByText("off · not forwarding to NEXUS")).toBeTruthy();
    expect(screen.getByText("none: nothing is being served")).toBeTruthy();
    expect(commands()).toEqual(["tailscale serve --bg 8787"]);
  });

  it("offers tailscale up only when it needs signing in", async () => {
    serves(status({ report: report({ state: "NEEDS_LOGIN", serving: false, url: null, devices: [] }) }));
    expect(await screen.findByText("needs sign-in")).toBeTruthy();
    expect(commands()).toEqual(["tailscale up"]);
    expect(screen.getByText("No devices reported")).toBeTruthy();
  });

  it("says to open Tailscale when it is stopped", async () => {
    serves(status({ report: report({ state: "STOPPED", serving: false, url: null }) }));
    expect(await screen.findByText("Open Tailscale on the home machine and connect.")).toBeTruthy();
    expect(commands()).toEqual([]);
  });

  it("points to the runbook when Tailscale isn't installed, and claims nothing else", async () => {
    serves(status({ report: report({ state: "NOT_INSTALLED", serving: false, url: null, devices: [] }) }));
    expect(await screen.findByText("not installed")).toBeTruthy();
    expect(screen.getByText("docs/runbooks/remote-access.md")).toBeTruthy();
    expect(screen.queryByText("Private to your tailnet")).toBeNull();
    expect(screen.queryByText("Tailscale Serve")).toBeNull();
    expect(commands()).toEqual([]);
  });

  it("makes no claim about Serve or privacy when Tailscale couldn't be read", async () => {
    serves(status({ report: report({ state: "UNAVAILABLE", serving: false, url: null, devices: [] }) }));
    expect(await screen.findByText("unknown")).toBeTruthy();
    expect(screen.queryByText("Private to your tailnet")).toBeNull();
    expect(screen.queryByText("Tailscale Serve")).toBeNull();
    expect(screen.queryByText("Devices on your tailnet")).toBeNull();
  });
});

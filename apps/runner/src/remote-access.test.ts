import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { RemoteAccessReport } from "@nexus/contracts";
import { apiPortOf, collectRemoteAccess, parseRemoteAccess, type Exec } from "./remote-access.ts";
import { startRunner } from "./runner.ts";
import { fakeApi, json } from "./test-support.ts";

const PORT = 8787;
const HOST = "alfreds-macbook-pro.tail2a3f3c.ts.net";
const APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// The shape `tailscale status --json` really prints, including the fields that must never leave the machine.
const node = (over: Record<string, unknown>) => ({
  ID: "n1CNTRL",
  PublicKey: "nodekey:self",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  AllowedIPs: ["100.101.102.103/32"],
  Addrs: ["192.168.1.44:41641"],
  CurAddr: "203.0.113.9:41641",
  UserID: 7,
  ...over,
});
const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    TailscaleIPs: ["100.101.102.103"],
    User: { "7": { LoginName: "owner@example.com", DisplayName: "Owner" } },
    Self: node({ HostName: "Alfreds-MacBook-Pro", DNSName: `${HOST}.`, OS: "macOS", Online: true }),
    Peer: {
      "nodekey:aaa": node({
        HostName: "localhost",
        DNSName: "ipad171.tail2a3f3c.ts.net.",
        OS: "iOS",
        Online: true,
      }),
      "nodekey:bbb": node({ HostName: "old-laptop", DNSName: "", OS: "windows", Online: false }),
    },
    ...over,
  });
const SERVING = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
});
const servingWith = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(SERVING), ...over });

describe("parseRemoteAccess", () => {
  it("reads a served, running home machine: names from MagicDNS, self first", () => {
    expect(parseRemoteAccess(status(), SERVING, PORT)).toEqual({
      state: "RUNNING",
      url: `https://${HOST}`,
      serving: true,
      funnel: false,
      devices: [
        { name: "alfreds-macbook-pro", os: "macOS", online: true, self: true },
        { name: "ipad171", os: "iOS", online: true, self: false },
        { name: "old-laptop", os: "windows", online: false, self: false },
      ],
    });
  });

  it("carries no addresses, keys or account details", () => {
    const report = JSON.stringify(parseRemoteAccess(status(), SERVING, PORT));
    for (const secret of [
      "100.101.102.103",
      "fd7a:",
      "192.168.",
      "203.0.113.9",
      "nodekey",
      "n1CNTRL",
      "owner@example.com",
      "Owner",
      "UserID",
    ])
      expect(report).not.toContain(secret);
  });

  it("leaves out a device whose only name is an address", () => {
    const report = parseRemoteAccess(
      status({ Peer: { a: node({ HostName: "100.64.0.9", DNSName: "", OS: "linux", Online: true }) } }),
      "{}",
      PORT,
    );
    expect(report.devices.map((d) => d.name)).toEqual(["alfreds-macbook-pro"]);
  });

  it("caps the list at 64 with self first, keeping online devices over offline ones", () => {
    const Peer = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `k${i}`,
        node({ HostName: `peer-${String(i).padStart(3, "0")}`, DNSName: "", OS: "linux", Online: i >= 90 }),
      ]),
    );
    const { devices } = parseRemoteAccess(status({ Peer }), "{}", PORT);
    expect(devices).toHaveLength(64);
    expect(devices[0]).toMatchObject({ self: true });
    expect(devices.slice(1, 11).every((d) => d.online)).toBe(true);
  });

  it("clamps oversized names and OS strings instead of producing a report the API would refuse", () => {
    const report = parseRemoteAccess(
      status({
        Self: node({ HostName: "h".repeat(300), DNSName: "", OS: "o".repeat(99), Online: true }),
        Peer: null,
      }),
      "{}",
      PORT,
    );
    expect(report.state).toBe("RUNNING");
    expect(report.devices[0]!.name).toHaveLength(128);
    expect(report.devices[0]!.os).toHaveLength(32);
    expect(RemoteAccessReport.safeParse(report).success).toBe(true);
  });

  it.each([
    ["Running", "RUNNING"],
    ["NeedsLogin", "NEEDS_LOGIN"],
    ["NeedsMachineAuth", "NEEDS_LOGIN"],
    ["Stopped", "STOPPED"],
    ["Starting", "STOPPED"],
    ["NoState", "STOPPED"],
  ])("maps BackendState %s to %s", (BackendState, state) => {
    expect(parseRemoteAccess(status({ BackendState }), "{}", PORT).state).toBe(state);
  });

  it("copes with a logged-out daemon: no Self, no Peer", () => {
    expect(
      parseRemoteAccess(status({ BackendState: "NeedsLogin", Self: null, Peer: null }), "{}", PORT),
    ).toEqual({
      state: "NEEDS_LOGIN",
      url: null,
      serving: false,
      funnel: false,
      devices: [],
    });
  });

  it("nothing served: {} or null", () => {
    for (const serve of ["{}", "null"])
      expect(parseRemoteAccess(status(), serve, PORT)).toMatchObject({
        url: null,
        serving: false,
        funnel: false,
      });
  });

  it.each([
    ["localhost", "http://localhost:8787", true],
    ["without a scheme", "127.0.0.1:8787", true],
    ["another port", "http://127.0.0.1:3000", false],
    ["another host", "http://192.168.1.5:8787", false],
    ["a look-alike host", "http://127.0.0.1.evil.test:8787", false],
    ["a static path", "/var/www", false],
  ])("serving: proxy to %s", (_, Proxy, serving) => {
    const serve = servingWith({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy } } } } });
    expect(parseRemoteAccess(status(), serve, PORT)).toMatchObject({ serving, url: `https://${HOST}` });
  });

  it("picks the host that serves NEXUS over another one, and keeps a non-default port", () => {
    const serve = servingWith({
      Web: {
        [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } },
      },
    });
    expect(parseRemoteAccess(status(), serve, PORT)).toMatchObject({
      serving: true,
      url: `https://${HOST}:8443`,
    });
  });

  it("funnel is on when any host allows it", () => {
    const on = servingWith({ AllowFunnel: { [`${HOST}:443`]: true } });
    const off = servingWith({ AllowFunnel: { [`${HOST}:443`]: false } });
    expect(parseRemoteAccess(status(), on, PORT).funnel).toBe(true);
    expect(parseRemoteAccess(status(), off, PORT).funnel).toBe(false);
  });

  it.each([
    ["non-JSON status", "The Tailscale GUI failed to start", "{}"],
    ["non-JSON serve", status(), "not json"],
    ["status without BackendState", "{}", "{}"],
    ["wrong types", status({ Peer: { a: { Online: "yes" } } }), "{}"],
    ["a host the report can't carry", status(), servingWith({ Web: { "bad host:443": {} } })],
  ])("%s is UNAVAILABLE", (_, statusJson, serveJson) => {
    expect(parseRemoteAccess(statusJson, serveJson, PORT)).toEqual({
      state: "UNAVAILABLE",
      url: null,
      serving: false,
      funnel: false,
      devices: [],
    });
  });
});

const fail = (code: string | number) => Object.assign(new Error("boom 100.101.102.103"), { code });
const okExec = (statusJson = status(), serveJson = SERVING) =>
  vi.fn<Exec>(async (_file, args) => ({ stdout: args[0] === "serve" ? serveJson : statusJson }));

describe("collectRemoteAccess", () => {
  it("runs only the two read-only commands, without a shell, under a time and size limit", async () => {
    const exec = okExec();
    await expect(collectRemoteAccess(PORT, { exec })).resolves.toMatchObject({
      state: "RUNNING",
      serving: true,
    });
    expect(exec.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
      ["tailscale", "status", "--json"],
      ["tailscale", "serve", "status", "--json"],
    ]);
    expect(exec.mock.calls[0]![2]).toMatchObject({ shell: false, timeout: 5_000, maxBuffer: 1024 * 1024 });
  });

  it("sets TERM (the macOS binary opens its GUI without it) and passes on nothing else from the runner", async () => {
    vi.stubEnv("NEXUS_SECRET_FOR_TEST", "s3cret");
    const exec = okExec();
    await collectRemoteAccess(PORT, { exec });
    vi.unstubAllEnvs();
    expect(Object.keys(exec.mock.calls[0]![2].env).sort()).toEqual(["HOME", "PATH", "TERM"]);
    expect(exec.mock.calls[0]![2].env.TERM).toBeTruthy();
  });

  it("falls back to the app binary when tailscale isn't on PATH, and uses it for both commands", async () => {
    const exec = vi.fn<Exec>(async (file, args) => {
      if (file === "tailscale") throw fail("ENOENT");
      return { stdout: args[0] === "serve" ? SERVING : status() };
    });
    await expect(collectRemoteAccess(PORT, { exec })).resolves.toMatchObject({ state: "RUNNING" });
    expect(exec.mock.calls.map(([file]) => file)).toEqual(["tailscale", APP_BINARY, APP_BINARY]);
  });

  it("NOT_INSTALLED when neither binary exists", async () => {
    const exec = vi.fn<Exec>(async () => {
      throw fail("ENOENT");
    });
    await expect(collectRemoteAccess(PORT, { exec })).resolves.toMatchObject({
      state: "NOT_INSTALLED",
      devices: [],
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a non-zero exit", 1],
    ["a timeout", "ETIMEDOUT"],
    ["too much output", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"],
  ])("UNAVAILABLE on %s, without leaking the error", async (_, code) => {
    const exec = vi.fn<Exec>(async () => {
      throw fail(code);
    });
    const report = await collectRemoteAccess(PORT, { exec });
    expect(report).toMatchObject({ state: "UNAVAILABLE", devices: [] });
    expect(JSON.stringify(report)).not.toContain("100.101");
  });

  it("UNAVAILABLE when serve status fails after status worked", async () => {
    const exec = vi.fn<Exec>(async (_file, args) => {
      if (args[0] === "serve") throw fail(1);
      return { stdout: status() };
    });
    await expect(collectRemoteAccess(PORT, { exec })).resolves.toMatchObject({ state: "UNAVAILABLE" });
  });

  it("UNAVAILABLE when exec throws synchronously", async () => {
    const exec: Exec = () => {
      throw new TypeError("bad");
    };
    await expect(collectRemoteAccess(PORT, { exec })).resolves.toMatchObject({ state: "UNAVAILABLE" });
  });

  it("derives the port from NEXUS_API_URL", () => {
    expect(apiPortOf("http://127.0.0.1:8787")).toBe(8787);
    expect(apiPortOf("https://nexus.example.com")).toBe(443);
    expect(apiPortOf("http://localhost")).toBe(80);
  });
});

const REPORT: RemoteAccessReport = {
  state: "RUNNING",
  url: null,
  serving: false,
  funnel: false,
  devices: [],
};
const reported = (beats: { remoteAccess?: unknown }[]) => beats.filter((b) => b.remoteAccess);
const until = (cond: () => boolean) =>
  vi.waitFor(() => expect(cond()).toBe(true), { timeout: 3_000, interval: 5 });
const untilAborted = (signal: AbortSignal) =>
  new Promise<RemoteAccessReport>((resolve) =>
    signal.addEventListener("abort", () => resolve(REPORT), { once: true }),
  );

describe("runner loop", () => {
  it("attaches each collected report to exactly one beat", async () => {
    const { api, heartbeats } = fakeApi();
    let collected = 0;
    const collectRemoteAccess = async () => {
      collected++;
      return REPORT;
    };
    const runner = startRunner(api, {
      heartbeatMs: 5,
      remoteAccessMs: 60_000,
      collectRemoteAccess,
      log: () => {},
    });
    await until(() => heartbeats.length > 8);
    await runner.stop();
    expect(collected).toBe(1);
    expect(reported(heartbeats)).toEqual([{ activeJobIds: [], remoteAccess: REPORT }]);
  });

  it("sends a fresh report after every collection", async () => {
    const { api, heartbeats } = fakeApi();
    const runner = startRunner(api, {
      heartbeatMs: 5,
      remoteAccessMs: 20,
      collectRemoteAccess: async () => REPORT,
      log: () => {},
    });
    await until(() => reported(heartbeats).length >= 3);
    await runner.stop();
  });

  it("a collector that never answers doesn't delay a single beat, and stop still finishes", async () => {
    const { api, heartbeats } = fakeApi();
    let aborted = false;
    const runner = startRunner(api, {
      heartbeatMs: 5,
      collectRemoteAccess: (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return untilAborted(signal);
      },
      log: () => {},
    });
    await until(() => heartbeats.length >= 5);
    await runner.stop();
    expect(aborted).toBe(true);
    expect(reported(heartbeats)).toEqual([]); // the report cut short by shutdown is not sent
  });

  it("a collector that rejects never touches the runner", async () => {
    const { api, heartbeats } = fakeApi();
    const runner = startRunner(api, {
      heartbeatMs: 5,
      remoteAccessMs: 5,
      collectRemoteAccess: () => Promise.reject(new Error("boom")),
      log: () => {},
    });
    await until(() => heartbeats.length >= 3);
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it("doesn't retry a report whose beat failed", async () => {
    let failing = true;
    const { api, heartbeats } = fakeApi({
      heartbeat: () => (failing ? new Response("down", { status: 503 }) : json(200, { cancelJobIds: [] })),
    });
    const runner = startRunner(api, {
      heartbeatMs: 5,
      remoteAccessMs: 60_000,
      collectRemoteAccess: async () => REPORT,
      log: () => {},
    });
    await until(() => reported(heartbeats).length === 1);
    failing = false;
    const seen = heartbeats.length;
    await until(() => heartbeats.length >= seen + 3);
    await runner.stop();
    expect(reported(heartbeats)).toHaveLength(1);
  });

  it("collects nothing when no collector is given", async () => {
    const { api, heartbeats } = fakeApi();
    const runner = startRunner(api, { heartbeatMs: 5, log: () => {} });
    await until(() => heartbeats.length >= 3);
    await sleep(10);
    await runner.stop();
    expect(reported(heartbeats)).toEqual([]);
  });
});

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appName, buildManifest, startSetup, writeAppConfig } from "../src/cli/github-setup.ts";
import { loadGithubAppConfig } from "../src/github/app-config.ts";
import { testGithubApp } from "./helpers/owner-session.ts";

const ORIGIN = "https://nexus.tail0000.ts.net";
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-setup-"));
  file = join(dir, "nested", "github-app.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONVERT = "POST https://api.github.com/app-manifests/the-code/conversions";

/** Stubs GitHub by `"METHOD url"`; requests to the local setup server go through, anything else is a 404. */
function stubGithub(routes: Record<string, () => Response>) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    return routes[`${init?.method ?? "GET"} ${url}`]?.() ?? new Response("not found", { status: 404 });
  });
}

/** Loads the setup page and returns the form's GitHub URL (with the state) and the manifest it posts. */
async function openSetupPage(url: string) {
  const html = await (await fetch(url)).text();
  const unescape = (s: string) => s.replaceAll("&#34;", '"').replaceAll("&#38;", "&");
  return {
    action: new URL(unescape(/action="([^"]+)"/.exec(html)![1]!)),
    manifest: JSON.parse(unescape(/value="([^"]+)"/.exec(html)![1]!)) as Record<string, unknown>,
  };
}

const conversion = () => ({
  id: 4242,
  slug: "nexus-home-abc123",
  html_url: "https://github.com/apps/nexus-home-abc123",
  client_id: `Iv23${randomBytes(8).toString("hex")}`,
  client_secret: randomBytes(20).toString("hex"),
  pem: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
  webhook_secret: null,
  owner: { id: 777, login: "octo-owner", type: "User" },
});

describe("github:setup", () => {
  it("builds a least-privilege manifest with a short unique name and an inactive webhook", () => {
    const m = buildManifest(
      ORIGIN,
      "http://127.0.0.1:5000/callback",
      appName("my-very-long-hostname-for-sure.local"),
    );
    expect(m.name).toMatch(/^NEXUS my-very-long-hostnam [0-9a-f]{6}$/);
    expect(m.name.length).toBeLessThanOrEqual(34);
    expect(m).toMatchObject({
      url: ORIGIN,
      public: false,
      callback_urls: [`${ORIGIN}/api/auth/callback/github`],
      hook_attributes: { url: `${ORIGIN}/v1/webhooks/github`, active: false },
      default_permissions: {
        metadata: "read",
        issues: "read",
        pull_requests: "write",
        contents: "write",
        checks: "read",
        email_addresses: "read",
      },
    });
  });

  it("runs the manifest flow: form post to GitHub, state check, conversion, 0600 file", async () => {
    const conv = conversion();
    const github = stubGithub({ [CONVERT]: () => Response.json(conv, { status: 201 }) });
    const { url, result } = await startSetup({ file, publicOrigin: ORIGIN });

    const { action, manifest } = await openSetupPage(url);
    expect(action.origin + action.pathname).toBe("https://github.com/settings/apps/new");
    const state = action.searchParams.get("state")!;
    expect(manifest.redirect_url).toBe(new URL("/callback", url).toString());

    const wrong = await fetch(`${url}callback?code=the-code&state=nope`);
    expect(wrong.status).toBe(400);
    const ok = await fetch(`${url}callback?code=the-code&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(200);

    const saved = await result;
    expect(saved).toMatchObject({
      appId: 4242,
      slug: conv.slug,
      htmlUrl: conv.html_url,
      clientId: conv.client_id,
      clientSecret: conv.client_secret,
      privateKey: conv.pem,
      ownerGithubUserId: 777,
      ownerGithubLogin: "octo-owner",
    });
    expect(saved.webhookSecret.length).toBeGreaterThanOrEqual(32); // generated: GitHub sent none
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(loadGithubAppConfig(file)).toEqual(saved);
    expect(github.mock.calls.filter(([u]) => String(u).startsWith("https://"))).toHaveLength(1); // one exchange
    await expect(fetch(url)).rejects.toThrow(); // server is gone
  });

  it("posts to the organization's app form and takes the owner from --owner", async () => {
    const conv = { ...conversion(), owner: { id: 9, login: "acme", type: "Organization" } };
    stubGithub({
      [CONVERT]: () => Response.json(conv, { status: 201 }),
      "GET https://api.github.com/users/octo-owner": () =>
        Response.json({ id: 777, login: "octo-owner", type: "User" }),
    });
    const { url, result } = await startSetup({
      file,
      publicOrigin: ORIGIN,
      org: "acme",
      owner: "octo-owner",
    });
    const { action } = await openSetupPage(url);
    expect(action.origin + action.pathname).toBe("https://github.com/organizations/acme/settings/apps/new");
    await fetch(`${url}callback?code=the-code&state=${action.searchParams.get("state")}`);
    expect(await result).toMatchObject({ ownerGithubUserId: 777, ownerGithubLogin: "octo-owner" });
  });

  it("refuses to overwrite an existing file unless forced", () => {
    const first = testGithubApp();
    writeAppConfig(file, first);
    expect(() => writeAppConfig(file, testGithubApp())).toThrow(/already exists.*--force/);
    expect(loadGithubAppConfig(file)).toEqual(first);
    const second = testGithubApp();
    writeAppConfig(file, second, true);
    expect(loadGithubAppConfig(file)).toEqual(second);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects a foreign Host header (DNS rebinding) and times out cleanly", async () => {
    const { url, result } = await startSetup({ file, publicOrigin: ORIGIN, timeoutMs: 100 });
    const timedOut = expect(result).rejects.toThrow(/Timed out/);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      get(url, { headers: { host: "evil.example" } }, (res) => resolve(res.resume().statusCode)).on(
        "error",
        reject,
      ),
    );
    expect(status).toBe(400);
    await timedOut;
    expect(existsSync(file)).toBe(false);
  });

  it("writes nothing when GitHub's conversion fails", async () => {
    stubGithub({ [CONVERT]: () => Response.json({ message: "Not Found" }, { status: 404 }) });
    const { url, result } = await startSetup({ file, publicOrigin: ORIGIN });
    const failed = expect(result).rejects.toThrow(/HTTP 404/);
    const { action } = await openSetupPage(url);
    const res = await fetch(`${url}callback?code=the-code&state=${action.searchParams.get("state")}`);
    expect(res.status).toBe(500);
    await failed;
    expect(existsSync(file)).toBe(false);
  });
});

describe("loadGithubAppConfig", () => {
  it("never echoes file contents when the file is broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-appcfg-"));
    const file = join(dir, "github-app.json");
    const secret = randomBytes(24).toString("hex");
    try {
      writeFileSync(file, `{"clientSecret": "${secret}", oops`, { mode: 0o600 });
      expect(() => loadGithubAppConfig(file)).toThrow(/not valid JSON/);
      expect(() => loadGithubAppConfig(file)).not.toThrow(new RegExp(secret));
      writeFileSync(file, JSON.stringify({ clientSecret: secret }), { mode: 0o600 });
      expect(() => loadGithubAppConfig(file)).toThrow(/is invalid \(fields: /);
      expect(() => loadGithubAppConfig(file)).not.toThrow(new RegExp(secret));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

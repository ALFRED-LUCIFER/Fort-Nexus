import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_SETUP_COMMAND } from "@nexus/contracts";
import { buildApp } from "../src/app.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// GitHub is stubbed at fetch level: Octokit, JWT signing and installation-token handling are production code.
const GH = "https://api.github.com";
const TOKENS: Record<number, string> = {
  1: `ghs_${randomBytes(18).toString("hex")}`,
  2: `ghs_${randomBytes(18).toString("hex")}`,
};

let t: TestApp;
let cookie: string;
// The catalog caches for 60 s; every test starts two minutes later so it sees fresh GitHub data.
let clock = Date.parse("2026-10-28T10:00:00Z");

type Route = (req: { url: URL; auth: string }) => Response | undefined;
type GhCall = { method: string; url: URL; auth: string };

/** Stubs GitHub by `"METHOD /path"`; unknown requests are a 404 like GitHub's. Returns the call log. */
function stubGithub(routes: Record<string, Route>) {
  const calls: GhCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const auth = String(new Headers(init?.headers).get("authorization") ?? "");
    calls.push({ method, url, auth });
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    return (
      routes[`${method} ${url.pathname}`]?.({ url, auth }) ??
      Response.json({ message: "Not Found" }, { status: 404 })
    );
  });
  return calls;
}

const installation = (id: number, login: string, over: Record<string, unknown> = {}) => ({
  id,
  account: { login, type: "User" },
  repository_selection: "selected",
  suspended_at: null,
  permissions: { metadata: "read", issues: "read", pull_requests: "write" },
  ...over,
});
const repo = (id: number, fullName: string) => {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    id,
    name,
    full_name: fullName,
    owner: { login: owner },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    pushed_at: "2026-10-27T08:00:00Z",
    updated_at: "2026-10-27T09:00:00Z",
  };
};
const issue = (number: number, fullName: string, over: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [{ name: "bug", color: "d73a4a" }, "loose-label"],
  assignees: [{ login: "octo" }],
  milestone: { title: "v1" },
  user: { login: "reporter" },
  comments: 1,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  html_url: `https://github.com/${fullName}/issues/${number}`,
  repository_url: `${GH}/repos/${fullName}`,
  body: "",
  ...over,
});
const pr = (number: number, fullName: string) =>
  issue(number, fullName, { pull_request: { url: `${GH}/repos/${fullName}/pulls/${number}` } });

/** Two installations: acme (id 1) has acme/web + acme/api, octo (id 2) has octo/tool. */
const catalogRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  "GET /app/installations": ({ auth }) =>
    auth.startsWith("bearer ")
      ? Response.json([installation(1, "acme"), installation(2, "octo")])
      : undefined,
  "POST /app/installations/1/access_tokens": () => accessToken(1),
  "POST /app/installations/2/access_tokens": () => accessToken(2),
  "GET /installation/repositories": ({ auth }) =>
    Response.json(
      auth === `token ${TOKENS[1]}`
        ? { total_count: 2, repositories: [repo(101, "acme/web"), repo(102, "acme/api")] }
        : { total_count: 1, repositories: [repo(201, "octo/tool")] },
    ),
  ...over,
});
const accessToken = (id: number) =>
  Response.json(
    {
      token: TOKENS[id],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { issues: "read" },
      repository_selection: "selected",
    },
    { status: 201 },
  );

const get = (url: string, c: string | null = cookie) =>
  t.app.inject({ method: "GET", url, headers: c ? { cookie: c } : {} });

beforeAll(async () => {
  t = await createTestApp();
  cookie = await ownerSession(t);
});
afterAll(async () => {
  vi.useRealTimers();
  await t.app.close();
});
beforeEach(() => {
  clock += 120_000;
  vi.setSystemTime(clock);
});
afterEach(() => vi.restoreAllMocks());

describe("GitHub status", () => {
  it("needs the owner session", async () => {
    stubGithub(catalogRoutes());
    for (const url of ["/v1/github/status", "/v1/repositories", "/v1/repositories/101/issues"])
      expect((await get(url, null)).statusCode).toBe(401);
  });

  it("shows the install link when the app has no installation", async () => {
    stubGithub({ "GET /app/installations": () => Response.json([]) });
    const res = await get("/v1/github/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      appSlug: t.githubApp!.slug,
      installUrl: `${t.githubApp!.htmlUrl}/installations/new`,
      installations: [],
      syncedAt: new Date(clock).toISOString(),
    });
  });

  it("lists installations with their account, scope and permissions", async () => {
    stubGithub({
      "GET /app/installations": () =>
        Response.json([
          installation(1, "acme", {
            account: { login: "acme", type: "Organization" },
            repository_selection: "all",
          }),
          installation(2, "octo", { suspended_at: "2026-10-01T00:00:00Z" }),
        ]),
    });
    const body = (await get("/v1/github/status")).json();
    expect(body.installations).toEqual([
      {
        id: 1,
        account: { login: "acme", type: "Organization" },
        repositorySelection: "all",
        suspended: false,
        permissions: { metadata: "read", issues: "read", pull_requests: "write" },
      },
      expect.objectContaining({ id: 2, suspended: true }),
    ]);
  });

  it("explains how to set GitHub up when the app file is missing", async () => {
    // Same database and secret, so the owner's session stays valid; only the app file is gone.
    const bare = await buildApp({ ...t.config, githubAppFile: "/nonexistent/github-app.json" });
    try {
      const fetchSpy = stubGithub({});
      const status = await bare.inject({ method: "GET", url: "/v1/github/status", headers: { cookie } });
      expect(status.json()).toEqual({ configured: false });
      const repos = await bare.inject({ method: "GET", url: "/v1/repositories", headers: { cookie } });
      expect(repos.statusCode).toBe(409);
      expect(repos.json().error).toMatchObject({
        code: "CONFLICT",
        details: { setupCommand: GITHUB_SETUP_COMMAND },
      });
      expect(repos.json().error.message).toContain(GITHUB_SETUP_COMMAND);
      expect(fetchSpy).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});

describe("repository catalog", () => {
  it("returns only repositories of the app's installations, searchable by name (GH-G01)", async () => {
    const calls = stubGithub(catalogRoutes());
    const res = await get("/v1/repositories");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((r: { fullName: string }) => r.fullName)).toEqual([
      "acme/api",
      "acme/web",
      "octo/tool",
    ]);
    expect(body.items[1]).toEqual({
      id: "101",
      fullName: "acme/web",
      owner: "acme",
      name: "web",
      private: true,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/web",
      pushedAt: "2026-10-27T08:00:00.000Z",
      updatedAt: "2026-10-27T09:00:00.000Z",
      installationId: 1,
    });
    // Each installation's repositories are read with that installation's own token.
    const listings = calls.filter((c) => c.url.pathname === "/installation/repositories").map((c) => c.auth);
    expect(listings.sort()).toEqual([`token ${TOKENS[1]}`, `token ${TOKENS[2]}`].sort());

    const search = (await get("/v1/repositories?q=WEB")).json();
    expect(search.items.map((r: { id: string }) => r.id)).toEqual(["101"]);
  });

  it("answers 404 for a repository outside the installations, without asking GitHub about it", async () => {
    const calls = stubGithub(
      catalogRoutes({ "GET /repos/other/secret/issues": () => Response.json([issue(1, "other/secret")]) }),
    );
    const res = await get("/v1/repositories/999/issues");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect((await get("/v1/repositories/999/issues/1")).statusCode).toBe(404);
    expect(calls.some((c) => c.url.pathname.startsWith("/repos/"))).toBe(false);
    expect((await get("/v1/repositories/not-a-number/issues")).statusCode).toBe(400);
  });
});

describe("issues", () => {
  it("excludes pull requests and passes filters and pagination through (GH-G02)", async () => {
    const calls = stubGithub(
      catalogRoutes({
        "GET /repos/acme/web/issues": ({ url }) =>
          url.searchParams.get("page") === "1"
            ? Response.json([issue(1, "acme/web"), pr(2, "acme/web"), issue(3, "acme/web")], {
                headers: { link: `<${GH}/repositories/101/issues?page=2>; rel="next"` },
              })
            : Response.json([issue(4, "acme/web")]),
      }),
    );
    const first = await get("/v1/repositories/101/issues?state=closed&labels=bug,ui&assignee=octo");
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.items.map((i: { number: number }) => i.number)).toEqual([1, 3]);
    expect(page1).toMatchObject({ page: 1, nextPage: 2 });
    expect(page1.items[0]).toEqual({
      number: 1,
      title: "Issue 1",
      state: "open",
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "loose-label", color: "" },
      ],
      assignees: ["octo"],
      milestone: "v1",
      author: "reporter",
      comments: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-27T10:00:00.000Z",
      htmlUrl: "https://github.com/acme/web/issues/1",
    });

    const page2 = (
      await get("/v1/repositories/101/issues?state=closed&labels=bug,ui&assignee=octo&page=2")
    ).json();
    expect(page2).toMatchObject({ page: 2, nextPage: null, items: [{ number: 4 }] });

    const sent = calls.filter((c) => c.url.pathname === "/repos/acme/web/issues");
    expect(sent).toHaveLength(2);
    for (const [i, c] of sent.entries()) {
      expect(Object.fromEntries(c.url.searchParams)).toMatchObject({
        state: "closed",
        labels: "bug,ui",
        assignee: "octo",
        page: String(i + 1),
        per_page: "25",
      });
      expect(c.auth).toBe(`token ${TOKENS[1]}`);
    }
  });

  it("rejects malformed filters", async () => {
    stubGithub(catalogRoutes());
    for (const q of ["state=draft", "assignee=bad%20login", 'labels=a"b', "page=0", "page=41"])
      expect((await get(`/v1/repositories/101/issues?${q}`)).statusCode, q).toBe(400);
  });

  it("searches full text without letting the words add qualifiers", async () => {
    const calls = stubGithub(
      catalogRoutes({
        "GET /search/issues": () =>
          Response.json({
            total_count: 60,
            items: [issue(7, "acme/web"), issue(8, "octo/tool"), pr(9, "acme/web")],
          }),
      }),
    );
    const res = (await get("/v1/repositories/101/issues?q=cart%20repo:octo/tool&labels=bug")).json();
    expect(res.items.map((i: { number: number }) => i.number)).toEqual([7]);
    expect(res.nextPage).toBe(2);
    const q = calls.find((c) => c.url.pathname === "/search/issues")!.url.searchParams.get("q");
    expect(q).toBe('repo:acme/web is:issue state:open label:"bug" "cart" "repo:octo/tool"');
  });
});

describe("issue detail", () => {
  const body = [
    "<!-- template: describe the bug -->",
    "Totals are wrong for EUR.",
    "",
    "## Acceptance criteria",
    "- [ ] Rounds per currency minor unit",
    "- [x] No change for USD",
    "",
    "## Notes",
    "- not a criterion",
  ].join("\n");

  it("returns the plain-text body, comments and extracted acceptance criteria", async () => {
    stubGithub(
      catalogRoutes({
        "GET /repos/acme/web/issues/42": () => Response.json(issue(42, "acme/web", { body })),
        "GET /repos/acme/web/issues/42/comments": () =>
          Response.json([
            { user: { login: "dev" }, body: "<b>LGTM</b>", created_at: "2026-10-21T10:00:00Z" },
          ]),
        "GET /repos/acme/web/issues/43": () =>
          Response.json(issue(43, "acme/web", { body: "Make it faster." })),
        "GET /repos/acme/web/issues/43/comments": () => Response.json([]),
      }),
    );
    const res = await get("/v1/repositories/101/issues/42");
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.issue.number).toBe(42);
    expect(d.body).toBe(body.replace("<!-- template: describe the bug -->\n", ""));
    expect(d.acceptanceCriteria).toEqual(["Rounds per currency minor unit", "No change for USD"]);
    expect(d.missingAcceptanceCriteria).toBe(false);
    expect(d.comments).toEqual([
      { author: "dev", body: "<b>LGTM</b>", createdAt: "2026-10-21T10:00:00.000Z" },
    ]);
    expect(d.syncedAt).toBe(new Date(clock).toISOString());

    const bare = (await get("/v1/repositories/101/issues/43")).json();
    expect(bare).toMatchObject({ acceptanceCriteria: [], missingAcceptanceCriteria: true });
  });

  it("answers 404 for a pull request number or a missing issue", async () => {
    stubGithub(
      catalogRoutes({
        "GET /repos/acme/web/issues/2": () => Response.json(pr(2, "acme/web")),
        "GET /repos/acme/web": () => Response.json(repo(101, "acme/web")),
      }),
    );
    const prRes = await get("/v1/repositories/101/issues/2");
    expect(prRes.statusCode).toBe(404);
    expect(prRes.json().error.message).toMatch(/pull request/);
    const missing = await get("/v1/repositories/101/issues/77");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("Issue #77 not found in acme/web.");
  });
});

describe("lost access and GitHub errors", () => {
  it("denies a repository the app lost, without trying other credentials (GH-G04)", async () => {
    const calls = stubGithub(
      catalogRoutes({
        "GET /repos/octo/tool/issues": () => Response.json({ message: "Not Found" }, { status: 404 }),
        "GET /repos/octo/tool/issues/5": () => Response.json({ message: "Not Found" }, { status: 404 }),
      }),
    );
    const list = await get("/v1/repositories/201/issues");
    expect(list.statusCode).toBe(403);
    expect(list.json().error).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("can't access octo/tool"),
      details: { installUrl: `${t.githubApp!.htmlUrl}/installations/new` },
    });
    // The issue endpoint can't tell "no such issue" from "no access": the repository probe decides.
    const detail = await get("/v1/repositories/201/issues/5");
    expect(detail.statusCode).toBe(403);
    const repoCalls = calls.filter((c) => c.url.pathname.startsWith("/repos/octo/tool"));
    expect(repoCalls.length).toBeGreaterThan(0);
    for (const c of repoCalls) expect(c.auth).toBe(`token ${TOKENS[2]}`);
  });

  it("denies repositories of an installation whose token can't be issued", async () => {
    stubGithub(
      catalogRoutes({
        "GET /app/installations": () => Response.json([installation(3, "gone")]),
        "POST /app/installations/3/access_tokens": () =>
          Response.json({ message: "This installation has been suspended" }, { status: 403 }),
      }),
    );
    const res = await get("/v1/repositories");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/installation is gone or suspended/);
  });

  it("maps GitHub's rate limit to 429 with the reset time and stops calling until then", async () => {
    const reset = Math.floor(clock / 1000) + 60;
    const calls = stubGithub({
      "GET /app/installations": () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
        ),
    });
    const res = await get("/v1/github/status");
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({
      code: "RATE_LIMITED",
      details: { resetAt: new Date(reset * 1000).toISOString() },
    });
    expect((await get("/v1/repositories")).statusCode).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("maps a GitHub 403 to FORBIDDEN and an outage to 502", async () => {
    stubGithub({ "GET /app/installations": () => Response.json({ message: "Forbidden" }, { status: 403 }) });
    expect((await get("/v1/github/status")).json().error.code).toBe("FORBIDDEN");
    vi.restoreAllMocks();
    vi.setSystemTime((clock += 120_000));
    stubGithub({ "GET /app/installations": () => new Response("bad gateway", { status: 502 }) });
    const res = await get("/v1/github/status");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/GitHub is unavailable/);
  });

  it("never puts an installation token or the app key in a response", async () => {
    stubGithub(
      catalogRoutes({
        "GET /repos/acme/web/issues": () => Response.json([issue(1, "acme/web")]),
        "GET /repos/acme/web/issues/1": () => Response.json(issue(1, "acme/web")),
        "GET /repos/acme/web/issues/1/comments": () => Response.json([]),
        "GET /repos/octo/tool/issues": () => Response.json({ message: "Bad credentials" }, { status: 401 }),
      }),
    );
    const bodies = await Promise.all(
      [
        "/v1/github/status",
        "/v1/repositories",
        "/v1/repositories/101/issues",
        "/v1/repositories/101/issues/1",
        "/v1/repositories/201/issues",
      ].map(async (u) => (await get(u)).body),
    );
    const secrets = [
      TOKENS[1]!,
      TOKENS[2]!,
      t.githubApp!.clientSecret,
      t.githubApp!.privateKey.split("\n")[1]!,
    ];
    for (const b of bodies) for (const s of secrets) expect(b).not.toContain(s);
    expect(JSON.parse(bodies[4]!).error.code).toBe("FORBIDDEN");
  });
});

import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";

// GitHub is a stateful fake at fetch level (refs, PRs, objects); Octokit and token minting are production code.
export const GH = "https://api.github.com";
export const BASE_SHA = "a".repeat(40);
export const BASE_TREE = "b".repeat(40);
export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
export const b64 = (s: string) => Buffer.from(s).toString("base64");

export type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  body: Record<string, unknown>;
};

export function fakeGithub() {
  const calls: Call[] = [];
  const mints: { installationId: number; body: Record<string, unknown>; token: string }[] = [];
  const tokenInstallation = new Map<string, number>();
  const refs = new Map<string, string>();
  const pulls: { number: number; html_url: string; head: { ref: string; sha: string }; base: string }[] = [];
  const state = {
    failRestrictedMint: false,
    hang: null as string | null,
    release: () => {},
    // The next `left` calls to `key` get `status` (an outage, a rate limit or a refusal).
    outage: null as {
      key: string;
      status: number;
      left: number;
      headers?: Record<string, string>;
      thrown?: Error;
    } | null,
  };

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const notFound = () => json({ message: "Not Found" }, 404);
  const issue = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `Fix cart totals ${number}`,
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    user: { login: "reporter" },
    comments: 0,
    created_at: "2026-10-20T10:00:00Z",
    updated_at: "2026-10-27T10:00:00Z",
    html_url: `https://github.com/acme/web/issues/${number}`,
    repository_url: `${GH}/repos/acme/web`,
    body: "",
    ...over,
  });
  const issues: Record<number, unknown> = {
    42: issue(42, { body: "Totals are wrong.\n\n## Acceptance criteria\n- Rounds per currency" }),
    43: issue(43, { body: "Make it faster." }),
    2: issue(2, { pull_request: { url: `${GH}/repos/acme/web/pulls/2` } }),
  };
  const repo = (id: number, fullName: string) => ({
    id,
    name: fullName.split("/")[1],
    full_name: fullName,
    owner: { login: fullName.split("/")[0] },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    pushed_at: null,
    updated_at: null,
  });

  function route(c: Call): Response | undefined {
    const key = `${c.method} ${c.path}`;
    let m: RegExpMatchArray | null;
    if (key === "GET /app/installations")
      return json([
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", issues: "read", contents: "write", pull_requests: "write" },
        },
        {
          id: 2,
          account: { login: "octo", type: "User" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", contents: "read", pull_requests: "write" },
        },
      ]);
    if ((m = key.match(/^POST \/app\/installations\/(\d+)\/access_tokens$/))) {
      const restricted = "repository_ids" in c.body;
      if (restricted && state.failRestrictedMint) return json({ message: "Server Error" }, 500);
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      tokenInstallation.set(token, Number(m[1]));
      if (restricted) mints.push({ installationId: Number(m[1]), body: c.body, token });
      return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (key === "GET /installation/repositories") {
      const inst = tokenInstallation.get(c.auth.replace(/^token /, ""));
      return json(
        inst === 1
          ? { total_count: 1, repositories: [repo(101, "acme/web")] }
          : { total_count: 1, repositories: [repo(201, "octo/tool")] },
      );
    }
    if (key === "GET /repos/acme/web") return json(repo(101, "acme/web"));
    if ((m = key.match(/^GET \/repos\/acme\/web\/issues\/(\d+)$/))) {
      const found = issues[Number(m[1])];
      return found ? json(found) : notFound();
    }
    if (/^GET \/repos\/acme\/web\/issues\/\d+\/comments$/.test(key)) return json([]);
    if (key === "GET /repos/acme/web/branches/main") return json({ name: "main", commit: { sha: BASE_SHA } });
    if (key === `GET /repos/acme/web/git/commits/${BASE_SHA}`)
      return json({ sha: BASE_SHA, tree: { sha: BASE_TREE } });
    if (key === "POST /repos/acme/web/git/blobs") return json({ sha: sha1(String(c.body.content)) }, 201);
    if (key === "POST /repos/acme/web/git/trees" || key === "POST /repos/acme/web/git/commits")
      return json({ sha: sha1(JSON.stringify(c.body)) }, 201);
    if ((m = key.match(/^GET \/repos\/acme\/web\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1]!);
      return sha ? json({ ref: `refs/heads/${m[1]}`, object: { sha } }) : notFound();
    }
    if (key === "POST /repos/acme/web/git/refs") {
      const branch = String(c.body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(branch)) return json({ message: "Reference already exists" }, 422);
      refs.set(branch, String(c.body.sha));
      return json({ ref: c.body.ref, object: { sha: c.body.sha } }, 201);
    }
    if (key === "GET /repos/acme/web/pulls") {
      const head = c.query.get("head")!.replace(/^acme:/, "");
      return json(pulls.filter((p) => p.head.ref === head));
    }
    if (key === "POST /repos/acme/web/pulls") {
      const head = String(c.body.head);
      const pr = {
        number: pulls.length + 1,
        html_url: `https://github.com/acme/web/pull/${pulls.length + 1}`,
        head: { ref: head, sha: refs.get(head)! },
        base: String(c.body.base),
      };
      pulls.push(pr);
      return json(pr, 201);
    }
    return undefined;
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      auth: String(new Headers(init?.headers).get("authorization") ?? ""),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(c);
    if (state.hang === `${c.method} ${c.path}`)
      // A process that dies mid-call: this answer comes only when the test releases it.
      return new Promise<Response>((resolve) => {
        state.release = () => resolve(json({ message: "Bad Gateway" }, 502));
      });
    const out = state.outage;
    if (out && out.key === `${c.method} ${c.path}` && out.left > 0) {
      out.left--;
      if (out.status === 0) throw out.thrown; // no HTTP answer at all
      return Response.json({ message: "GitHub says no" }, { status: out.status, headers: out.headers });
    }
    return route(c) ?? notFound();
  });
  const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/repos/"));
  return { calls, mints, refs, pulls, state, writes };
}

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { BlockList, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors.ts";
import { BLOCKED, isBlocked, vetHost, type GuardOptions, type Resolve } from "../src/net-guard.ts";
import { decodeBody, fetchSession, hostLimiter, type Fetched } from "../src/research/fetch.ts";
import { MAX_PAGE_TEXT, readPage } from "../src/research/web/page.ts";
import {
  SEARCH_RUNBOOK,
  SearchError,
  braveClient,
  loadSearch,
  searchProviderStatus,
} from "../src/research/web/search.ts";

// FR-RES-12 / RES-G05: the research fetch path's SSRF guard, charset handling, readable-page extraction and the Brave
// client. No live network: a local TLS server reached through an injected resolver (127.0.0.1 stands in for a public
// address; the test block list refuses 10/8 and 169.254/16), and IP-literal URLs that the guard refuses before any connection.

const HOST = "news.example.test";
const INTERNAL = "intranet.example.test"; // resolves to 10.0.0.5 in these tests

let server: Server;
let port: number;
let ca: string;
let connections = 0;
const seen: { path: string; host?: string; servername: string | false | null; accept?: string }[] = [];

const ARTICLE = `<!doctype html><html><head><title>Acme SDK 2.0 | Acme News</title>
<script>document.write("tracking")</script><style>p { color: red }</style></head><body>
<nav><a href="/">Home</a> <a href="/about">About us</a> <a href="/jobs">Jobs</a></nav>
<main><article><h1>Acme SDK 2.0 released</h1>
<p>Acme today released version 2.0 of its SDK, adding streaming responses and a new retry policy for every client.
${"The release notes describe each change in detail, with migration steps for existing users. ".repeat(6)}</p>
<p>The   new major version   drops support for Node 18 and requires Node 22 or later.
${"Teams upgrading should read the migration guide before switching versions. ".repeat(6)}</p>
<ul><li>Streaming responses</li><li>Retry policy</li></ul></article></main>
<footer>Copyright Acme Corp. All rights reserved. Cookie settings.</footer></body></html>`;

function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-web-"));
  try {
    const [key, cert] = [join(dir, "k.pem"), join(dir, "c.pem")];
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
        .concat(["-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${HOST}`])
        .concat(["-addext", `subjectAltName=DNS:${HOST},DNS:${INTERNAL}`]),
      { stdio: "ignore" },
    );
    ca = readFileSync(cert, "utf8");
    server = createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
      res.on("error", () => undefined);
      res.setHeader("connection", "close"); // one connection per request: connection and lookup counts are exact
      seen.push({
        path: req.url ?? "",
        host: req.headers.host,
        servername: (req.socket as TLSSocket).servername,
        accept: req.headers.accept,
      });
      const send = (type: string, body: string | Buffer) =>
        res.writeHead(200, { "content-type": type }).end(body);
      switch (req.url) {
        case "/robots.txt":
          return send("text/plain", "User-agent: *\nAllow: /");
        case "/article":
          return send("text/html; charset=utf-8", ARTICLE);
        case "/latin1": // charset from the header
          return send("text/plain; charset=ISO-8859-1", Buffer.from("Caf\xe9 cr\xe8me", "latin1"));
        case "/meta": // no header charset: the <meta> one decides
          return send(
            "text/html",
            Buffer.from(
              `<html><head><meta charset="windows-1252"><title>Pr\x80ces</title></head><body><p>Prix: 5 \x80, na\xefve.</p></body></html>`,
              "latin1",
            ),
          );
        case "/feed":
          return send("application/rss+xml", "<rss version='2.0'><channel></channel></rss>");
        case "/pdf":
          return send("application/pdf", "%PDF-1.7");
        case "/to-metadata":
          return res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" }).end();
        case "/to-internal":
          return res.writeHead(302, { location: `https://${INTERNAL}:${port}/article` }).end();
        default:
          return res.writeHead(404).end();
      }
    });
    server.on("connection", () => connections++);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

const TEST_BLOCKED = new BlockList();
TEST_BLOCKED.addSubnet("10.0.0.0", 8, "ipv4");
TEST_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
const resolveTest: Resolve = async (host) =>
  host === INTERNAL ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
const local = (over: GuardOptions = {}): GuardOptions => ({
  resolve: resolveTest,
  blocked: TEST_BLOCKED,
  ca,
  ...over,
});
const session = (opts: GuardOptions = local()) =>
  fetchSession(hostLimiter(0), new AbortController().signal, opts);
const url = (path: string, host = HOST) => new URL(`https://${host}:${port}${path}`);

beforeAll(startServer);
afterAll(() => {
  server?.closeAllConnections();
  server?.close();
});

describe("net-guard", () => {
  it("vets every address: one blocked record refuses the host; literals need no lookup", async () => {
    const fixed =
      (...addresses: string[]): Resolve =>
      async () =>
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    expect(await vetHost("example.com", { resolve: fixed("93.184.215.14") })).toEqual({
      address: "93.184.215.14",
      family: 4,
    });
    expect(await vetHost("example.com", { resolve: fixed("93.184.215.14", "192.168.0.10") })).toBeNull();
    expect(await vetHost("example.com", { resolve: fixed() })).toBeNull();
    expect(await vetHost("[2606:4700::1111]")).toEqual({ address: "2606:4700::1111", family: 6 });
    expect(await vetHost("[::1]")).toBeNull();
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "100.64.0.1",
      "fd00:ec2::254",
      "::ffff:10.0.0.1",
    ])
      expect(isBlocked(a, BLOCKED), a).toBe(true);
    expect(isBlocked("not-an-ip")).toBe(true);
  });
});

describe("RES-G05: SSRF guard on every research fetch", () => {
  it("refuses private, loopback, link-local and metadata answers before connecting (production block list)", async () => {
    const before = connections;
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00:ec2::254",
    ]) {
      const s = session({ ca, resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
      expect(await s.get(url("/article")), address).toMatchObject({ ok: false, reason: "BLOCKED_HOST" });
    }
    // IP literals: no DNS, still refused (robots.txt is the first request, and it never leaves the process).
    for (const literal of [`127.0.0.1:${port}`, `[::1]:${port}`, "169.254.169.254", "[fd00:ec2::254]"])
      expect(
        await session({ ca }).get(new URL(`https://${literal}/latest/meta-data/`)),
        literal,
      ).toMatchObject({
        ok: false,
        reason: "BLOCKED_HOST",
      });
    expect(connections).toBe(before);
  });

  it("refuses a redirect to the metadata address or to a name that resolves privately, without connecting", async () => {
    seen.length = 0;
    const before = connections;
    const s = session();
    expect(await s.get(url("/to-metadata"))).toMatchObject({ ok: false, reason: "BLOCKED_HOST" });
    expect(await s.get(url("/to-internal"))).toMatchObject({ ok: false, reason: "BLOCKED_HOST" });
    // Only the public host was ever reached; the redirect targets got no request and no connection.
    expect(seen.map((r) => r.path)).toEqual(["/robots.txt", "/to-metadata", "/to-internal"]);
    expect(seen.every((r) => r.host === `${HOST}:${port}`)).toBe(true);
    expect(connections - before).toBe(seen.length); // a connection per request, all to the vetted public address
  });

  it("resolves once per connection and dials the vetted address; SNI and Host keep the name", async () => {
    // The test host doesn't exist in real DNS: a success proves the socket went to the vetted answer.
    let lookups = 0;
    const counting: Resolve = async (host) => (lookups++, resolveTest(host));
    seen.length = 0;
    const before = connections;
    expect(await session(local({ resolve: counting })).get(url("/article"))).toMatchObject({
      ok: true,
      contentType: "text/html",
    });
    expect(lookups).toBe(connections - before);
    expect(seen).toMatchObject([
      { path: "/robots.txt", host: `${HOST}:${port}`, servername: HOST },
      { path: "/article", host: `${HOST}:${port}`, servername: HOST },
    ]);
  });

  it("DNS rebinding: a later connection's private answer is refused, never dialled", async () => {
    let lookups = 0;
    const rebinding: Resolve = async () =>
      lookups++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }];
    seen.length = 0;
    expect(await session(local({ resolve: rebinding })).get(url("/article"))).toMatchObject({
      ok: false,
      reason: "BLOCKED_HOST",
    });
    expect(lookups).toBe(2); // robots.txt on the first (public) answer; the page's connection got the rebind
    expect(seen.map((r) => r.path)).toEqual(["/robots.txt"]);
  });
});

describe("charset (FR-RES-12 fix)", () => {
  it("decodes by BOM, Content-Type charset, <meta> or XML declaration, else UTF-8", () => {
    const latin1 = Buffer.from("na\xefve", "latin1");
    expect(decodeBody(latin1, "text/plain; charset=iso-8859-1")).toBe("naïve");
    expect(decodeBody(latin1, 'text/plain; charset="ISO-8859-1"')).toBe("naïve");
    expect(
      decodeBody(
        Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">\xe9', "latin1"),
        null,
      ),
    ).toMatch(/é$/);
    expect(
      decodeBody(
        Buffer.from("<?xml version='1.0' encoding='ISO-8859-1'?><rss>\xe9</rss>", "latin1"),
        "application/xml",
      ),
    ).toMatch(/é<\/rss>$/);
    expect(decodeBody(Buffer.from("﻿h\xe9", "utf16le"), "text/plain; charset=iso-8859-1")).toBe("hé"); // BOM wins
    expect(decodeBody(Buffer.from("héllo", "utf8"), "text/plain; charset=x-unknown")).toBe("héllo");
    expect(decodeBody(Buffer.from("héllo", "utf8"), null)).toBe("héllo");
  });

  it("returns the media type and decoded body through the guarded session", async () => {
    const s = session();
    expect(await s.get(url("/latin1"))).toMatchObject({
      ok: true,
      body: "Café crème",
      contentType: "text/plain",
    });
    const meta = await s.get(url("/meta"));
    expect(meta.ok && meta.body).toContain("Prix: 5 €, naïve.");
  });
});

describe("readPage (readable text)", () => {
  const fake =
    (body: string, contentType: string, at = "https://acme.dev/news/sdk-2"): Parameters<typeof readPage>[0] =>
    async (): Promise<Fetched> => ({ ok: true, body, url: new URL(at), contentType });

  it("extracts the article as text: no navigation, scripts, styles or footer; title and sha256 of the text", async () => {
    const r = await readPage(fake(ARTICLE, "text/html"), new URL("https://acme.dev/x"));
    if (!r.ok) throw new Error(r.detail);
    expect(r.finalUrl.href).toBe("https://acme.dev/news/sdk-2");
    expect(r.title).toBe("Acme SDK 2.0 | Acme News");
    expect(r.text).toContain("Acme today released version 2.0 of its SDK, adding streaming responses");
    expect(r.text).toContain("The new major version drops support for Node 18"); // whitespace collapsed
    expect(r.text).toMatch(/Streaming responses\n+Retry policy/); // block elements end lines
    for (const noise of ["About us", "tracking", "color: red", "Cookie settings"])
      expect(r.text).not.toContain(noise);
    expect(r.sha256).toBe(createHash("sha256").update(r.text).digest("hex"));
  });

  it("keeps text/plain, caps text at 200 000 chars, and refuses feeds, PDFs and empty pages", async () => {
    const plain = await readPage(
      fake("line one\r\n\r\n\r\n  line   two ", "text/plain"),
      new URL("https://a.dev/x"),
    );
    expect(plain).toMatchObject({ ok: true, text: "line one\n\nline two" });
    const big = await readPage(fake("word ".repeat(60_000), "text/plain"), new URL("https://a.dev/x"));
    expect(big.ok && big.text.length).toBe(MAX_PAGE_TEXT);
    for (const type of ["application/rss+xml", "application/pdf", "image/png", ""])
      expect(await readPage(fake("<rss/>", type), new URL("https://a.dev/x")), type).toMatchObject({
        ok: false,
        reason: "UNSUPPORTED_TYPE",
      });
    expect(
      await readPage(
        fake("<html><body><script>x</script></body></html>", "text/html"),
        new URL("https://a.dev/x"),
      ),
    ).toMatchObject({
      ok: false,
      reason: "UNSUPPORTED_TYPE",
    });
  });

  it("reads through the guarded session end to end, asking for HTML; a blocked redirect stays a skip", async () => {
    seen.length = 0;
    const s = session();
    const r = await readPage(s.get, url("/article"));
    expect(r).toMatchObject({ ok: true, title: "Acme SDK 2.0 | Acme News" });
    expect(seen.find((x) => x.path === "/article")?.accept).toMatch(/^text\/html/);
    expect(await readPage(s.get, url("/feed"))).toMatchObject({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(await readPage(s.get, url("/pdf"))).toMatchObject({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(await readPage(s.get, url("/to-metadata"))).toMatchObject({ ok: false, reason: "BLOCKED_HOST" });
  });
});

describe("Brave search client (FR-RES-03)", () => {
  afterEach(() => vi.restoreAllMocks());
  const apiKey = () => `BSA${randomBytes(16).toString("hex")}`;
  const signal = () => new AbortController().signal;
  function stub(respond: (u: URL) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = new URL(String(input));
      calls.push({ url: u, init: init ?? {} });
      return respond(u);
    });
    return calls;
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("maps web results: https only, plain-text snippets, page_age as a date; sends the key only as the header", async () => {
    const key = apiKey();
    const calls = stub(() =>
      json({
        type: "search",
        web: {
          results: [
            {
              title: "Acme <strong>SDK</strong> 2.0",
              url: "https://acme.dev/blog/sdk-2",
              description: "Streaming &amp; retries",
              page_age: "2026-10-27T08:00:00",
            },
            { title: "Plain http", url: "http://insecure.example/a", description: "dropped" },
            { title: "Creds", url: "https://u:p@acme.dev/a" },
            { title: "Bad", url: "not a url" },
            { url: "https://acme.dev/no-title" },
            { title: "No age", url: "https://news.example/b", page_age: "yesterday" },
          ],
        },
      }),
    );
    const results = await braveClient(key).search("  acme   sdk  ", { count: 50, signal: signal() });
    expect(results).toEqual([
      {
        title: "Acme SDK 2.0",
        url: new URL("https://acme.dev/blog/sdk-2"),
        snippet: "Streaming & retries",
        publishedAt: new Date("2026-10-27T08:00:00Z"),
      },
      { title: "No age", url: new URL("https://news.example/b"), snippet: "", publishedAt: null },
    ]);
    expect(calls).toHaveLength(1);
    const { url: u, init } = calls[0]!;
    expect(`${u.origin}${u.pathname}`).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: "acme sdk",
      count: "20",
      text_decorations: "false",
    });
    expect(u.href).not.toContain(key);
    expect(new Headers(init.headers).get("x-subscription-token")).toBe(key);
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
  });

  it("401/403 and an invalid-token 422 are AUTH, 429 is RATE_LIMITED, anything else UNAVAILABLE; never the key", async () => {
    const key = apiKey();
    const cases: [Response | (() => never), SearchError["kind"]][] = [
      [json({ error: { code: "UNAUTHORIZED" } }, 401), "AUTH"],
      [json({}, 403), "AUTH"],
      [json({ error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: key } }, 422), "AUTH"],
      [json({ error: { code: "RATE_LIMITED" } }, 429), "RATE_LIMITED"],
      [json({ error: { code: "VALIDATION" } }, 422), "UNAVAILABLE"],
      [json({}, 500), "UNAVAILABLE"],
      [new Response("<html>", { status: 200 }), "UNAVAILABLE"],
      [new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }), "UNAVAILABLE"],
      [
        () => {
          throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${key}`) });
        },
        "UNAVAILABLE",
      ],
    ];
    for (const [respond, kind] of cases) {
      stub(() => (typeof respond === "function" ? respond() : respond));
      // A fresh client per case: each has its own 1 req/s limiter, so the cases don't queue behind each other.
      const client = braveClient(key);
      const err = await client.search("acme", { count: 5, signal: signal() }).catch((e: unknown) => e);
      expect(err, kind).toBeInstanceOf(SearchError);
      expect((err as SearchError).kind).toBe(kind);
      expect((err as SearchError).message).not.toContain(key);
      vi.restoreAllMocks();
    }
  });

  it("spaces requests to 1 per second per client and skips empty queries", async () => {
    stub(() => json({ web: { results: [] } }));
    const client = braveClient(apiKey());
    expect(await client.search("   ", { count: 5, signal: signal() })).toEqual([]);
    const t0 = performance.now();
    await client.search("a", { count: 5, signal: signal() });
    await client.search("b", { count: 5, signal: signal() });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(950);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe("loadSearch (~/.nexus/search.json)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nexus-search-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content: string, mode = 0o600) => {
    const file = join(dir, name);
    writeFileSync(file, content);
    chmodSync(file, mode);
    return file;
  };
  const reasonOf = async (file: string) => {
    const err = await loadSearch(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ file, runbook: SEARCH_RUNBOOK });
    return { reason: (e.details as { reason: string }).reason, message: e.message };
  };

  it("409 with the file and runbook when missing, loose, not JSON or not a Brave config; never echoes the key", async () => {
    const key = randomBytes(16).toString("hex");
    expect((await reasonOf(join(dir, "missing.json"))).reason).toBe("search_provider_not_configured");
    const loose = await reasonOf(
      write("loose.json", JSON.stringify({ provider: "brave", apiKey: key }), 0o644),
    );
    expect(loose).toMatchObject({ reason: "search_provider_config_invalid" });
    expect(loose.message).toContain("chmod 600");
    expect((await reasonOf(write("bad.json", `{"apiKey": "${key}"`))).message).not.toContain(key);
    const other = await reasonOf(write("other.json", JSON.stringify({ provider: "google", apiKey: key })));
    expect(other.message).not.toContain(key);
    expect((await reasonOf(dir)).message).toContain("not a regular file");
    expect(await searchProviderStatus(join(dir, "missing.json"))).toMatchObject({
      configured: false,
      runbook: SEARCH_RUNBOOK,
    });
  });

  it("a valid 0600 file gives a Brave client; the status never returns the key", async () => {
    const key = randomBytes(16).toString("hex");
    const file = write("search.json", JSON.stringify({ provider: "brave", apiKey: key }));
    expect((await loadSearch(file)).provider).toBe("brave");
    const status = await searchProviderStatus(file);
    expect(status).toEqual({ configured: true, provider: "brave" });
    expect(JSON.stringify(status)).not.toContain(key);
  });
});

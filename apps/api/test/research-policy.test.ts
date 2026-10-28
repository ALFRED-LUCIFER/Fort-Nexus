import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING_WEIGHTS, type BriefSchedule } from "@nexus/contracts";
import { USER_AGENT, fetchSession, hostLimiter, parseRobots } from "../src/research/fetch.ts";
import { MAX_EXCERPT, parseFeed, plainText } from "../src/research/feed.ts";
import {
  canonicalUrl,
  publisherOf,
  score,
  scoreBreakdown,
  similar,
  titleTokens,
  verificationLabel,
} from "../src/research/findings.ts";
import { dueWindow, localDate, nextRunAt, nextSlot } from "../src/research/schedule.ts";

const daily = (localTime: string, timezone: string, days = [0, 1, 2, 3, 4, 5, 6]): BriefSchedule => ({
  localTime,
  timezone,
  days,
  paused: false,
});
const at = (s: string) => new Date(s);

describe("schedule (FR-RES-02)", () => {
  it("RES-G01: 08:00 Asia/Dubai is 04:00 UTC, once per local date", () => {
    const s = daily("08:00", "Asia/Dubai");
    expect(nextSlot(s, at("2026-10-28T03:59:00Z")).toISOString()).toBe("2026-10-28T04:00:00.000Z");
    expect(nextSlot(s, at("2026-10-28T04:00:00Z")).toISOString()).toBe("2026-10-29T04:00:00.000Z");
    expect(localDate(at("2026-10-27T21:00:00Z"), "Asia/Dubai")).toBe("2026-10-28");
  });

  it("keeps the local time across DST changes (Europe/Berlin)", () => {
    const s = daily("08:00", "Europe/Berlin");
    // Spring forward on 2026-03-29: 08:00 CET (07:00Z) the day before, 08:00 CEST (06:00Z) after.
    expect(nextSlot(s, at("2026-03-28T06:00:00Z")).toISOString()).toBe("2026-03-28T07:00:00.000Z");
    expect(nextSlot(s, at("2026-03-28T07:00:00Z")).toISOString()).toBe("2026-03-29T06:00:00.000Z");
    // Fall back on 2026-10-25: 08:00 CET is 07:00Z.
    expect(nextSlot(s, at("2026-10-24T12:00:00Z")).toISOString()).toBe("2026-10-25T07:00:00.000Z");
    // 02:30 doesn't exist on 2026-03-29; it runs right after the gap (03:30 CEST).
    expect(nextSlot(daily("02:30", "Europe/Berlin"), at("2026-03-28T12:00:00Z")).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("weekly schedules pick the next listed weekday", () => {
    // Mondays 09:00 New York; DST ends Sunday 2026-11-01, so Monday 09:00 EST = 14:00Z.
    const s = daily("09:00", "America/New_York", [1]);
    expect(nextSlot(s, at("2026-10-27T00:00:00Z")).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("paused schedules have no next run", () => {
    expect(nextRunAt({ ...daily("08:00", "UTC"), paused: true }, new Date())).toBeNull();
  });

  it("a long outage runs one brief for the current window, not every missed one", () => {
    const s = daily("08:00", "Asia/Dubai");
    const w = dueWindow(s, at("2026-10-25T04:00:00Z"), at("2026-10-28T05:00:00Z"));
    expect(w).toEqual({ windowDate: "2026-10-28", next: at("2026-10-29T04:00:00Z") });
  });
});

describe("canonical URLs and dedupe (RES-G02)", () => {
  it("drops tracking params, fragment, trailing slash; sorts the query; lower-cases the host", () => {
    const c = canonicalUrl(
      new URL("https://WWW.Example.com/a/b/?utm_source=x&b=2&a=1&fbclid=z&gclid=q&ref=hn#frag"),
    );
    expect(c).toBe("https://www.example.com/a/b?a=1&b=2");
    expect(publisherOf(c)).toBe("example.com");
    expect(canonicalUrl(new URL("https://example.com/?ref=x"))).toBe("https://example.com/");
  });

  it("clusters near-identical titles, not merely related ones", () => {
    const a = titleTokens("Acme SDK 2.0 released with streaming support");
    expect(similar(a, titleTokens("Acme SDK 2.0 released, adds streaming support"))).toBe(true);
    expect(similar(a, titleTokens("Acme SDK 1.9 deprecates the legacy client"))).toBe(false);
    expect(similar(titleTokens("Acme"), titleTokens("Acme"))).toBe(false); // too short to judge
  });
});

describe("verification label and score (RES-G03, FR-RES-07)", () => {
  it("RES-G03: one non-primary publisher is UNVERIFIED; two are CORROBORATED; any PRIMARY wins", () => {
    expect(verificationLabel([{ tier: "SECONDARY", publisher: "news.example" }])).toBe("UNVERIFIED");
    expect(
      verificationLabel([
        { tier: "COMMUNITY", publisher: "forum.example" },
        { tier: "COMMUNITY", publisher: "forum.example" },
      ]),
    ).toBe("UNVERIFIED");
    expect(
      verificationLabel([
        { tier: "SECONDARY", publisher: "news.example" },
        { tier: "COMMUNITY", publisher: "forum.example" },
      ]),
    ).toBe("CORROBORATED");
    expect(
      verificationLabel([
        { tier: "SECONDARY", publisher: "news.example" },
        { tier: "PRIMARY", publisher: "acme.dev" },
      ]),
    ).toBe("PRIMARY");
  });

  it("scores criteria in [0,1] and weights them into 0..100", () => {
    const b = scoreBreakdown({
      title: "Acme SDK 2.0 release: breaking changes",
      excerpt: "Security fixes and a migration guide.",
      publishedAt: at("2026-10-21T00:00:00Z"),
      firstSeenAt: at("2026-10-28T00:00:00Z"),
      tiers: ["SECONDARY", "PRIMARY"],
      keywords: ["acme", "sdk", "pricing", "agents"],
    });
    expect(b).toEqual({ credibility: 1, relevance: 0.5, novelty: 0.5, impact: 1, opportunity: 0 });
    expect(score(b, DEFAULT_SCORING_WEIGHTS)).toBe(Math.round(25 + 12.5 + 10 + 15));
    expect(score(b, { credibility: 0, relevance: 0, novelty: 0, impact: 0, opportunity: 1 })).toBe(0);
  });
});

describe("feeds", () => {
  const base = new URL("https://acme.dev/feed.xml");

  it("parses RSS 2.0 into plain-text items with safe absolute links", () => {
    const items = parseFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Acme</title>
        <item><title>SDK &amp; CLI 2.0</title><link>/blog/sdk-2</link>
          <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; more&lt;/p&gt;</description>
          <pubDate>Tue, 27 Oct 2026 08:00:00 GMT</pubDate></item>
        <item><title>Evil</title><link>javascript:alert(1)</link></item>
        <item><title><![CDATA[CDATA <i>title</i>]]></title><guid>https://acme.dev/p/3</guid></item>
      </channel></rss>`,
      base,
    );
    expect(items).toEqual([
      {
        title: "SDK & CLI 2.0",
        link: new URL("https://acme.dev/blog/sdk-2"),
        excerpt: "Hello world & more",
        publishedAt: at("2026-10-27T08:00:00Z"),
      },
      { title: "CDATA title", link: new URL("https://acme.dev/p/3"), excerpt: "", publishedAt: null },
    ]);
  });

  it("parses Atom (GitHub releases) and caps the excerpt", () => {
    const items = parseFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
        <entry><title type="html">v2.0.0</title>
          <link rel="self" href="https://example.com/self"/>
          <link rel="alternate" type="text/html" href="https://github.com/acme/sdk/releases/tag/v2.0.0"/>
          <updated>2026-10-27T08:00:00Z</updated>
          <content type="html">${"x ".repeat(2000)}</content></entry>
      </feed>`,
      base,
    );
    expect(items).toHaveLength(1);
    expect(items![0]!.link.href).toBe("https://github.com/acme/sdk/releases/tag/v2.0.0");
    expect(items![0]!.publishedAt).toEqual(at("2026-10-27T08:00:00Z"));
    expect(items![0]!.excerpt.length).toBe(MAX_EXCERPT);
  });

  it("rejects bodies that aren't RSS or Atom", () => {
    expect(parseFeed("<html><body>hi</body></html>", base)).toBeNull();
    expect(parseFeed("<rss><channel><item>", base)).toBeNull();
    expect(parseFeed("not xml at all", base)).toBeNull();
  });

  it("strips markup to plain text", () => {
    expect(plainText("<style>p{}</style><p>a&nbsp;&#x41;&#66;</p>", 100)).toBe("a AB");
  });
});

describe("robots.txt", () => {
  it("uses our own group when one names us, else *; longest match wins, allow wins ties", () => {
    const allows = parseRobots(
      [
        "User-agent: *",
        "Disallow: /private",
        "",
        "User-agent: NEXUS-Research",
        "User-agent: other-bot",
        "Disallow: /blocked*.xml$ # comment",
      ].join("\n"),
    );
    expect(allows("/blocked-a.xml")).toBe(false);
    expect(allows("/blocked-a.xml?x=1")).toBe(true);
    expect(allows("/private/x")).toBe(true); // our group replaces *

    const star = parseRobots(
      "User-agent: *\r\nDisallow: /private\r\nAllow: /private/feed.xml\r\nAllow: /a\r\nDisallow: /a",
    );
    expect(star("/private/x")).toBe(false);
    expect(star("/private/feed.xml")).toBe(true);
    expect(star("/a")).toBe(true);
    expect(star("/public")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow:")("/anything")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow: /")("/feed.xml")).toBe(false);
  });

  it("matches hostile wildcard patterns in linear time", () => {
    const allows = parseRobots(`User-agent: *\nDisallow: ${"*a".repeat(500)}b`);
    const started = performance.now();
    expect(allows(`/${"a".repeat(2000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("fetch policy (FR-RES-12, RES-G04)", () => {
  type Call = { url: string; init: RequestInit };
  afterEach(() => vi.restoreAllMocks());

  function stub(routes: Record<string, () => Response | Promise<Response>>) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch in test: ${url}`);
      return route();
    });
    return calls;
  }
  const session = () => fetchSession(hostLimiter(0), new AbortController().signal);
  const ok = (body = "<rss/>", init?: ResponseInit) => new Response(body, init);

  it("RES-G04: a robots.txt-disallowed source is skipped without being requested", async () => {
    const calls = stub({ "https://blocked.example/robots.txt": () => ok("User-agent: *\nDisallow: /feed") });
    const s = session();
    expect(await s.get(new URL("https://blocked.example/feed.xml"))).toEqual({
      ok: false,
      reason: "ROBOTS_DISALLOWED",
      detail: "robots.txt on blocked.example disallows /feed.xml",
    });
    expect(await s.get(new URL("https://blocked.example/feed2.xml"))).toMatchObject({ ok: false });
    expect(calls.map((c) => c.url)).toEqual(["https://blocked.example/robots.txt"]); // read once per run
  });

  it("RES-G04: 401/403 is AUTH_REQUIRED, asked once, never with credentials or cookies", async () => {
    const calls = stub({
      "https://private.example/robots.txt": () => new Response("", { status: 404 }), // 4xx: no rules
      "https://private.example/feed.xml": () => new Response("", { status: 401 }),
      "https://private.example/other.xml": () => new Response("", { status: 403 }),
    });
    const s = session();
    expect(await s.get(new URL("https://private.example/feed.xml"))).toMatchObject({
      ok: false,
      reason: "AUTH_REQUIRED",
    });
    expect(await s.get(new URL("https://private.example/other.xml"))).toMatchObject({
      reason: "AUTH_REQUIRED",
    });
    expect(calls.filter((c) => c.url.endsWith("/feed.xml"))).toHaveLength(1);
    for (const c of calls) {
      const headers = new Headers(c.init.headers);
      expect(headers.get("user-agent")).toBe(USER_AGENT);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(c.init.credentials).toBe("omit");
      expect(c.init.redirect).toBe("manual");
    }
  });

  it("follows https redirects (checking the new host's robots.txt) and refuses http ones", async () => {
    const calls = stub({
      "https://a.example/robots.txt": () => ok(""),
      "https://a.example/feed": () =>
        new Response(null, { status: 301, headers: { location: "https://b.example/feed" } }),
      "https://a.example/plain": () =>
        new Response(null, { status: 302, headers: { location: "http://a.example/plain" } }),
      "https://b.example/robots.txt": () => ok("User-agent: *\nAllow: /"),
      "https://b.example/feed": () => ok("<feed/>"),
    });
    const s = session();
    const r = await s.get(new URL("https://a.example/feed"));
    expect(r).toMatchObject({ ok: true, body: "<feed/>" });
    expect(r.ok && r.url.href).toBe("https://b.example/feed");
    expect(await s.get(new URL("https://a.example/plain"))).toMatchObject({
      ok: false,
      reason: "HTTP_ERROR",
      detail: "Refused a non-https URL (http:)",
    });
    expect(calls.some((c) => c.url.startsWith("http:"))).toBe(false);
    expect(await s.get(new URL("http://a.example/feed"))).toMatchObject({ reason: "HTTP_ERROR" });
  });

  it("caps bodies at 2 MB, declared or streamed", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    stub({
      "https://big.example/robots.txt": () => ok(""),
      "https://big.example/declared": () => ok("x", { headers: { "content-length": String(3e6) } }),
      "https://big.example/streamed": () => ok(big),
    });
    const s = session();
    expect(await s.get(new URL("https://big.example/declared"))).toMatchObject({ reason: "TOO_LARGE" });
    expect(await s.get(new URL("https://big.example/streamed"))).toMatchObject({ reason: "TOO_LARGE" });
  });

  it("maps timeouts, rate limits and server errors; an unreachable robots.txt blocks the host", async () => {
    stub({
      "https://slow.example/robots.txt": () => ok(""),
      "https://slow.example/feed": () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      "https://slow.example/busy": () => new Response("", { status: 429 }),
      "https://slow.example/broken": () => new Response("", { status: 500 }),
      "https://down.example/robots.txt": () => new Response("", { status: 503 }),
    });
    const s = session();
    expect(await s.get(new URL("https://slow.example/feed"))).toMatchObject({ reason: "TIMEOUT" });
    expect(await s.get(new URL("https://slow.example/busy"))).toMatchObject({ reason: "RATE_LIMITED" });
    expect(await s.get(new URL("https://slow.example/broken"))).toMatchObject({
      reason: "HTTP_ERROR",
      detail: "HTTP 500",
    });
    expect(await s.get(new URL("https://down.example/feed"))).toMatchObject({
      reason: "ROBOTS_DISALLOWED",
      detail: "robots.txt on down.example is unreachable (HTTP 503)",
    });
  });

  it("spaces requests to one host by the interval; other hosts don't wait", async () => {
    const wait = hostLimiter(150);
    const signal = new AbortController().signal;
    const t0 = performance.now();
    await wait("a.example", signal);
    await wait("b.example", signal);
    expect(performance.now() - t0).toBeLessThan(100);
    await wait("a.example", signal);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

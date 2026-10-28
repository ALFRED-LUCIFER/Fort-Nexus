import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type {
  CreateWatchlistRequest,
  FindingList,
  ResearchBrief,
  ResearchRun,
  Watchlist,
  WatchlistList,
} from "@nexus/contracts";
import { createDb } from "../src/db/index.ts";
import { auditRecords } from "../src/db/schema.ts";
import { P1_SCOPE } from "../src/scope.ts";
import { researchRuns, researchWatchlists } from "../src/research/schema.ts";
import { createResearch } from "../src/research/service.ts";
import { localDate, nextSlot } from "../src/research/schedule.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// Every source is stubbed at fetch level; anything else the pipeline asks for fails the test.
let t: TestApp;
let cookie: string;
let db: ReturnType<typeof createDb>;
let site: Record<string, () => Response> = {};
let fetches: { url: string; init: RequestInit }[] = [];
let unexpected: string[] = [];

const rss = (items: { title: string; link: string; description?: string }[]) =>
  new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title>${items
      .map(
        (i) =>
          `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description ?? ""}</description></item>`,
      )
      .join("")}</channel></rss>`,
    { headers: { "content-type": "application/rss+xml" } },
  );
const allowAll = () => new Response("User-agent: *\nAllow: /\n");

const schedule = { localTime: "08:00", timezone: "Asia/Dubai", days: [0, 1, 2, 3, 4, 5, 6], paused: false };
const feed = (url: string, tier: "PRIMARY" | "SECONDARY" | "COMMUNITY") => ({
  kind: "FEED" as const,
  url,
  tier,
});

const send = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: method as "GET",
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function createWatchlist(body: Partial<z.input<typeof CreateWatchlistRequest>>) {
  const res = await send("POST", "/v1/research/watchlists", { name: "AI SDKs", schedule, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Watchlist>();
}

let keyN = 0;
async function runNow(watchlistId: string, key = `key-${++keyN}-${Date.now()}`) {
  const res = await send("POST", `/v1/research/watchlists/${watchlistId}/run`, undefined, {
    "idempotency-key": key,
  });
  expect(res.statusCode, res.body).toBe(202);
  return res.json<ResearchRun>();
}

async function finished(runId: string): Promise<ResearchBrief> {
  for (let i = 0; i < 150; i++) {
    const brief = (await send("GET", `/v1/research/runs/${runId}`)).json<ResearchBrief>();
    if (brief.run.status !== "RUNNING") return brief;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

beforeAll(async () => {
  t = await createTestApp();
  cookie = await ownerSession(t);
  db = createDb(t.databaseUrl);
});
afterAll(async () => {
  await t.app.close();
  await db.pool.end();
});
beforeEach(() => {
  site = {};
  fetches = [];
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    const route = site[url];
    if (!route) {
      unexpected.push(url);
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    return route();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

describe("watchlists", () => {
  it("creates, lists, pauses, reweights and archives a watchlist, auditing each change", async () => {
    const before = Date.now();
    const w = await createWatchlist({
      keywords: ["sdk"],
      sources: [feed("https://acme.dev/feed.xml", "PRIMARY"), { kind: "GITHUB_RELEASES", repo: "acme/sdk" }],
    });
    expect(w.sources[1]).toEqual({ kind: "GITHUB_RELEASES", repo: "acme/sdk", tier: "PRIMARY" });
    expect(w.weights).toEqual({ credibility: 25, relevance: 25, novelty: 20, impact: 15, opportunity: 15 });
    expect(w.nextRunAt).toBe(nextSlot(schedule, new Date(before)).toISOString());
    expect(w.lastRunAt).toBeNull();

    const list = (await send("GET", "/v1/research/watchlists")).json<WatchlistList>();
    expect(list.items.map((i) => i.id)).toContain(w.id);

    const paused = await send("PATCH", `/v1/research/watchlists/${w.id}`, {
      schedule: { ...schedule, paused: true },
    });
    expect(paused.json<Watchlist>().nextRunAt).toBeNull();
    const resumed = await send("PATCH", `/v1/research/watchlists/${w.id}`, { schedule });
    expect(resumed.json<Watchlist>().nextRunAt).not.toBeNull();
    const weights = { credibility: 0, relevance: 100, novelty: 0, impact: 0, opportunity: 0 };
    const reweighted = await send("PATCH", `/v1/research/watchlists/${w.id}`, { weights });
    expect(reweighted.json<Watchlist>().weights).toEqual(weights);

    const archived = await send("DELETE", `/v1/research/watchlists/${w.id}`);
    expect(archived.statusCode).toBe(204);
    const after = (await send("GET", "/v1/research/watchlists")).json<WatchlistList>();
    expect(after.items.map((i) => i.id)).not.toContain(w.id);
    expect((await send("PATCH", `/v1/research/watchlists/${w.id}`, { name: "x" })).statusCode).toBe(404);
    expect((await send("DELETE", `/v1/research/watchlists/${w.id}`)).statusCode).toBe(404);

    const audits = await db.db.select().from(auditRecords).where(eq(auditRecords.resourceId, w.id));
    expect(audits.map((a) => a.action)).toEqual([
      "research.watchlist.create",
      "research.watchlist.update",
      "research.watchlist.update",
      "research.watchlist.update",
      "research.watchlist.archive",
    ]);
    for (const a of audits) {
      expect(a.actor).toMatch(/^user:/);
      expect(a.metadata).toMatchObject(P1_SCOPE);
    }
    expect(audits[0]!.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("validates input and guards the owner session and Origin", async () => {
    const bad = await send("POST", "/v1/research/watchlists", {
      name: "x",
      schedule,
      sources: [{ kind: "FEED", url: "http://insecure.example/feed", tier: "PRIMARY" }],
    });
    expect(bad.statusCode).toBe(400);
    const badTz = await send("POST", "/v1/research/watchlists", {
      name: "x",
      schedule: { ...schedule, timezone: "Mars/Olympus" },
      sources: [feed("https://acme.dev/feed.xml", "PRIMARY")],
    });
    expect(badTz.statusCode).toBe(400);

    const anon = await t.app.inject({ method: "GET", url: "/v1/research/watchlists" });
    expect(anon.statusCode).toBe(401);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/v1/research/watchlists",
      headers: { cookie },
      payload: { name: "x", schedule, sources: [feed("https://acme.dev/feed.xml", "PRIMARY")] },
    });
    expect(noOrigin.statusCode).toBe(403);
    const noKey = await send("POST", `/v1/research/watchlists/${crypto.randomUUID()}/run`);
    expect(noKey.statusCode).toBe(400);
    const missing = await send("POST", `/v1/research/watchlists/${crypto.randomUUID()}/run`, undefined, {
      "idempotency-key": "k-missing",
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("runs", () => {
  it("manual run: Idempotency-Key replays return the same run; it completes in the background", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/feed.xml"] = () =>
      rss([{ title: "Acme ships the agent toolkit beta", link: "https://acme.dev/blog/toolkit" }]);
    const w = await createWatchlist({ sources: [feed("https://acme.dev/feed.xml", "PRIMARY")] });

    const run = await runNow(w.id, "same-key");
    expect(run).toMatchObject({ watchlistId: w.id, trigger: "MANUAL", windowDate: null, status: "RUNNING" });
    expect((await runNow(w.id, "same-key")).id).toBe(run.id);

    const brief = await finished(run.id);
    expect(brief.run).toMatchObject({ status: "COMPLETED", newFindings: 1, skippedSources: [] });
    expect((await runNow(w.id, "same-key")).status).toBe("COMPLETED"); // replay after the fact: same run
    expect(fetches.filter((f) => f.url === "https://acme.dev/feed.xml")).toHaveLength(1);

    const runs = await send("GET", `/v1/research/runs?watchlistId=${w.id}`);
    expect(runs.json<{ items: ResearchRun[] }>().items.map((r) => r.id)).toEqual([run.id]);
    const listed = (await send("GET", "/v1/research/watchlists")).json<WatchlistList>();
    expect(listed.items.find((i) => i.id === w.id)!.lastRunAt).toBe(run.startedAt);
  });

  it("RES-G01: the scheduled 08:00 Asia/Dubai brief is created once per window, even when ticks race or retry", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/feed.xml"] = () => rss([]);
    const w = await createWatchlist({ sources: [feed("https://acme.dev/feed.xml", "PRIMARY")] });
    const shutdown = new AbortController();
    const a = createResearch(db.db, t.app.log, shutdown.signal);
    const b = createResearch(db.db, t.app.log, shutdown.signal);
    // Today's brief hasn't been produced and the scheduler has reached the configured time.
    const now = new Date();
    const slot = nextSlot(schedule, new Date(now.getTime() - 86_400_000));
    const due = () =>
      db.db.update(researchWatchlists).set({ nextRunAt: slot }).where(eq(researchWatchlists.id, w.id));
    await due();

    await Promise.all([a.tick(now), b.tick(now), a.tick(now)]);
    await due(); // the trigger is retried for the same window
    await b.tick(now);

    const runs = await db.db.select().from(researchRuns).where(eq(researchRuns.watchlistId, w.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "SCHEDULED", windowDate: localDate(slot, "Asia/Dubai") });
    const [after] = await db.db.select().from(researchWatchlists).where(eq(researchWatchlists.id, w.id));
    expect(after!.nextRunAt).toEqual(nextSlot(schedule, now));

    expect((await finished(runs[0]!.id)).run.status).toBe("COMPLETED");
    await Promise.all([a.close(), b.close()]);
    const starts = await db.db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.action, "research.run.start"), eq(auditRecords.resourceId, runs[0]!.id)));
    expect(starts).toHaveLength(1);
    expect(starts[0]!.actor).toBe("system:research-scheduler");
  });

  it("a run left RUNNING by a restart is marked FAILED with the reason and never redone", async () => {
    const w = await createWatchlist({ sources: [feed("https://acme.dev/feed.xml", "PRIMARY")] });
    const [stale] = await db.db
      .insert(researchRuns)
      .values({
        ...P1_SCOPE,
        watchlistId: w.id,
        trigger: "SCHEDULED",
        windowDate: "2026-01-01",
        status: "RUNNING",
        startedAt: new Date(Date.now() - 600_000),
      })
      .returning();
    const restarted = createResearch(db.db, t.app.log, new AbortController().signal);
    await restarted.tick();
    const [row] = await db.db.select().from(researchRuns).where(eq(researchRuns.id, stale!.id));
    expect(row).toMatchObject({
      status: "FAILED",
      error: "The API restarted during this run; it was not retried.",
    });
    expect(row!.finishedAt).not.toBeNull();
    const fails = await db.db.select().from(auditRecords).where(eq(auditRecords.resourceId, stale!.id));
    expect(fails.map((f) => [f.action, f.outcome])).toEqual([["research.run.fail", "FAILED"]]);
    expect(fetches).toEqual([]);
  });

  it("a run settled while it was still fetching keeps its outcome and stores nothing", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/late.xml"] = () => rss([{ title: "Late item", link: "https://acme.dev/late" }]);
    const w = await createWatchlist({ sources: [feed("https://acme.dev/late.xml", "PRIMARY")] });
    const run = await runNow(w.id);
    // The feed fetch waits ≥ 1 s behind robots.txt (per-host spacing), so this lands mid-run.
    await db.db
      .update(researchRuns)
      .set({ status: "FAILED", error: "settled elsewhere" })
      .where(eq(researchRuns.id, run.id));
    for (let i = 0; i < 50 && !fetches.some((f) => f.url.endsWith("/late.xml")); i++)
      await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const brief = (await send("GET", `/v1/research/runs/${run.id}`)).json<ResearchBrief>();
    expect(brief.run.status).toBe("FAILED");
    expect(brief.findings).toEqual([]);
  });
});

describe("pipeline", () => {
  it("RES-G02: the same release from two sites collapses to one finding that keeps every source", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/releases.xml"] = () =>
      rss([
        {
          title: "Acme SDK 2.0 released with streaming support",
          link: "https://acme.dev/blog/sdk-2?utm_source=rss&amp;utm_medium=feed",
          description: "&lt;p&gt;Official announcement.&lt;/p&gt;",
        },
      ]);
    site["https://news.example/robots.txt"] = () => new Response("", { status: 404 });
    site["https://news.example/feed.xml"] = () =>
      rss([
        { title: "Acme SDK 2.0 released, adds streaming support", link: "https://news.example/acme-sdk-2" },
        // Syndicated copy of the original announcement: same canonical URL.
        { title: "Acme SDK 2.0 is out", link: "https://ACME.dev/blog/sdk-2/#comments" },
      ]);
    const w = await createWatchlist({
      keywords: ["sdk", "streaming"],
      sources: [
        feed("https://acme.dev/releases.xml", "PRIMARY"),
        feed("https://news.example/feed.xml", "SECONDARY"),
      ],
    });

    const brief = await finished((await runNow(w.id)).id);
    expect(brief.run).toMatchObject({ status: "COMPLETED", newFindings: 1 });
    expect(brief.findings).toHaveLength(1);
    const f = brief.findings[0]!;
    expect(f).toMatchObject({
      title: "Acme SDK 2.0 released with streaming support",
      excerpt: "Official announcement.",
      canonicalUrl: "https://acme.dev/blog/sdk-2",
      label: "PRIMARY",
    });
    expect(f.sources.map((s) => [s.url, s.publisher, s.tier])).toEqual([
      ["https://acme.dev/blog/sdk-2", "acme.dev", "PRIMARY"],
      ["https://news.example/acme-sdk-2", "news.example", "SECONDARY"],
    ]);
    expect(f.score).toBeGreaterThan(0);

    // Running again is a no-op: nothing new, no duplicate sources.
    const again = await finished((await runNow(w.id)).id);
    expect(again.run.newFindings).toBe(0);
    const all = (await send("GET", `/v1/research/findings?watchlistId=${w.id}`)).json<FindingList>();
    expect(all.items).toHaveLength(1);
    expect(all.items[0]!.sources).toHaveLength(2);
  });

  it("RES-G03: a market statistic from one non-primary site is UNVERIFIED until another publisher reports it", async () => {
    const claim = "AI agent market will reach 1 trillion dollars by 2027";
    site["https://blog.example/robots.txt"] = allowAll;
    site["https://blog.example/feed.xml"] = () =>
      rss([{ title: claim, link: "https://blog.example/market" }]);
    site["https://forum.example/robots.txt"] = allowAll;
    site["https://forum.example/feed.xml"] = () =>
      rss([
        {
          title: "AI agent market will reach 1 trillion dollars by 2027?",
          link: "https://forum.example/t/9",
        },
      ]);
    const w = await createWatchlist({ sources: [feed("https://blog.example/feed.xml", "SECONDARY")] });

    const first = await finished((await runNow(w.id)).id);
    expect(first.findings.map((f) => [f.title, f.label])).toEqual([[claim, "UNVERIFIED"]]);

    await send("PATCH", `/v1/research/watchlists/${w.id}`, {
      sources: [
        feed("https://blog.example/feed.xml", "SECONDARY"),
        feed("https://forum.example/feed.xml", "COMMUNITY"),
      ],
    });
    await finished((await runNow(w.id)).id);
    const [f] = (await send("GET", `/v1/research/findings?watchlistId=${w.id}`)).json<FindingList>().items;
    expect(f).toMatchObject({ label: "CORROBORATED", firstRunId: first.run.id });
    expect(f!.sources.map((s) => s.publisher)).toEqual(["blog.example", "forum.example"]);
  });

  it("RES-G04: disallowed and login-walled sources are skipped with their reason; no bypass is attempted", async () => {
    site["https://blocked.example/robots.txt"] = () =>
      new Response("User-agent: NEXUS-Research\nDisallow: /feed.xml\n");
    site["https://private.example/robots.txt"] = allowAll;
    site["https://private.example/feed.xml"] = () => new Response("Sign in", { status: 401 });
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/ok.xml"] = () =>
      rss([{ title: "Acme status page moved", link: "https://acme.dev/status" }]);
    const w = await createWatchlist({
      sources: [
        feed("https://blocked.example/feed.xml", "SECONDARY"),
        feed("https://private.example/feed.xml", "SECONDARY"),
        feed("https://acme.dev/ok.xml", "PRIMARY"),
      ],
    });

    const brief = await finished((await runNow(w.id)).id);
    expect(brief.run.status).toBe("PARTIAL");
    expect(brief.run.skippedSources).toEqual([
      {
        source: "https://blocked.example/feed.xml",
        reason: "ROBOTS_DISALLOWED",
        detail: "robots.txt on blocked.example disallows /feed.xml",
      },
      {
        source: "https://private.example/feed.xml",
        reason: "AUTH_REQUIRED",
        detail: "HTTP 401: the source requires access NEXUS doesn't have",
      },
    ]);
    expect(brief.findings).toHaveLength(1);
    expect(fetches.some((f) => f.url === "https://blocked.example/feed.xml")).toBe(false);
    expect(fetches.filter((f) => f.url === "https://private.example/feed.xml")).toHaveLength(1);
    for (const f of fetches) {
      const h = new Headers(f.init.headers);
      expect(h.has("authorization") || h.has("cookie")).toBe(false);
    }
  });

  it("an all-skipped run FAILS; invalid feeds are reported as such", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/page.html"] = () => new Response("<html><body>not a feed</body></html>");
    const w = await createWatchlist({ sources: [feed("https://acme.dev/page.html", "PRIMARY")] });
    const brief = await finished((await runNow(w.id)).id);
    expect(brief.run).toMatchObject({
      status: "FAILED",
      skippedSources: [{ source: "https://acme.dev/page.html", reason: "INVALID_FEED" }],
    });
  });
});

describe("findings search", () => {
  it("full-text, filters, cursor paging, read state; archived watchlists stay searchable", async () => {
    site["https://acme.dev/robots.txt"] = allowAll;
    site["https://acme.dev/search.xml"] = () =>
      rss([
        { title: "Zebrafish toolkit pricing changes", link: "https://acme.dev/z1", description: "New tiers" },
        { title: "Zebrafish runtime deprecates old plugins", link: "https://acme.dev/z2" },
        { title: "Unrelated gardening post", link: "https://acme.dev/z3" },
      ]);
    const w = await createWatchlist({ sources: [feed("https://acme.dev/search.xml", "PRIMARY")] });
    await finished((await runNow(w.id)).id);

    const q = (s: string) => send("GET", `/v1/research/findings?${s}`).then((r) => r.json<FindingList>());
    const hits = await q(`q=zebrafish&watchlistId=${w.id}`);
    expect(hits.items.map((i) => i.title).sort()).toEqual([
      "Zebrafish runtime deprecates old plugins",
      "Zebrafish toolkit pricing changes",
    ]);
    expect((await q(`q=price&watchlistId=${w.id}`)).items.map((i) => i.title)).toEqual([
      "Zebrafish toolkit pricing changes",
    ]); // English stemming
    expect((await q(`label=UNVERIFIED&watchlistId=${w.id}`)).items).toEqual([]);

    const page1 = await q(`watchlistId=${w.id}&limit=2`);
    expect(page1.items).toHaveLength(2);
    const page2 = await q(`watchlistId=${w.id}&limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(3);

    const today = new Date().toISOString().slice(0, 10);
    expect((await q(`watchlistId=${w.id}&from=${today}&to=${today}`)).items).toHaveLength(3);
    expect((await q(`watchlistId=${w.id}&to=2020-01-01`)).items).toHaveLength(0);

    const target = hits.items[0]!;
    const read = await send("POST", `/v1/research/findings/${target.id}/read`);
    expect(read.statusCode).toBe(200);
    const readAt = read.json<{ readAt: string }>().readAt;
    expect(readAt).not.toBeNull();
    // Reading twice keeps the first time.
    expect(
      (await send("POST", `/v1/research/findings/${target.id}/read`)).json<{ readAt: string }>().readAt,
    ).toBe(readAt);
    expect((await q(`watchlistId=${w.id}&unread=true`)).items.map((i) => i.id)).not.toContain(target.id);
    expect((await q(`watchlistId=${w.id}&unread=false`)).items.map((i) => i.id)).toEqual([target.id]);

    // Weights apply to stored findings at once: relevance-only weights with no keywords → neutral 50.
    await send("PATCH", `/v1/research/watchlists/${w.id}`, {
      weights: { credibility: 0, relevance: 1, novelty: 0, impact: 0, opportunity: 0 },
    });
    expect((await q(`watchlistId=${w.id}`)).items.map((i) => i.score)).toEqual([50, 50, 50]);

    await send("DELETE", `/v1/research/watchlists/${w.id}`);
    expect((await q(`q=zebrafish&watchlistId=${w.id}`)).items).toHaveLength(2);

    expect((await send("GET", "/v1/research/findings?cursor=not-a-uuid")).statusCode).toBe(400);
    expect((await send("POST", `/v1/research/findings/${crypto.randomUUID()}/read`)).statusCode).toBe(404);
    expect((await send("GET", `/v1/research/runs/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });
});

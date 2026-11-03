import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ResearchDomain,
  ResearchDomainList,
  SearchProviderStatus,
  WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords, user, workspaces } from "../src/db/schema.ts";
import { domainPolicy } from "../src/research/domains.ts";
import { researchDomains } from "../src/research/schema.ts";
import { SEARCH_RUNBOOK } from "../src/research/web/search.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// PRD §9 RES source registry: per-workspace domain rules (longest suffix wins), server-side workspace ownership with a
// decoy owner's workspace (NFR-CNV-05), audit records without secrets, and the search-provider status.

let t: TestApp;
let db: Db;
let pool: pg.Pool;
let cookie: string;
let dev: string;
let business: string;
let decoyWorkspace: string;
let dir: string;

type Method = "GET" | "PUT" | "DELETE";
const call = (method: Method, path: string, body?: unknown) =>
  t.app.inject({
    method,
    url: path,
    headers: { cookie, origin: t.config.publicOrigin },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const put = async (body: Record<string, unknown>) => {
  const res = await call("PUT", "/v1/research/domains", body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ResearchDomain>();
};
const list = async (workspaceId: string) =>
  (await call("GET", `/v1/research/domains?workspaceId=${workspaceId}`)).json<ResearchDomainList>().items;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-domains-"));
  t = await createTestApp({ NEXUS_SEARCH_FILE: join(dir, "search.json") });
  ({ db, pool } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  const ws = (await call("GET", "/v1/workspaces")).json<WorkspaceList>();
  dev = ws.items.find((w) => w.mode === "DEV")!.id;
  business = ws.items.find((w) => w.mode === "BUSINESS")!.id;
  // Another owner's workspace with its own rule: it must not exist for this owner.
  const decoyOwner = `decoy-${randomUUID()}`;
  await db.insert(user).values({ id: decoyOwner, name: "Decoy", email: `${decoyOwner}@example.com` });
  const [decoy] = await db
    .insert(workspaces)
    .values({ ownerId: decoyOwner, mode: "DEV", name: "Dev" })
    .returning({ id: workspaces.id });
  decoyWorkspace = decoy!.id;
  await db
    .insert(researchDomains)
    .values({ workspaceId: decoyWorkspace, domain: "decoy.example", tier: "PRIMARY", createdBy: decoyOwner });
});
afterAll(async () => {
  await t?.app.close();
  await pool?.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("domain rules API", () => {
  it("upserts by (workspace, domain), lists sorted, normalises the name and audits create/update", async () => {
    const created = await put({ workspaceId: dev, domain: "Acme.DEV", tier: "PRIMARY", note: "vendor" });
    expect(created).toMatchObject({
      workspaceId: dev,
      domain: "acme.dev",
      tier: "PRIMARY",
      blocked: false,
      note: "vendor",
    });
    const updated = await put({ workspaceId: dev, domain: "acme.dev", tier: "SECONDARY" });
    expect(updated).toMatchObject({ id: created.id, tier: "SECONDARY", note: null }); // PUT replaces the rule
    await put({ workspaceId: dev, domain: "content-farm.example", tier: "COMMUNITY", blocked: true });
    expect((await list(dev)).map((d) => [d.domain, d.tier, d.blocked])).toEqual([
      ["acme.dev", "SECONDARY", false],
      ["content-farm.example", "COMMUNITY", true],
    ]);
    expect(await list(business)).toEqual([]); // rules are per workspace

    const trail = await db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.resourceType, "research_domain"), eq(auditRecords.resourceId, created.id)));
    expect(trail.map((a) => a.action).sort()).toEqual(["research.domain.create", "research.domain.update"]);
    for (const a of trail) {
      expect(a.correlationId).toBeTruthy();
      expect(a.actor).toMatch(/^user:/);
      expect(a.metadata).toEqual({
        workspaceId: dev,
        domain: "acme.dev",
        tier: expect.any(String),
        blocked: false,
      });
    }
  });

  it("rejects bad input: not a domain, a URL, an unknown tier, extra fields", async () => {
    for (const body of [
      { workspaceId: dev, domain: "localhost", tier: "PRIMARY" },
      { workspaceId: dev, domain: "https://acme.dev/x", tier: "PRIMARY" },
      { workspaceId: dev, domain: "acme.dev", tier: "GOLD" },
      { workspaceId: dev, domain: "acme.dev", tier: "PRIMARY", createdBy: "someone" },
      { workspaceId: "not-a-uuid", domain: "acme.dev", tier: "PRIMARY" },
    ])
      expect((await call("PUT", "/v1/research/domains", body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it("deletes a rule with an audit record; a second delete is 404", async () => {
    const rule = await put({ workspaceId: business, domain: "old.example", tier: "COMMUNITY" });
    expect((await call("DELETE", `/v1/research/domains/${rule.id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/v1/research/domains/${rule.id}`)).statusCode).toBe(404);
    const [record] = await db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.action, "research.domain.delete"), eq(auditRecords.resourceId, rule.id)));
    expect(record).toMatchObject({
      outcome: "SUCCEEDED",
      metadata: { workspaceId: business, domain: "old.example" },
    });
  });

  it("decoy workspace: another owner's workspace and rules don't exist for this owner", async () => {
    expect((await call("GET", `/v1/research/domains?workspaceId=${decoyWorkspace}`)).statusCode).toBe(404);
    expect(
      (
        await call("PUT", "/v1/research/domains", {
          workspaceId: decoyWorkspace,
          domain: "x.example",
          tier: "PRIMARY",
        })
      ).statusCode,
    ).toBe(404);
    expect((await call("GET", `/v1/research/domains?workspaceId=${randomUUID()}`)).statusCode).toBe(404);
    const [decoyRule] = await db
      .select()
      .from(researchDomains)
      .where(eq(researchDomains.workspaceId, decoyWorkspace));
    expect((await call("DELETE", `/v1/research/domains/${decoyRule!.id}`)).statusCode).toBe(404);
    expect(
      await db.select().from(researchDomains).where(eq(researchDomains.workspaceId, decoyWorkspace)),
    ).toHaveLength(1);
    expect((await domainPolicy(db, dev))("decoy.example")).toEqual({
      domain: null,
      tier: "COMMUNITY",
      blocked: false,
    });
  });

  it("needs a session and a trusted Origin", async () => {
    expect(
      (await t.app.inject({ method: "GET", url: `/v1/research/domains?workspaceId=${dev}` })).statusCode,
    ).toBe(401);
    const res = await t.app.inject({
      method: "PUT",
      url: "/v1/research/domains",
      headers: { cookie, origin: "https://evil.example" },
      payload: { workspaceId: dev, domain: "acme.dev", tier: "PRIMARY" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("domainPolicy (longest suffix wins)", () => {
  it("matches the domain and its subdomains; the most specific rule wins; unknown is COMMUNITY", async () => {
    await put({ workspaceId: dev, domain: "example.org", tier: "SECONDARY" });
    await put({ workspaceId: dev, domain: "blog.example.org", tier: "COMMUNITY", blocked: true });
    await put({ workspaceId: dev, domain: "docs.blog.example.org", tier: "PRIMARY" });
    const policy = await domainPolicy(db, dev);
    expect(policy("example.org")).toEqual({ domain: "example.org", tier: "SECONDARY", blocked: false });
    expect(policy("WWW.Example.org.")).toEqual({ domain: "example.org", tier: "SECONDARY", blocked: false });
    expect(policy("blog.example.org")).toEqual({
      domain: "blog.example.org",
      tier: "COMMUNITY",
      blocked: true,
    });
    expect(policy("a.b.blog.example.org")).toMatchObject({ domain: "blog.example.org", blocked: true });
    expect(policy("docs.blog.example.org")).toEqual({
      domain: "docs.blog.example.org",
      tier: "PRIMARY",
      blocked: false,
    });
    expect(policy("notexample.org")).toEqual({ domain: null, tier: "COMMUNITY", blocked: false }); // label boundary
    expect(policy("example.org.evil.test")).toEqual({ domain: null, tier: "COMMUNITY", blocked: false });
    expect(policy("[2606:4700::1111]")).toEqual({ domain: null, tier: "COMMUNITY", blocked: false });
    expect((await domainPolicy(db, business))("example.org")).toMatchObject({ domain: null });
  });
});

describe("GET /v1/research/search-provider", () => {
  it("reports the runbook until search.json is usable, then the provider; never the key", async () => {
    const missing = await call("GET", "/v1/research/search-provider");
    expect(missing.statusCode).toBe(200);
    expect(missing.json<SearchProviderStatus>()).toMatchObject({
      configured: false,
      runbook: SEARCH_RUNBOOK,
    });
    const key = randomBytes(16).toString("hex");
    writeFileSync(join(dir, "search.json"), JSON.stringify({ provider: "brave", apiKey: key }), {
      mode: 0o600,
    });
    const ready = await call("GET", "/v1/research/search-provider");
    expect(ready.json()).toEqual({ configured: true, provider: "brave" });
    expect(ready.body).not.toContain(key);
  });
});

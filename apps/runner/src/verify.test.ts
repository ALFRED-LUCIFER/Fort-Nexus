import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildChangeset } from "./changeset.ts";
import { worktreeGitDir } from "./claude.ts";
import {
  SANDBOX_IMAGE,
  containerName,
  docker,
  egressNames,
  imageExists,
  removeLeftovers,
} from "./sandbox.ts";
import { git } from "./test-support.ts";
import {
  VERIFY_TAIL_MAX,
  VerifyConfigError,
  readVerifyPlan,
  runVerification,
  type VerifyOptions,
} from "./verify.ts";
import { createWorkspaces } from "./workspace.ts";

let data = "";
beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "nexus-verify-test-"));
});
afterEach(() => rm(data, { recursive: true, force: true }));

const nexusJson = (verify: unknown) => JSON.stringify({ verify });

/** A base commit with `base` files, a worktree on it, then the agent's `change` written into the worktree. */
async function repo(base: Record<string, string>, change: Record<string, string> = {}) {
  const src = join(data, `src-${randomUUID()}`);
  git(["init", "-q", "-b", "main", src]);
  await writeFile(join(src, "README.md"), "hi\n");
  for (const [path, content] of Object.entries(base)) await writeFile(join(src, path), content);
  git(["-C", src, "add", "."]);
  git(["-C", src, "commit", "-q", "-m", "base"]);
  const mirror = join(data, "repos", "acme", `${randomUUID()}.git`);
  git(["clone", "-q", "--mirror", src, mirror]);
  const jobId = randomUUID();
  const wt = await createWorkspaces(data).prepareWorktree({
    jobId,
    mirrorPath: mirror,
    baseRef: "main",
    branch: "nexus/t",
  });
  const gitDir = await worktreeGitDir(wt.path);
  for (const [path, content] of Object.entries(change)) await writeFile(join(wt.path, path), content);
  const cs = await buildChangeset(wt.path, gitDir, wt.baseSha);
  return { ...wt, jobId, gitDir, tree: cs.tree, files: cs.files };
}

describe("readVerifyPlan (from the base commit)", () => {
  it("uses .nexus.json from the base commit; the agent's edit to it is ignored", async () => {
    const r = await repo(
      {
        ".nexus.json": nexusJson({
          install: ["make", "deps"],
          test: ["make", "test"],
          egress: ["pkg.example"],
        }),
      },
      { ".nexus.json": nexusJson({ test: ["true"] }) },
    );
    expect(r.files.map((f) => f.path)).toEqual([".nexus.json"]); // the edit is in the changeset…
    expect(await readVerifyPlan(r.gitDir, r.baseSha)).toEqual({
      source: "nexus.json", // …but never decides what runs
      install: ["make", "deps"],
      test: ["make", "test"],
      egress: ["pkg.example"],
      timeoutMs: 15 * 60_000,
    });
  });

  it("an agent-added .nexus.json does not configure anything", async () => {
    const r = await repo({}, { ".nexus.json": nexusJson({ test: ["true"] }) });
    expect(await readVerifyPlan(r.gitDir, r.baseSha)).toBeNull();
  });

  const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
  it.each([
    [
      "npm",
      { "package.json": pkg, "package-lock.json": "{}" },
      ["npm", "ci"],
      ["npm", "test"],
      ["registry.npmjs.org"],
    ],
    [
      "pnpm",
      { "package.json": pkg, "pnpm-lock.yaml": "" },
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
      ["corepack", "pnpm", "test"],
      ["registry.npmjs.org"],
    ],
    [
      "yarn",
      { "package.json": pkg, "yarn.lock": "" },
      ["corepack", "yarn", "install", "--frozen-lockfile"],
      ["corepack", "yarn", "test"],
      ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"],
    ],
  ])("auto-detects %s from package.json + its lockfile", async (_, base, install, test, egress) => {
    const r = await repo(base);
    expect(await readVerifyPlan(r.gitDir, r.baseSha)).toEqual({
      source: "package.json",
      install,
      test,
      egress,
      timeoutMs: 15 * 60_000,
    });
  });

  it.each([
    ["no package.json", {}],
    [
      "no test script",
      { "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "package-lock.json": "{}" },
    ],
    ["no lockfile", { "package.json": pkg }],
    ["unparseable package.json", { "package.json": "{", "package-lock.json": "{}" }],
    [
      ".nexus.json without verify (explicit opt-out)",
      { ".nexus.json": "{}", "package.json": pkg, "yarn.lock": "" },
    ],
  ])("not configured: %s", async (_, base) => {
    const r = await repo(base);
    expect(await readVerifyPlan(r.gitDir, r.baseSha)).toBeNull();
  });

  it("ignores a symlinked .nexus.json and falls back to detection", async () => {
    const src = join(data, "src-link");
    git(["init", "-q", "-b", "main", src]);
    await writeFile(join(src, "package.json"), pkg);
    await writeFile(join(src, "package-lock.json"), "{}");
    await symlink("/etc/passwd", join(src, ".nexus.json"));
    git(["-C", src, "add", "."]);
    git(["-C", src, "commit", "-q", "-m", "base"]);
    const plan = await readVerifyPlan(join(src, ".git"), git(["-C", src, "rev-parse", "HEAD"]));
    expect(plan?.source).toBe("package.json");
  });

  it.each([
    ["invalid JSON", "{", /not valid JSON/],
    ["a shell string instead of argv", nexusJson({ test: "npm test" }), /verify\.test/],
    ["an unknown key", nexusJson({ test: ["x"], shell: true }), /invalid/],
    ["GitHub in egress", nexusJson({ test: ["x"], egress: ["api.github.com"] }), /api\.github\.com/],
    ["the model host in egress", nexusJson({ test: ["x"], egress: ["api.anthropic.com"] }), /anthropic/],
    ["Foundry in egress", nexusJson({ test: ["x"], egress: ["me.services.ai.azure.com"] }), /azure/],
  ])("rejects .nexus.json with %s", async (_, content, message) => {
    const r = await repo({ ".nexus.json": content });
    await expect(readVerifyPlan(r.gitDir, r.baseSha)).rejects.toThrow(VerifyConfigError);
    await expect(readVerifyPlan(r.gitDir, r.baseSha)).rejects.toThrow(message);
  });
});

const verify = (r: Awaited<ReturnType<typeof repo>>, over: Partial<VerifyOptions> = {}) => {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const result = runVerification({
    jobId: r.jobId,
    gitDir: r.gitDir,
    baseSha: r.baseSha,
    tree: r.tree,
    onEvent: (type, payload) => events.push({ type, payload }),
    killGraceMs: 1_000,
    log: () => {},
    ...over,
  });
  return { result, events };
};

describe("runVerification without a runnable config (no Docker needed)", () => {
  it("not_configured: nothing runs", async () => {
    const r = await repo({}, { "NOTES.md": "x\n" });
    expect((await verify(r).result).verification).toEqual({
      status: "not_configured",
      reason: null,
      source: null,
      install: null,
      test: null,
      exitCode: null,
      durationMs: expect.any(Number),
      outputTail: "",
    });
  });

  it("an invalid .nexus.json is an error with the reason, not a pass", async () => {
    const r = await repo({ ".nexus.json": "{" }, { "NOTES.md": "x\n" });
    const { verification, stopConfirmed } = await verify(r).result;
    expect(stopConfirmed).toBe(true);
    expect(verification).toMatchObject({
      status: "error",
      reason: ".nexus.json at the base commit is not valid JSON",
      source: null,
      exitCode: null,
    });
    expect(verification.outputTail).toBe("[nexus] .nexus.json at the base commit is not valid JSON");
  });
});

const dockerUp = (await docker(["info"], 10_000)).ok;
if (!dockerUp) console.warn("SKIPPING real Docker verification tests: the docker daemon is not reachable");

describe.skipIf(!dockerUp)("runVerification in the real sandbox", () => {
  const runnerLabel = `nexus-verify-${process.pid}`;
  const upstream = `nexus-test-vup-${process.pid}`;
  const fs = "const fs=require('fs');";
  beforeAll(async () => {
    if (!(await imageExists(SANDBOX_IMAGE))) {
      const infra = fileURLToPath(new URL("../../../infra/sandbox", import.meta.url));
      const built = await docker(["build", "-t", SANDBOX_IMAGE, infra], 600_000);
      if (!built.ok) throw new Error(`building ${SANDBOX_IMAGE} failed: ${built.stderr}`);
    }
    // Stand-ins for the internet, reachable only through the job's proxy (as in claude.test.ts).
    expect((await docker(["network", "create", "--label", `nexus.runner=${runnerLabel}`, upstream])).ok).toBe(
      true,
    );
    for (const host of ["registry.test", "other.test", "api.anthropic.com", "github.com"]) {
      const started = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        `${upstream}-${host}`,
        "--label",
        `nexus.runner=${runnerLabel}`,
        "--network",
        upstream,
        "--network-alias",
        host,
        SANDBOX_IMAGE,
        "node",
        "-e",
        "require('net').createServer((s)=>s.end('HELLO '+process.argv[1]+'\\n')).listen(443)",
        host,
      ]);
      expect(started.ok).toBe(true);
    }
  }, 600_000);
  afterAll(() => removeLeftovers(runnerLabel));

  const gone = async (jobId: string) => {
    const { network, proxy } = egressNames(jobId);
    for (const args of [
      ["container", "inspect", containerName(jobId)],
      ["container", "inspect", proxy],
      ["network", "inspect", network],
    ])
      expect((await docker(args)).ok, args.join(" ")).toBe(false);
  };

  it("passed: install then test run on base + the agent's change; install artifacts stay out of the worktree", async () => {
    const r = await repo(
      {
        ".nexus.json": nexusJson({
          install: ["node", "-e", `${fs}fs.mkdirSync('node_modules/dep',{recursive:true})`],
          test: [
            "node",
            "-e",
            `${fs}const ok=fs.existsSync('NOTES.md')&&fs.existsSync('node_modules/dep');console.log('tests ok='+ok);process.exit(ok?0:3)`,
          ],
        }),
      },
      { "NOTES.md": "hello\n" },
    );
    const { verification, stopped, stopConfirmed } = await verify(r, { runnerLabel }).result;
    expect({ stopped, stopConfirmed }).toEqual({ stopped: false, stopConfirmed: true });
    expect(verification).toMatchObject({ status: "passed", source: "nexus.json", exitCode: 0 });
    expect(verification.test?.[0]).toBe("node");
    expect(verification.outputTail).toContain("tests ok=true");
    // Verification ran on a disposable checkout: nothing it installed reaches the worktree or the changeset.
    expect(existsSync(join(r.path, "node_modules"))).toBe(false);
    const after = await buildChangeset(r.path, r.gitDir, r.baseSha);
    expect(after.files.map((f) => f.path)).toEqual(["NOTES.md"]);
    await gone(r.jobId);
  }, 120_000);

  it("failed: a non-zero test exit, with the redacted output tail capped at 8000 chars", async () => {
    const r = await repo(
      {
        ".nexus.json": nexusJson({
          test: [
            "node",
            "-e",
            "console.log('x'.repeat(20000));console.log('token=abc123secret');console.error('1 test failed');process.exit(3)",
          ],
        }),
      },
      { "NOTES.md": "x\n" },
    );
    const { verification } = await verify(r, { runnerLabel }).result;
    expect(verification).toMatchObject({ status: "failed", reason: null, exitCode: 3, install: null });
    expect(verification.outputTail.length).toBeLessThanOrEqual(VERIFY_TAIL_MAX);
    expect(verification.outputTail).toContain("1 test failed");
    expect(verification.outputTail).toContain("token=[REDACTED]");
    expect(verification.outputTail).not.toContain("abc123secret");
  }, 120_000);

  it.each([
    [
      "install fails",
      { install: ["node", "-e", "console.log('ERR! 404');process.exit(1)"], test: ["true"] },
      /ERR! 404\n\[nexus\] install failed with exit code 1$/,
    ],
  ])(
    "error: %s",
    async (_, cfg, tail) => {
      const r = await repo({ ".nexus.json": nexusJson(cfg) }, { "NOTES.md": "x\n" });
      const { verification } = await verify(r, { runnerLabel }).result;
      expect(verification).toMatchObject({
        status: "error",
        reason: "install failed with exit code 1",
        exitCode: null,
      });
      expect(verification.outputTail).toMatch(tail);
      await gone(r.jobId);
    },
    120_000,
  );

  it("error: timeout stops the container and says so", async () => {
    const r = await repo(
      {
        ".nexus.json": nexusJson({ test: ["node", "-e", "console.log('started');setInterval(()=>{},1000)"] }),
      },
      { "NOTES.md": "x\n" },
    );
    const started = Date.now();
    const { verification, stopConfirmed } = await verify(r, { runnerLabel, maxTimeoutMs: 2_000 }).result;
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(stopConfirmed).toBe(true);
    expect(verification).toMatchObject({
      status: "error",
      reason: "timed out after 2 s during test",
      exitCode: null,
    });
    expect(verification.outputTail).toMatch(/\[nexus\] timed out after 2 s during test$/);
    await gone(r.jobId);
  }, 60_000);

  it("a stop (cancel) during the test removes the container and reports stopped", async () => {
    const r = await repo(
      { ".nexus.json": nexusJson({ test: ["node", "-e", "setInterval(()=>{},1000)"] }) },
      {
        "NOTES.md": "x\n",
      },
    );
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1_500);
    const res = await verify(r, { runnerLabel, signal: abort.signal }).result;
    expect(res).toMatchObject({ stopped: true, stopConfirmed: true });
    await gone(r.jobId);
  }, 60_000);

  it("egress: only the configured hosts, never the model host or GitHub; no key or token in the env", async () => {
    const secret = randomBytes(16).toString("hex");
    const saved = { ...process.env };
    // As if the runner process held provider credentials: none of it may reach the verification container.
    Object.assign(process.env, { ANTHROPIC_API_KEY: secret, AZURE_API_KEY: secret, GH_TOKEN: secret });
    const probe = `
const net=require('net');const proxy=new URL(process.env.HTTPS_PROXY);
const via=(t)=>new Promise((r)=>{const s=net.connect(+proxy.port,proxy.hostname,()=>s.write('CONNECT '+t+' HTTP/1.1\\r\\nHost: '+t+'\\r\\n\\r\\n'));let d='';s.on('data',(x)=>{d+=x;if(/HELLO|403|502/.test(d)){s.destroy();r(/HELLO/.test(d)?'TUNNEL':d.split('\\r\\n')[0])}});s.on('error',(e)=>r('ERR '+e.code));setTimeout(()=>{s.destroy();r('TIMEOUT')},5000)});
(async()=>{console.log('ENV '+JSON.stringify(process.env));console.log('NET '+JSON.stringify({
registry:await via('registry.test:443'),other:await via('other.test:443'),
model:await via('api.anthropic.com:443'),github:await via('github.com:443')}))})()`;
    try {
      const r = await repo(
        { ".nexus.json": nexusJson({ test: ["node", "-e", probe], egress: ["registry.test"] }) },
        { "NOTES.md": "x\n" },
      );
      const { result, events } = verify(r, { runnerLabel, egressNetwork: upstream });
      const { verification } = await result;
      expect(verification.status).toBe("passed");
      const tail = verification.outputTail;
      expect(JSON.parse(/^NET (.*)$/m.exec(tail)![1]!)).toEqual({
        registry: "TUNNEL",
        other: "HTTP/1.1 403 Forbidden",
        model: "HTTP/1.1 403 Forbidden",
        github: "HTTP/1.1 403 Forbidden",
      });
      const env = JSON.parse(/^ENV (.*)$/m.exec(tail)![1]!) as Record<string, string>;
      expect(JSON.stringify(env)).not.toContain(secret);
      expect(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|ANTHROPIC|AZURE|GITHUB|GH_/i.test(k))).toEqual(
        [],
      );
      expect(env).toMatchObject({ HTTPS_PROXY: "http://nexus-proxy:3128", CI: "true" });
      expect(events.filter((e) => e.type === "tool.denied").map((e) => e.payload)).toEqual([
        { kind: "egress", phase: "verify", target: "other.test:443" },
        { kind: "egress", phase: "verify", target: "api.anthropic.com:443" },
        { kind: "egress", phase: "verify", target: "github.com:443" },
      ]);
      await gone(r.jobId);
    } finally {
      process.env = saved;
    }
  }, 120_000);

  it("no egress configured: no network at all", async () => {
    const r = await repo(
      {
        ".nexus.json": nexusJson({
          test: [
            "node",
            "-e",
            "require('dns').lookup('registry.npmjs.org',(e)=>{console.log('dns='+(e?'ERR':'OK'));console.log('proxy='+(process.env.HTTPS_PROXY??'none'))})",
          ],
        }),
      },
      { "NOTES.md": "x\n" },
    );
    const { verification } = await verify(r, { runnerLabel }).result;
    expect(verification.outputTail).toContain("dns=ERR");
    expect(verification.outputTail).toContain("proxy=none");
  }, 60_000);
});

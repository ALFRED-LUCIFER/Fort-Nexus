import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildChangeset } from "./changeset.ts";
import { worktreeGitDir } from "./claude.ts";
import { prepareDeps } from "./prepare-deps.ts";
import {
  SANDBOX_IMAGE,
  containerName,
  docker,
  dockerRunArgs,
  egressNames,
  imageExists,
  removeLeftovers,
  writableUser,
  detectRuntime,
} from "./sandbox.ts";
import { git } from "./test-support.ts";
import { createWorkspaces } from "./workspace.ts";

// Real Docker only. No test here needs a package registry: the install steps are node one-liners.
const dockerUp = (await docker(["info"], 10_000)).ok;
if (!dockerUp) console.warn("SKIPPING real Docker prepareDeps tests: the docker daemon is not reachable");

let data = "";
beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "nexus-deps-test-"));
});
afterEach(() => rm(data, { recursive: true, force: true }));

const nexusJson = (verify: unknown) => JSON.stringify({ verify });
const INSTALL_OK = `const fs=require('fs');fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.js','module.exports="dep-ok"');fs.writeFileSync('/workspace/cache/marker','cached')`;

async function repo(base: Record<string, string>) {
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
  const cacheDir = join(data, "cache");
  await mkdir(cacheDir);
  return { ...wt, jobId, gitDir: await worktreeGitDir(wt.path), cacheDir };
}

describe.skipIf(!dockerUp)("prepareDeps in the real sandbox", () => {
  const runnerLabel = `nexus-deps-${process.pid}`;
  beforeAll(async () => {
    if (!(await imageExists(SANDBOX_IMAGE))) {
      const infra = fileURLToPath(new URL("../../../infra/sandbox", import.meta.url));
      const built = await docker(["build", "-t", SANDBOX_IMAGE, infra], 600_000);
      if (!built.ok) throw new Error(`building ${SANDBOX_IMAGE} failed: ${built.stderr}`);
    }
  }, 600_000);
  afterAll(() => removeLeftovers(runnerLabel));

  const run = (r: Awaited<ReturnType<typeof repo>>, extra = {}) =>
    prepareDeps({
      jobId: r.jobId,
      gitDir: r.gitDir,
      baseSha: r.baseSha,
      worktreePath: r.path,
      cacheDir: r.cacheDir,
      runnerLabel,
      ...extra,
    });

  it("installs into the worktree and cache; a later container with no network runs tests on it", async () => {
    const r = await repo({
      ".gitignore": "node_modules\n",
      ".nexus.json": nexusJson({ install: ["node", "-e", INSTALL_OK], test: ["true"] }),
    });
    expect(await run(r)).toEqual({ ok: true, reason: null });
    expect(await readFile(join(r.cacheDir, "marker"), "utf8")).toBe("cached");
    expect((await buildChangeset(r.path, r.gitDir, r.baseSha)).files).toEqual([]);
    const runtime = await detectRuntime();
    const later = await docker(
      dockerRunArgs({
        jobId: randomUUID(),
        runnerLabel,
        workspace: await mkdtemp(join(data, "ws-")),
        workdir: "/workspace/repo",
        argv: ["node", "-e", "console.log(require('dep'))"],
        user: writableUser(runtime),
        network: "none",
        mounts: [{ source: r.path, target: "/workspace/repo" }],
      }),
      60_000,
    );
    expect(later.stdout.trim()).toBe("dep-ok");
    expect((await docker(["container", "inspect", containerName(r.jobId)])).ok).toBe(false);
  }, 120_000);

  it("no install step: nothing runs", async () => {
    const r = await repo({ ".nexus.json": nexusJson({ test: ["true"] }) });
    expect(await run(r)).toEqual({ ok: true, reason: null });
    expect(existsSync(join(r.path, "node_modules"))).toBe(false);
  });

  it("a failing install is ok:false with the reason, and never throws", async () => {
    const r = await repo({
      ".nexus.json": nexusJson({
        install: ["node", "-e", "require('fs').writeFileSync('half.txt','x');process.exit(4)"],
        test: ["true"],
      }),
    });
    const res = await run(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/install failed with exit code 4/);
    expect(existsSync(join(r.path, "half.txt"))).toBe(false); // the half-done install is cleaned too
  }, 120_000);

  it("a timed-out install is ok:false and the container is gone", async () => {
    const r = await repo({
      ".nexus.json": nexusJson({ install: ["node", "-e", "setInterval(()=>{},1000)"], test: ["true"] }),
    });
    const res = await run(r, { maxTimeoutMs: 2_000 });
    expect(res).toEqual({ ok: false, reason: "install timed out after 2 s" });
    expect((await docker(["container", "inspect", containerName(r.jobId)])).ok).toBe(false);
  }, 60_000);

  it("a repository that doesn't ignore node_modules is cleaned and reported", async () => {
    const r = await repo({
      ".nexus.json": nexusJson({ install: ["node", "-e", INSTALL_OK], test: ["true"] }),
    });
    const res = await run(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/node_modules/);
    expect(existsSync(join(r.path, "node_modules"))).toBe(false);
    expect((await buildChangeset(r.path, r.gitDir, r.baseSha)).files).toEqual([]);
  }, 120_000);

  it("uses the plan's egress and removes the proxy afterwards", async () => {
    const r = await repo({
      ".nexus.json": nexusJson({ install: ["true"], test: ["true"], egress: ["registry.test"] }),
    });
    expect(await run(r)).toEqual({ ok: true, reason: null });
    const { network, proxy } = egressNames(r.jobId);
    expect((await docker(["container", "inspect", proxy])).ok).toBe(false);
    expect((await docker(["network", "inspect", network])).ok).toBe(false);
  }, 120_000);
});

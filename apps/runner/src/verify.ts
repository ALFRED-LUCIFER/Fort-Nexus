import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { NexusRepoConfig, type RunEventType, type Verification } from "@nexus/contracts";
import { errorMessage, log as defaultLog, type Log } from "./log.ts";
import { redact } from "./output.ts";
import {
  PROXY_URL,
  SANDBOX_IMAGE,
  containerName,
  detectRuntime,
  dockerEnv,
  dockerRunArgs,
  egressNames,
  imageExists,
  removeContainer,
  startEgress,
  stopEgress,
  writableUser,
} from "./sandbox.ts";
import { git } from "./workspace.ts";

// FR-DEV-05: NEXUS runs the repo's own tests after the agent, in a fresh sandbox container, on exactly the tree
// that would be pushed (base + changeset). What to run comes from the BASE commit, never from the agent's work.

export const VERIFY_TAIL_MAX = 8_000;
const VERIFY_REASON_MAX = 500; // Verification.reason
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const KEEP_CHARS = 64 * 1024; // raw output kept before redaction; only the tail is reported

export type VerifyPlan = {
  source: "nexus.json" | "package.json";
  install: string[] | null;
  test: string[];
  egress: string[];
  timeoutMs: number;
};

// Verification never reaches the model provider or GitHub, whatever .nexus.json asks for.
const FORBIDDEN_HOST =
  /(^|\.)(github\.com|githubusercontent\.com|ghcr\.io|anthropic\.com|claude\.ai|claude\.com|services\.ai\.azure\.com|openai\.azure\.com|cognitiveservices\.azure\.com)$/;

// Auto-detection for Node projects: first lockfile wins. pnpm/yarn come through corepack (not on the image's PATH).
const NODE_PMS: readonly [lockfile: string, install: string[], test: string[], egress: string[]][] = [
  [
    "pnpm-lock.yaml",
    ["corepack", "pnpm", "install", "--frozen-lockfile"],
    ["corepack", "pnpm", "test"],
    ["registry.npmjs.org"],
  ],
  [
    "yarn.lock",
    ["corepack", "yarn", "install", "--frozen-lockfile"],
    ["corepack", "yarn", "test"],
    // repo.yarnpkg.com: where corepack fetches Yarn 2+ itself.
    ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"],
  ],
  ["package-lock.json", ["npm", "ci"], ["npm", "test"], ["registry.npmjs.org"]],
];

export class VerifyConfigError extends Error {}

const duration = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

const gitAt = (gitDir: string, args: string[]) =>
  git([`--git-dir=${gitDir}`, "-c", `core.hooksPath=${devNull}`, ...args]);

/**
 * What to verify, read from `baseSha` in the trusted git dir: `.nexus.json` if present, else a Node project
 * (package.json with a test script + a lockfile). null = not configured. Throws VerifyConfigError on a bad config.
 */
export async function readVerifyPlan(gitDir: string, baseSha: string): Promise<VerifyPlan | null> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("invalid base sha");
  // `<mode> <type> <sha>\t<name>\0` per root entry; regular files only (a symlink could point anywhere).
  const blobs = new Map<string, string>();
  for (const entry of (await gitAt(gitDir, ["ls-tree", "-z", baseSha])).split("\0")) {
    const m = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (m) blobs.set(m[3]!, m[2]!);
  }
  const read = (name: string) => gitAt(gitDir, ["cat-file", "blob", blobs.get(name)!]);

  if (blobs.has(".nexus.json")) {
    let raw: unknown;
    try {
      raw = JSON.parse(await read(".nexus.json"));
    } catch {
      throw new VerifyConfigError(".nexus.json at the base commit is not valid JSON");
    }
    const parsed = NexusRepoConfig.safeParse(raw);
    if (!parsed.success)
      throw new VerifyConfigError(
        `.nexus.json at the base commit is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      );
    const v = parsed.data.verify;
    if (!v) return null;
    const forbidden = v.egress.filter((h) => FORBIDDEN_HOST.test(h));
    if (forbidden.length)
      throw new VerifyConfigError(`.nexus.json egress may not include ${forbidden.join(", ")}`);
    return {
      source: "nexus.json",
      install: v.install ?? null,
      test: v.test,
      egress: v.egress,
      timeoutMs: v.timeoutMinutes * 60_000,
    };
  }

  if (!blobs.has("package.json")) return null;
  let pkg: { scripts?: { test?: unknown } };
  try {
    pkg = JSON.parse(await read("package.json")) as typeof pkg;
  } catch {
    return null; // not a Node project NEXUS can detect
  }
  if (typeof pkg?.scripts?.test !== "string" || !pkg.scripts.test.trim()) return null;
  const pm = NODE_PMS.find(([lockfile]) => blobs.has(lockfile));
  if (!pm) return null;
  return {
    source: "package.json",
    install: pm[1],
    test: pm[2],
    egress: pm[3],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** Writes `tree` (all of it, symlinks as symlinks) into the empty directory `dest`, with no repo-controlled config. */
async function checkoutTree(gitDir: string, tree: string, dest: string, index: string) {
  const g = (args: string[]) =>
    git(
      [
        `--git-dir=${gitDir}`,
        `--work-tree=${dest}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        "core.symlinks=true",
        ...args,
      ],
      { env: { GIT_INDEX_FILE: index }, timeoutMs: 300_000 },
    );
  try {
    await g(["read-tree", tree]);
    await g(["checkout-index", "--all", "--force"]);
  } finally {
    await rm(index, { force: true });
  }
}

export type VerifyOptions = {
  jobId: string;
  /** The worktree's trusted git dir (resolved before the agent ran). */
  gitDir: string;
  baseSha: string;
  /** Tree of base + changeset (buildChangeset().tree). */
  tree: string;
  onEvent: (type: RunEventType, payload: Record<string, unknown>) => void;
  signal?: AbortSignal;
  runnerLabel?: string;
  image?: string;
  killGraceMs?: number;
  log?: Log;
  /** Test seam: where the egress proxy's own traffic leaves (default Docker's "bridge"). */
  egressNetwork?: string;
  /** Test seam: caps the plan's timeout (the contract's minimum is a minute). */
  maxTimeoutMs?: number;
};

export type VerifyResult = {
  verification: Verification;
  /** The signal aborted it; nothing is reported as verified. */
  stopped: boolean;
  /** False when Docker could not confirm the container is gone. */
  stopConfirmed: boolean;
};

type Step = { exitCode: number | null; timedOut: boolean; aborted: boolean; stuck: boolean; error?: string };

export async function runVerification(opts: VerifyOptions): Promise<VerifyResult> {
  const {
    jobId,
    gitDir,
    baseSha,
    tree,
    onEvent,
    signal,
    runnerLabel = "local",
    image = SANDBOX_IMAGE,
  } = opts;
  const { killGraceMs = 5_000, log = defaultLog, egressNetwork, maxTimeoutMs = Infinity } = opts;
  const started = Date.now();
  let output = "";
  const result = (
    status: Verification["status"],
    plan: VerifyPlan | null,
    exitCode: number | null,
    note?: string,
  ): Verification => {
    // The note goes last so the tail always keeps it.
    const text =
      redact(output) + (note ? `${output && !output.endsWith("\n") ? "\n" : ""}[nexus] ${note}` : "");
    return {
      status,
      // Every error path passes its note; the reason is shown on its own, outside the repo-controlled tail.
      reason:
        status === "error" ? redact(note ?? "verification could not run").slice(0, VERIFY_REASON_MAX) : null,
      source: plan?.source ?? null,
      install: plan?.install ?? null,
      test: plan?.test ?? null,
      exitCode,
      durationMs: Date.now() - started,
      outputTail: text.length > VERIFY_TAIL_MAX ? text.slice(-VERIFY_TAIL_MAX) : text,
    };
  };
  let plan: VerifyPlan | null;
  try {
    plan = await readVerifyPlan(gitDir, baseSha);
  } catch (err) {
    const msg =
      err instanceof VerifyConfigError ? err.message : `could not read the repo config: ${errorMessage(err)}`;
    return { verification: result("error", null, null, msg), stopped: false, stopConfirmed: true };
  }
  if (!plan)
    return { verification: result("not_configured", null, null), stopped: false, stopConfirmed: true };
  const p = plan;

  const container = containerName(jobId);
  let dir: string | undefined;
  let egress = false;
  let stopConfirmed = true;
  const timeoutMs = Math.min(p.timeoutMs, maxTimeoutMs);
  const deadline = started + timeoutMs;

  // One `docker run` per argv (no shell to chain them). Stops on abort or at the shared deadline.
  const step = (argv: string[], user: string, workspace: string) =>
    new Promise<Step>((resolve) => {
      const args = dockerRunArgs({
        jobId,
        runnerLabel,
        workspace,
        workdir: "/workspace/repo",
        argv: argv as [string, ...string[]],
        image,
        user,
        ...(egress ? { network: egressNames(jobId).network } : {}),
        // No provider key, no token: only the proxy (if any), caches and a non-interactive CI marker.
        env: {
          ...(egress ? { HTTPS_PROXY: PROXY_URL, https_proxy: PROXY_URL, NODE_USE_ENV_PROXY: "1" } : {}),
          CI: "true",
          TMPDIR: "/workspace/tmp",
          XDG_CACHE_HOME: "/workspace/cache",
          XDG_DATA_HOME: "/workspace/cache/data",
          XDG_CONFIG_HOME: "/workspace/cache/config",
          npm_config_cache: "/workspace/cache/npm",
          COREPACK_HOME: "/workspace/cache/corepack",
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        },
      });
      const r: Step = { exitCode: null, timedOut: false, aborted: false, stuck: false };
      // Never start a container a stop already asked for (a kill racing `docker run` can leave one behind).
      if (signal?.aborted) return resolve({ ...r, aborted: true });
      const child = spawn("docker", args, {
        env: dockerEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stopping: Promise<void> | undefined;
      const stop = (why: "timedOut" | "aborted") => {
        r[why] = true;
        stopping ??= (async () => {
          if (!(await removeContainer(container, killGraceMs))) r.stuck = true;
          child.kill("SIGKILL"); // never leave the docker client behind
        })();
      };
      const timer = setTimeout(() => stop("timedOut"), Math.max(0, deadline - Date.now()));
      const onAbort = () => stop("aborted");
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const onData = (t: string) => {
        output += t;
        if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
      };
      child.stdout.setEncoding("utf8").on("data", onData);
      child.stderr.setEncoding("utf8").on("data", onData);
      const finished = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void (stopping ?? Promise.resolve()).then(() => resolve(r));
      };
      child.on("error", (err) => {
        if (child.pid !== undefined) return;
        r.error = err.message;
        finished();
      });
      child.once("close", (code) => {
        r.exitCode = code;
        finished();
      });
    });

  // A step that ended without a usable exit code, as the verification to report (undefined: it ran).
  const broken = (name: string, s: Step): Omit<VerifyResult, "stopConfirmed"> | undefined => {
    if (s.stuck) {
      stopConfirmed = false;
      return {
        verification: result("error", p, null, `the ${name} container could not be stopped`),
        stopped: false,
      };
    }
    if (s.aborted) return { verification: result("error", p, null, "stopped"), stopped: true };
    if (s.timedOut) {
      return {
        verification: result("error", p, null, `timed out after ${duration(timeoutMs)} during ${name}`),
        stopped: false,
      };
    }
    if (s.error)
      return { verification: result("error", p, null, `could not start docker: ${s.error}`), stopped: false };
    // 125: `docker run` itself failed, not the command inside.
    if (s.exitCode === null || s.exitCode === 125)
      return {
        verification: result(
          "error",
          p,
          null,
          `${name} could not run in the sandbox (exit code ${s.exitCode ?? "none"})`,
        ),
        stopped: false,
      };
    return undefined;
  };

  const execute = async (): Promise<Omit<VerifyResult, "stopConfirmed">> => {
    const runtime = await detectRuntime().catch(() => undefined);
    if (!runtime)
      return {
        verification: result("error", p, null, "Docker is not reachable on the runner host"),
        stopped: false,
      };
    if (!(await imageExists(image)))
      return { verification: result("error", p, null, `sandbox image ${image} is missing`), stopped: false };
    const user = writableUser(runtime);
    const workspace = (dir = await mkdtemp(join(tmpdir(), "nexus-verify-")));
    for (const sub of ["repo", "cache", "tmp"]) await mkdir(join(workspace, sub));
    await chmod(workspace, 0o755);
    await checkoutTree(gitDir, tree, join(workspace, "repo"), join(workspace, "index"));
    if (signal?.aborted) return { verification: result("error", p, null, "stopped"), stopped: true };
    if (p.egress.length) {
      egress = true;
      await startEgress({
        jobId,
        runnerLabel,
        allowHosts: p.egress,
        image,
        ...(egressNetwork ? { egressNetwork } : {}),
      });
    }
    if (p.install) {
      const s = await step(p.install, user, workspace);
      const bad = broken("install", s);
      if (bad) return bad;
      if (s.exitCode !== 0)
        return {
          verification: result("error", p, null, `install failed with exit code ${s.exitCode}`),
          stopped: false,
        };
    }
    const s = await step(p.test, user, workspace);
    return (
      broken("test", s) ?? {
        verification: result(s.exitCode === 0 ? "passed" : "failed", p, s.exitCode),
        stopped: false,
      }
    );
  };

  let outcome: Omit<VerifyResult, "stopConfirmed">;
  try {
    outcome = await execute();
  } catch (err) {
    log("warn", "verification could not run", { jobId, error: errorMessage(err) });
    outcome = {
      verification: result("error", p, null, `verification could not run: ${errorMessage(err)}`),
      stopped: false,
    };
  }
  // --rm normally removed it; this confirms. The proxy goes only once the job container is gone.
  if (!(await removeContainer(container, killGraceMs))) stopConfirmed = false;
  if (egress && stopConfirmed) {
    const { removed, denied } = await stopEgress(jobId);
    if (!removed) log("error", "verification egress proxy or network could not be removed", { jobId });
    for (const target of denied)
      onEvent("tool.denied", { kind: "egress", phase: "verify", target: redact(target) });
  }
  if (dir)
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
      log("warn", "verification dir cleanup failed", { jobId, error: errorMessage(err) }),
    );
  return { ...outcome, stopConfirmed };
}

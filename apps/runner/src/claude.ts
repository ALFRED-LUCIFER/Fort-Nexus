import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { RunEventType } from "@nexus/contracts";
import { z } from "zod";
import { AI_CONFIG_FILE, AiConfigError, loadAiProvider, type AiProvider } from "./ai-config.ts";
import { errorMessage, log as defaultLog, type Log } from "./log.ts";
import { OutputBuffer, redact } from "./output.ts";
import {
  PROXY_URL,
  SANDBOX_BUILD_COMMAND,
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

// Claude coding engine (ENG-05): one Agent SDK run inside the per-job sandbox against a prepared
// worktree, streamed as run events, with budgets enforced and egress limited to the model provider.

/** Tools the agent may use; the in-container entrypoint enforces the same ceiling. Never widened by task text. */
export const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] as const;
const AGENT_ARGV = ["nexus-agent", "/workspace/task.json"] as const;
const REPO = "/workspace/repo";
const MAX_LINE = 4 * 1024 * 1024;
const TEXT_MAX = 2_000;
const SUMMARY_MAX = 200;
const MAX_FILES = 500;

export const ClaudeBudget = z.strictObject({
  maxWallClockMs: z
    .int()
    .min(1_000)
    .max(6 * 3_600_000),
  maxTurns: z.int().min(1).max(500),
  maxCostUsd: z.number().positive().max(1_000),
});
export type ClaudeBudget = z.infer<typeof ClaudeBudget>;

export type EmitEvent = (type: RunEventType, payload: Record<string, unknown>) => void;

export type AgentSummary = {
  subtype: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  /** The SDK's own price-table estimate, not a provider invoice (FR-OBS-03). */
  estimatedCostUsd: number;
};

export type Verdict =
  | { reason: "budget_exceeded"; budget: "cost" | "turns" | "wall_clock" }
  | { reason: "agent_failed"; subtype: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// The provider key is masked by exact value first, then the generic patterns run.
const scrubber = (secrets: readonly string[]) => (text: string) =>
  redact(secrets.reduce((t, s) => t.replaceAll(s, "[REDACTED]"), text));

// SDK messages come from inside the sandbox: untrusted input, parsed leniently and never trusted for policy.
const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  model: z.string(),
  tools: z.array(z.string()),
  permissionMode: z.string().optional(),
});
const Retry = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number(),
  error: z.string(),
  error_status: z.number().nullish(),
});
const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});
const Assistant = z.looseObject({
  type: z.literal("assistant"),
  error: z.string().optional(),
  message: z.looseObject({ content: z.array(ContentBlock) }),
});
const User = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]) }),
});
const Tokens = z.number().nonnegative().catch(0);
const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number(),
  duration_ms: z.number(),
  total_cost_usd: z.number().nonnegative(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  usage: z
    .looseObject({
      input_tokens: Tokens,
      output_tokens: Tokens,
      cache_read_input_tokens: Tokens,
      cache_creation_input_tokens: Tokens,
    })
    .optional(),
  modelUsage: z
    .record(
      z.string(),
      z.looseObject({
        inputTokens: Tokens,
        outputTokens: Tokens,
        cacheReadInputTokens: Tokens,
        cacheCreationInputTokens: Tokens,
      }),
    )
    .optional(),
});
const NexusError = z.looseObject({ type: z.literal("nexus_error"), message: z.string() });

const relPath = (p: unknown) =>
  typeof p !== "string" ? "" : p.startsWith(`${REPO}/`) ? p.slice(REPO.length + 1) : p;

// What the tool acts on, never file contents (Write content, Edit old/new strings stay out).
function toolTarget(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return relPath(input.file_path);
    case "Glob":
    case "Grep":
      return `${String(input.pattern ?? "")}${input.path ? ` in ${relPath(input.path)}` : ""}`;
    case "Bash":
      return String(input.command ?? "");
    default:
      return "";
  }
}

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : "")).join("\n")
      : "";

/**
 * Maps the entrypoint's NDJSON stream (one SDK message per line) to run events and decides budget
 * verdicts as results arrive. Pure: no I/O, so it is tested from recorded fixtures.
 */
export function agentStream(opts: {
  maxCostUsd: number;
  secrets: readonly string[];
  started?: Record<string, unknown>;
}) {
  const scrub = scrubber(opts.secrets);
  const toolNames = new Map<string, string>();
  let summary: AgentSummary | undefined;
  let verdict: Verdict | undefined;

  const push = (line: string): { type: RunEventType; payload: Record<string, unknown> }[] => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return [{ type: "process.output", payload: { stream: "stdout", text: clip(scrub(line), TEXT_MAX) } }];
    }
    const init = Init.safeParse(msg);
    if (init.success)
      return [
        {
          type: "agent.started",
          payload: {
            engine: "claude-agent-sdk",
            ...opts.started,
            model: clip(scrub(init.data.model), 128),
            tools: init.data.tools.slice(0, 50).map((t) => clip(scrub(t), 64)),
            permissionMode: init.data.permissionMode,
          },
        },
      ];
    const retry = Retry.safeParse(msg);
    if (retry.success)
      return [
        {
          type: "agent.message",
          payload: {
            kind: "api_retry",
            attempt: retry.data.attempt,
            error: clip(scrub(retry.data.error), 64),
            status: retry.data.error_status ?? null,
          },
        },
      ];
    const assistant = Assistant.safeParse(msg);
    if (assistant.success) {
      const events: { type: RunEventType; payload: Record<string, unknown> }[] = [];
      if (assistant.data.error)
        events.push({
          type: "agent.message",
          payload: { kind: "error", error: clip(scrub(assistant.data.error), 64) },
        });
      for (const block of assistant.data.message.content) {
        if (block.type === "text" && block.text)
          events.push({
            type: "agent.message",
            payload: { kind: "text", text: clip(scrub(block.text), TEXT_MAX) },
          });
        if (block.type === "tool_use" && block.id && block.name) {
          const tool = clip(block.name, 64);
          toolNames.set(block.id, tool);
          events.push({
            type: "tool.requested",
            payload: {
              toolUseId: clip(block.id, 64),
              tool,
              summary: clip(scrub(toolTarget(block.name, block.input ?? {})), SUMMARY_MAX),
            },
          });
        }
      }
      return events;
    }
    const user = User.safeParse(msg);
    if (user.success) {
      const blocks = typeof user.data.message.content === "string" ? [] : user.data.message.content;
      return blocks
        .filter((b) => b.type === "tool_result" && b.tool_use_id)
        .map((b) => ({
          type: "tool.completed" as const,
          payload: {
            toolUseId: clip(b.tool_use_id ?? "", 64),
            tool: toolNames.get(b.tool_use_id ?? "") ?? null,
            isError: b.is_error === true,
            // Errors only, short and redacted: successful results may be file contents.
            ...(b.is_error ? { error: clip(scrub(resultText(b.content)), SUMMARY_MAX) } : {}),
          },
        }));
    }
    const result = Result.safeParse(msg);
    if (result.success) {
      const r = result.data;
      const models = Object.values(r.modelUsage ?? {});
      const sum = (k: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens") =>
        models.reduce((n, m) => n + m[k], 0);
      summary = {
        subtype: clip(r.subtype, 64),
        isError: r.is_error,
        turns: r.num_turns,
        durationMs: r.duration_ms,
        usage: models.length
          ? {
              inputTokens: sum("inputTokens"),
              outputTokens: sum("outputTokens"),
              cacheReadInputTokens: sum("cacheReadInputTokens"),
              cacheCreationInputTokens: sum("cacheCreationInputTokens"),
            }
          : {
              inputTokens: r.usage?.input_tokens ?? 0,
              outputTokens: r.usage?.output_tokens ?? 0,
              cacheReadInputTokens: r.usage?.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: r.usage?.cache_creation_input_tokens ?? 0,
            },
        estimatedCostUsd: r.total_cost_usd,
      };
      verdict ??=
        r.subtype === "error_max_budget_usd" || r.total_cost_usd > opts.maxCostUsd
          ? { reason: "budget_exceeded", budget: "cost" }
          : r.subtype === "error_max_turns"
            ? { reason: "budget_exceeded", budget: "turns" }
            : r.subtype !== "success" || r.is_error
              ? { reason: "agent_failed", subtype: summary.subtype }
              : undefined;
      const detail = r.is_error ? (r.errors?.join("\n") ?? r.result ?? "") : (r.result ?? "");
      return [
        {
          type: "agent.message",
          payload: {
            kind: "summary",
            ...summary,
            costBasis: "sdk_estimate",
            ...(detail ? { text: clip(scrub(detail), TEXT_MAX) } : {}),
          },
        },
      ];
    }
    const err = NexusError.safeParse(msg);
    if (err.success) {
      verdict ??= { reason: "agent_failed", subtype: "entrypoint_error" };
      return [
        {
          type: "agent.message",
          payload: { kind: "error", error: clip(scrub(err.data.message), SUMMARY_MAX) },
        },
      ];
    }
    return []; // status, hooks, task progress, ...: not part of the run timeline
  };

  return {
    push,
    /** Set once a budget is exceeded or the agent reported failure; budget verdicts stop the container. */
    get verdict() {
      return verdict;
    },
    get summary() {
      return summary;
    },
    timeout() {
      verdict ??= { reason: "budget_exceeded", budget: "wall_clock" };
    },
  };
}

/**
 * Resolves the worktree's git dir from its `.git` file *before* the run: afterwards the file is
 * writable by the agent and must not decide which repository host-side git opens.
 */
export async function worktreeGitDir(worktreePath: string): Promise<string> {
  const dotGit = join(worktreePath, ".git");
  if (!(await lstat(dotGit)).isFile()) throw new Error("not a linked git worktree");
  const m = /^gitdir: (.+)\n?$/.exec(await readFile(dotGit, "utf8"));
  const gitDir = m?.[1];
  if (!gitDir || !isAbsolute(gitDir)) throw new Error("worktree .git does not point to an absolute git dir");
  const back = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
  if ((await realpath(back)) !== (await realpath(dotGit)))
    throw new Error("worktree and git dir do not match");
  return gitDir;
}

export type Artifacts = {
  files: { path: string; status: string }[];
  fileCount: number;
  truncated: boolean;
  diffStat: string;
};

/** Changed files and diff stat, host-side, with the trusted git dir and no repo-controlled config. */
export async function collectArtifacts(worktreePath: string, gitDir: string): Promise<Artifacts> {
  const g = (args: string[]) =>
    git([
      `--git-dir=${gitDir}`,
      `--work-tree=${worktreePath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${devNull}`,
      ...args,
    ]);
  const tracked = (await g(["diff", "--name-status", "-z", "--no-renames", "HEAD"]))
    .split("\0")
    .filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i + 1 < tracked.length; i += 2)
    files.push({ status: tracked[i] ?? "", path: tracked[i + 1] ?? "" });
  for (const path of (await g(["ls-files", "-z", "--others", "--exclude-standard"]))
    .split("\0")
    .filter(Boolean))
    files.push({ status: "?", path });
  const diffStat = await g(["diff", "--stat=120", "--no-ext-diff", "--no-textconv", "HEAD"]);
  return {
    files: files.slice(0, MAX_FILES),
    fileCount: files.length,
    truncated: files.length > MAX_FILES,
    diffStat,
  };
}

async function fileContains(path: string, needle: Buffer): Promise<boolean> {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    const buf = Buffer.concat([tail, chunk]);
    if (buf.includes(needle)) return true;
    tail = buf.subarray(Math.max(0, buf.length - needle.length + 1));
  }
  return false;
}

/** Changed regular files (inside the worktree, symlinks not followed) that contain a secret verbatim. */
export async function filesContaining(
  worktreePath: string,
  paths: readonly string[],
  secrets: readonly string[],
): Promise<string[]> {
  const root = await realpath(worktreePath);
  const hits: string[] = [];
  for (const path of paths) {
    const full = join(root, path);
    const st = await lstat(full).catch(() => undefined);
    if (!st?.isFile() || !(await realpath(full)).startsWith(root + sep)) continue;
    for (const s of secrets) if (await fileContains(full, Buffer.from(s))) hits.push(path);
  }
  return hits;
}

export type ClaudeTaskOptions = {
  jobId: string;
  /** A worktree from createWorkspaces().prepareWorktree, mounted read-write at /workspace/repo. */
  worktreePath: string;
  /** May contain untrusted issue text: it is data for the model, never policy. */
  prompt: string;
  budget: ClaudeBudget;
  onEvent: EmitEvent;
  /** Aborting stops the container (cancel, shutdown or a lost lease; the caller knows which). */
  signal?: AbortSignal;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  runnerLabel?: string;
  image?: string;
  aiConfigFile?: string;
  killGraceMs?: number;
  log?: Log;
  /** Test seam: the container command (default: the image's nexus-agent entrypoint). */
  agentArgv?: readonly [string, ...string[]];
};

export type ClaudeTaskResult = {
  /** STOPPED: the signal aborted the run and the container is confirmed gone. */
  status: "COMPLETED" | "FAILED" | "STOPPED";
  reason?: string;
  details?: Record<string, unknown>;
  outcome?: "TIMED_OUT";
  summary?: AgentSummary;
  artifacts?: Artifacts;
};

const Prompt = z.string().min(1).max(200_000);

export async function runClaudeTask(opts: ClaudeTaskOptions): Promise<ClaudeTaskResult> {
  const { jobId, worktreePath, onEvent, signal, runnerLabel = "local", image = SANDBOX_IMAGE } = opts;
  const { killGraceMs = 5_000, log = defaultLog, aiConfigFile = AI_CONFIG_FILE } = opts;
  const budget = ClaudeBudget.parse(opts.budget);
  const prompt = Prompt.parse(opts.prompt);
  const fail = (reason: string, details: Record<string, unknown> = {}): ClaudeTaskResult => ({
    status: "FAILED",
    reason,
    details,
  });

  let provider: AiProvider;
  try {
    provider = await loadAiProvider(aiConfigFile);
  } catch (err) {
    if (err instanceof AiConfigError) return fail(err.reason, { path: err.path, message: err.message });
    throw err;
  }
  const secrets = Object.values(provider.secretEnv);
  const scrub = scrubber(secrets);
  // Last line of defence: no payload leaves this module with the key in it.
  const emit: EmitEvent = (type, payload) =>
    onEvent(
      type,
      JSON.parse(secrets.reduce((t, s) => t.replaceAll(s, "[REDACTED]"), JSON.stringify(payload))),
    );

  const runtime = await detectRuntime().catch(() => undefined);
  if (!runtime) return fail("sandbox_unavailable", { message: "Docker is not reachable on the runner host" });
  if (!(await imageExists(image)))
    return fail("sandbox_image_missing", {
      image,
      message: `Sandbox image ${image} is missing on the runner host. Build it with: ${SANDBOX_BUILD_COMMAND}`,
    });
  let gitDir: string;
  try {
    gitDir = await worktreeGitDir(worktreePath);
  } catch (err) {
    return fail("worktree_invalid", { message: errorMessage(err) });
  }

  if (signal?.aborted) return { status: "STOPPED" };

  const container = containerName(jobId);
  const stream = agentStream({
    maxCostUsd: budget.maxCostUsd,
    secrets,
    started: {
      provider: provider.provider,
      egress: [provider.host],
      sandbox: { runtime, image, container, network: egressNames(jobId).network },
      budget,
    },
  });
  const output = new OutputBuffer(secrets);
  const drain = (final: boolean) => {
    for (const { stream: s, text } of output.drain(final)) emit("process.output", { stream: s, text });
  };

  const jobDir = await mkdtemp(join(tmpdir(), "nexus-claude-"));
  let stopping: Promise<boolean> | undefined;
  let stopped: "signal" | "budget" | undefined;
  let exitCode: number | null = null;
  let stopConfirmed = true;
  let egressRemoved = false;
  let denied: string[] = [];
  let startError: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  try {
    await writeFile(
      join(jobDir, "task.json"),
      JSON.stringify({
        prompt,
        model: provider.model,
        maxTurns: budget.maxTurns,
        maxBudgetUsd: budget.maxCostUsd,
        allowedTools: CLAUDE_TOOLS,
        ...(opts.effort ? { effort: opts.effort } : {}),
      }),
      { mode: 0o644 },
    );
    await mkdir(join(jobDir, "repo")); // mount point for the worktree inside the read-only /workspace
    await chmod(jobDir, 0o755);

    await startEgress({ jobId, runnerLabel, allowHosts: [provider.host], image });
    const args = dockerRunArgs({
      jobId,
      runnerLabel,
      workspace: jobDir,
      workspaceReadOnly: true,
      mounts: [{ source: worktreePath, target: REPO }],
      argv: opts.agentArgv ?? AGENT_ARGV,
      image,
      network: egressNames(jobId).network,
      user: writableUser(runtime),
      env: {
        ...provider.env,
        HTTPS_PROXY: PROXY_URL,
        https_proxy: PROXY_URL,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_AGENT_SDK_CLIENT_APP: "nexus-runner",
      },
      passEnv: Object.keys(provider.secretEnv),
    });
    log("info", "claude task starting", {
      jobId,
      provider: provider.provider,
      model: provider.model,
      container,
    });

    await new Promise<void>((done) => {
      const child = spawn("docker", args, {
        env: { ...dockerEnv(), ...provider.secretEnv },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<void>((res) => child.once("exit", () => res()));
      // The ENG-04 stop path: Docker must confirm the container is gone, then the client must exit.
      const stop = (why: "signal" | "budget") => {
        stopped ??= why;
        return (stopping ??= (async () => {
          for (let i = 0; i < 2; i++)
            if ((await removeContainer(container, killGraceMs)) && (await within(exited, 5_000))) return true;
          child.kill("SIGKILL");
          log("error", "claude job container could not be confirmed gone", { jobId, container });
          return false;
        })());
      };
      timer = setTimeout(() => {
        stream.timeout();
        void stop("budget");
      }, budget.maxWallClockMs);
      const onAbort = () => void stop("signal");
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let buf = "";
      let skipping = false;
      const onLine = (line: string) => {
        if (skipping) skipping = false;
        else if (line.trim()) {
          drain(false);
          for (const e of stream.push(line)) emit(e.type, e.payload);
          if (stream.verdict?.reason === "budget_exceeded") void stop("budget");
        }
      };
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        // shortcut: an over-long line (a huge tool result) is dropped whole, raise MAX_LINE if real runs hit it.
        if (buf.length > MAX_LINE) [buf, skipping] = ["", true];
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        output.write("stderr", text);
        if (output.shouldFlush) drain(false);
        else flushTimer ??= setTimeout(() => ((flushTimer = undefined), drain(false)), 250);
      });
      const finished = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        done();
      };
      child.on("error", (err) => {
        if (child.pid !== undefined) return log("warn", "docker client error", { jobId, error: err.message });
        startError = err.message;
        finished();
      });
      child.once("close", (code) => {
        onLine(buf);
        exitCode = code;
        finished();
      });
    });
    if (stopping) stopConfirmed = await stopping;
  } catch (err) {
    startError = errorMessage(err);
  } finally {
    clearTimeout(timer);
    clearTimeout(flushTimer);
    // --rm normally removed it already; this confirms (and stops it if the client died first).
    if (!(await removeContainer(container, killGraceMs))) stopConfirmed = false;
    if (stopConfirmed) ({ removed: egressRemoved, denied } = await stopEgress(jobId));
    if (stopConfirmed && !egressRemoved)
      log("error", "egress proxy or job network could not be removed", { jobId });
    await rm(jobDir, { recursive: true, force: true });
  }
  drain(true);
  for (const target of denied) emit("tool.denied", { kind: "egress", target: scrub(target) });

  const summary = stream.summary;
  // Never report anything as finished while a container may still be writing to the worktree.
  if (!stopConfirmed) return { ...fail("stop_failed", { container }), summary };

  let artifacts: Artifacts | undefined;
  let leaked: string[] = [];
  let artifactError: string | undefined;
  try {
    artifacts = await collectArtifacts(worktreePath, gitDir);
    leaked = await filesContaining(
      worktreePath,
      artifacts.files.filter((f) => f.status !== "D").map((f) => f.path),
      secrets,
    );
    emit("artifact.created", { kind: "diff", ...artifacts, secretLeak: leaked.length > 0 });
  } catch (err) {
    artifactError = errorMessage(err);
    log("warn", "collecting claude artifacts failed", { jobId, error: artifactError });
  }
  const done = (r: Omit<ClaudeTaskResult, "summary" | "artifacts">): ClaudeTaskResult => ({
    ...r,
    summary,
    artifacts,
  });

  // A leaked provider key in the worktree must never be committed or pushed.
  if (leaked.length) return done(fail("secret_leak_detected", { files: leaked }));
  if (stopped === "signal") return done({ status: "STOPPED" });
  const v = stream.verdict;
  if (v?.reason === "budget_exceeded")
    return done({
      ...fail(v.reason, { budget: v.budget }),
      ...(v.budget === "wall_clock" ? { outcome: "TIMED_OUT" } : {}),
    });
  if (startError) return done(fail("sandbox_failed", { message: scrub(startError) }));
  // Unscanned changes are never reported as a success.
  if (artifactError) return done(fail("artifacts_failed", { message: scrub(artifactError) }));
  if (v) return done(fail(v.reason, { subtype: v.subtype }));
  if (!summary) return done(fail(exitCode === 125 ? "sandbox_failed" : "agent_failed", { exitCode }));
  if (exitCode !== 0) return done(fail("agent_failed", { exitCode }));
  return done({ status: "COMPLETED" });
}

const within = (p: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });

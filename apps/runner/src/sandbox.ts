import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Bump together with the tag in package.json "sandbox:build" whenever infra/sandbox/Dockerfile changes.
export const SANDBOX_IMAGE = "nexus-sandbox:1";
export const SANDBOX_BUILD_COMMAND = "pnpm --filter @nexus/runner sandbox:build";
export const SANDBOX_USER = "10001:10001"; // the image's non-root `nexus` user

export type SandboxMode = "docker" | "none";
export type DockerRuntime = "docker-desktop" | "docker-rootless" | "docker-rootful";

export const containerName = (jobId: string) => `nexus-job-${jobId}`;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_VALUE = /^[\w.-]{1,64}$/;

export type DockerRunSpec = {
  jobId: string;
  runnerLabel: string;
  workspace: string;
  argv: readonly [string, ...string[]];
  image?: string;
};

// The full `docker run` argv for one job. Spawned without a shell; the workspace is the only mount.
export function dockerRunArgs({ jobId, runnerLabel, workspace, argv, image = SANDBOX_IMAGE }: DockerRunSpec) {
  if (!JOB_ID.test(jobId)) throw new Error("jobId must be a uuid");
  if (!LABEL_VALUE.test(runnerLabel)) throw new Error("invalid runner label");
  const ws = resolve(workspace);
  // `,` and `"` would let a path smuggle extra --mount options; / and $HOME must never be mounted.
  if (!isAbsolute(workspace) || /[,"\n]/.test(ws) || ws === "/" || ws === resolve(homedir()))
    throw new Error(`refusing to mount ${ws} as the job workspace`);
  return [
    "run",
    "--rm",
    "--name",
    containerName(jobId),
    "--label",
    `nexus.runner=${runnerLabel}`,
    "--label",
    `nexus.job=${jobId}`,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--user",
    SANDBOX_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "2",
    "--init", // PID 1 forwards SIGTERM, so `docker stop` ends the job instead of waiting for SIGKILL
    "--mount",
    `type=bind,source=${ws},target=/workspace`,
    "--env",
    "HOME=/tmp",
    "--workdir",
    "/workspace",
    image,
    ...argv,
  ];
}

// The docker CLI is the runner's own tool: it gets only what it needs to find the daemon.
// None of this reaches the container (only explicit --env values do).
export const dockerEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]]),
  );

export type DockerResult = { ok: boolean; stdout: string; stderr: string };

export const docker = (args: string[], timeoutMs = 30_000): Promise<DockerResult> =>
  new Promise((done) =>
    execFile("docker", args, { env: dockerEnv(), timeout: timeoutMs }, (err, stdout, stderr) =>
      done({ ok: !err, stdout, stderr: stderr || (err ? err.message : "") }),
    ),
  );

/** Which Docker this is, or throws when the daemon is unreachable. */
export async function detectRuntime(): Promise<DockerRuntime> {
  const r = await docker(["info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"]);
  if (!r.ok) throw new Error(`docker is not reachable: ${r.stderr.trim()}`);
  if (r.stdout.includes("name=rootless")) return "docker-rootless";
  // Docker Desktop runs containers inside its own Linux VM, not on the host kernel.
  if (r.stdout.startsWith("Docker Desktop")) return "docker-desktop";
  return "docker-rootful";
}

export const imageExists = async (image: string) => (await docker(["image", "inspect", image])).ok;

const isGone = async (name: string) => {
  const r = await docker(["container", "inspect", name]);
  return !r.ok && /no such (container|object)/i.test(r.stderr);
};

/**
 * Stops a job container (`docker stop -t`, then `docker kill`, then forced removal) and returns true
 * only once Docker confirms it no longer exists. False means "could not confirm", never "probably gone".
 */
export async function removeContainer(name: string, graceMs = 5_000): Promise<boolean> {
  if (await isGone(name)) return true;
  await docker(["stop", "-t", String(Math.ceil(graceMs / 1000)), name], graceMs + 30_000);
  if (await isGone(name)) return true;
  await docker(["kill", name]);
  await docker(["rm", "-f", name]);
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    if (await isGone(name)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Crash cleanup: removes every container this runner left behind. Returns the removed names. */
export async function removeLeftovers(runnerLabel: string): Promise<string[]> {
  const r = await docker([
    "ps",
    "-a",
    "--filter",
    `label=nexus.runner=${runnerLabel}`,
    "--format",
    "{{.Names}}",
  ]);
  if (!r.ok) throw new Error(`docker ps failed: ${r.stderr.trim()}`);
  const names = r.stdout.split("\n").filter(Boolean);
  const results = await Promise.all(names.map((n) => removeContainer(n, 0)));
  const stuck = names.filter((_, i) => !results[i]);
  if (stuck.length) throw new Error(`could not remove leftover containers: ${stuck.join(", ")}`);
  return names;
}

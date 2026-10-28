import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { isAbsolute, resolve } from "node:path";

// Bump together with the tag in package.json "sandbox:build" whenever infra/sandbox/Dockerfile changes.
export const SANDBOX_IMAGE = "nexus-sandbox:2";
export const SANDBOX_BUILD_COMMAND = "pnpm --filter @nexus/runner sandbox:build";
export const SANDBOX_USER = "10001:10001"; // the image's non-root `nexus` user

export type SandboxMode = "docker" | "none";
export type DockerRuntime = "docker-desktop" | "docker-rootless" | "docker-rootful";

export const containerName = (jobId: string) => `nexus-job-${jobId}`;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_VALUE = /^[\w.-]{1,64}$/;

export type Mount = { source: string; target: string; readOnly?: boolean };

export type DockerRunSpec = {
  jobId: string;
  runnerLabel: string;
  workspace: string;
  argv: readonly [string, ...string[]];
  image?: string;
  workspaceReadOnly?: boolean;
  /** Extra bind mounts below /workspace (e.g. the worktree at /workspace/repo). */
  mounts?: readonly Mount[];
  /** Defaults to "none": no network at all. */
  network?: string;
  /** Defaults to the image's nexus user; see writableUser() for bind-mounted worktrees. */
  user?: string;
  /** Plain values, visible in argv and `docker inspect`: never secrets. */
  env?: Readonly<Record<string, string>>;
  /** Names only: docker copies the value from its own environment, so secrets stay out of argv. */
  passEnv?: readonly string[];
  /** Defaults to /workspace; must be /workspace or below it. */
  workdir?: string;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MOUNT_TARGET = /^\/workspace\/[\w.-]+(\/[\w.-]+)*$/;

const bindMount = (source: string, target: string, readOnly = false) => {
  const src = resolve(source);
  // `,` and `"` would let a path smuggle extra --mount options; / and $HOME must never be mounted.
  if (!isAbsolute(source) || /[,"\n]/.test(src) || src === "/" || src === resolve(homedir()))
    throw new Error(`refusing to mount ${src} as the job workspace`);
  if (target !== "/workspace" && (!MOUNT_TARGET.test(target) || target.split("/").includes("..")))
    throw new Error(`invalid mount target ${target}`);
  return ["--mount", `type=bind,source=${src},target=${target}${readOnly ? ",readonly" : ""}`];
};

// The full `docker run` argv for one job. Spawned without a shell; only the given paths are mounted.
export function dockerRunArgs(spec: DockerRunSpec) {
  const { jobId, runnerLabel, workspace, argv, image = SANDBOX_IMAGE } = spec;
  const { network = "none", user = SANDBOX_USER, env = {}, passEnv = [], mounts = [] } = spec;
  const { workdir = "/workspace" } = spec;
  if (!JOB_ID.test(jobId)) throw new Error("jobId must be a uuid");
  if (!LABEL_VALUE.test(runnerLabel)) throw new Error("invalid runner label");
  if (!LABEL_VALUE.test(network)) throw new Error("invalid network name");
  if (!/^\d{1,10}:\d{1,10}$/.test(user)) throw new Error("user must be uid:gid");
  const names = [...Object.keys(env), ...passEnv];
  if (!names.every((n) => ENV_NAME.test(n))) throw new Error("invalid env name");
  if (workdir !== "/workspace" && (!MOUNT_TARGET.test(workdir) || workdir.split("/").includes("..")))
    throw new Error(`invalid workdir ${workdir}`);
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
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--user",
    user,
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
    ...bindMount(workspace, "/workspace", spec.workspaceReadOnly),
    ...mounts.flatMap((m) => bindMount(m.source, m.target, m.readOnly)),
    "--env",
    "HOME=/tmp",
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...passEnv.flatMap((k) => ["--env", k]),
    "--workdir",
    workdir,
    image,
    ...argv,
  ];
}

/**
 * The container user that can write a bind-mounted worktree owned by the runner's host user.
 * Rootless: container root *is* the unprivileged host user (and holds no capabilities here).
 * Rootful Linux: run as the host uid:gid. Docker Desktop: its file sharing writes as the host user.
 */
export function writableUser(runtime: DockerRuntime, uid = process.getuid?.(), gid = process.getgid?.()) {
  if (runtime === "docker-rootless") return "0:0";
  // A root runner on rootful Docker would make the job real root: keep the nexus user (writes then fail visibly).
  if (runtime === "docker-rootful" && uid !== undefined && gid !== undefined && uid !== 0)
    return `${uid}:${gid}`;
  return SANDBOX_USER;
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
  // Job networks (egress) go last: Docker refuses to remove a network a container is still attached to.
  const n = await docker([
    "network",
    "ls",
    "--filter",
    `label=nexus.runner=${runnerLabel}`,
    "--format",
    "{{.Name}}",
  ]);
  if (!n.ok) throw new Error(`docker network ls failed: ${n.stderr.trim()}`);
  const networks = n.stdout.split("\n").filter(Boolean);
  for (const net of networks) {
    const rm = await docker(["network", "rm", net]);
    if (!rm.ok && !/not found/i.test(rm.stderr)) throw new Error(`could not remove leftover network ${net}`);
  }
  return [...names, ...networks];
}

// Per-job egress (DEV-G07, FR-SEC-04). The job container joins only an --internal network (no route out);
// the proxy container is the only other member and the only one also on an egress network. It tunnels
// HTTPS CONNECT to the allowlisted hosts and refuses everything else (infra/sandbox/agent/nexus-proxy.mjs).
export const PROXY_URL = "http://nexus-proxy:3128";
export const egressNames = (jobId: string) => ({
  network: `nexus-net-${jobId}`,
  proxy: `nexus-proxy-${jobId}`,
});
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type EgressSpec = {
  jobId: string;
  runnerLabel: string;
  /** Hostnames reachable on port 443, nothing else. */
  allowHosts: readonly string[];
  image?: string;
  /** Where the proxy's own traffic leaves; "bridge" is Docker's default NAT network. */
  egressNetwork?: string;
};

/** Creates the job's internal network and starts its allowlisting proxy. Pair with stopEgress, also on failure. */
export async function startEgress(spec: EgressSpec): Promise<void> {
  const { jobId, runnerLabel, allowHosts, image = SANDBOX_IMAGE, egressNetwork = "bridge" } = spec;
  if (!JOB_ID.test(jobId)) throw new Error("jobId must be a uuid");
  if (!LABEL_VALUE.test(runnerLabel) || !LABEL_VALUE.test(egressNetwork)) throw new Error("invalid label");
  if (allowHosts.length === 0 || !allowHosts.every((h) => HOSTNAME.test(h)))
    throw new Error("egress allowlist must be lowercase hostnames");
  const { network, proxy } = egressNames(jobId);
  const labels = ["--label", `nexus.runner=${runnerLabel}`, "--label", `nexus.job=${jobId}`];
  const must = async (args: string[]) => {
    const r = await docker(args);
    if (!r.ok) throw new Error(`docker ${args[0]} ${args[1]} failed: ${r.stderr.trim()}`);
  };
  await must(["network", "create", "--internal", ...labels, network]);
  await must([
    "create",
    "--name",
    proxy,
    ...labels,
    "--pull",
    "never",
    "--network",
    network,
    "--network-alias",
    "nexus-proxy",
    "--read-only",
    "--user",
    SANDBOX_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--init",
    "--env",
    `NEXUS_PROXY_ALLOW=${allowHosts.map((h) => `${h}:443`).join(",")}`,
    image,
    "node",
    "/opt/nexus/nexus-proxy.mjs",
  ]);
  await must(["network", "connect", egressNetwork, proxy]);
  await must(["start", proxy]);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(100))
    if ((await docker(["logs", proxy])).stdout.includes('"decision":"listening"')) return;
  throw new Error("egress proxy did not start listening");
}

/**
 * Removes the proxy and the job network (call after the job container is gone). `removed` is true only
 * once Docker confirms both are gone; `denied` lists the targets the proxy refused (for the audit trail).
 */
export async function stopEgress(jobId: string): Promise<{ removed: boolean; denied: string[] }> {
  const { network, proxy } = egressNames(jobId);
  const logs = await docker(["logs", proxy]);
  const denied = logs.stdout
    .split("\n")
    .flatMap((line) => {
      try {
        const e = JSON.parse(line) as { decision?: unknown; target?: unknown };
        return e.decision === "deny" && typeof e.target === "string" ? [e.target.slice(0, 255)] : [];
      } catch {
        return [];
      }
    })
    .slice(0, 100);
  const proxyGone = await removeContainer(proxy, 0);
  const rm = await docker(["network", "rm", network]);
  return { removed: proxyGone && (rm.ok || /not found/i.test(rm.stderr)), denied };
}

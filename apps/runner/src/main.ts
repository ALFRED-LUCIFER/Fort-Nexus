import { createHash } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { createApi } from "./api.ts";
import { loadConfig, readToken, writeToken } from "./config.ts";
import { errorMessage, log } from "./log.ts";
import { startRunner } from "./runner.ts";
import { removeLeftovers } from "./sandbox.ts";

const USAGE = "usage: node src/main.ts pair --code <CODE> [--name <name>] | node src/main.ts start";

async function pair(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { code: { type: "string" }, name: { type: "string" } },
    strict: true,
  });
  if (!values.code) throw new Error(`--code is required\n${USAGE}`);
  const config = loadConfig();
  const api = createApi({ baseUrl: config.NEXUS_API_URL });
  const res = await api.register({
    code: values.code,
    name: values.name ?? (hostname().slice(0, 64) || "nexus-runner"),
    os: `${platform()}-${arch()} ${release()}`.slice(0, 64),
    version: pkg.version,
    capacity: 1,
  });
  await writeToken(config.RUNNER_TOKEN_FILE, res.token);
  log("info", "runner paired", { runnerId: res.runnerId, tokenFile: config.RUNNER_TOKEN_FILE });
}

async function start(): Promise<void> {
  const config = loadConfig();
  const token = await readToken(config.RUNNER_TOKEN_FILE).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ENOENT" ? new Error(`${config.RUNNER_TOKEN_FILE} not found; run "pair" first`) : err;
  });
  // Stable per runner install (one token file each), so cleanup never touches another runner's containers.
  const runnerLabel = createHash("sha256").update(config.RUNNER_TOKEN_FILE).digest("hex").slice(0, 16);
  if (config.RUNNER_SANDBOX === "none") {
    log(
      "warn",
      "!!! RUNNER_SANDBOX=none: jobs run directly on this host WITHOUT any isolation. Dev/test only !!!",
    );
  } else {
    // Containers left by a crashed run are killed before any new lease (their expired leases put those jobs in RECOVERY_REQUIRED).
    await removeLeftovers(runnerLabel).then(
      (removed) => log("info", "crash cleanup done", { removedContainers: removed }),
      (err: unknown) =>
        log("warn", "crash cleanup failed, jobs will fail until Docker is reachable", {
          error: errorMessage(err),
        }),
    );
  }
  const runner = startRunner(createApi({ baseUrl: config.NEXUS_API_URL, token }), {
    sandbox: config.RUNNER_SANDBOX,
    runnerLabel,
  });
  log("info", "runner started", {
    api: config.NEXUS_API_URL,
    version: pkg.version,
    sandbox: config.RUNNER_SANDBOX,
  });
  // `once`: a second signal falls through to Node's default and exits immediately.
  const onSignal = (signal: NodeJS.Signals) => {
    log("info", "shutting down (send the signal again to force)", { signal });
    void runner.stop().catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await runner.done;
  log("info", "runner stopped");
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "pair") await pair(args);
  else if (command === "start") await start();
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  log("error", err instanceof z.ZodError ? z.prettifyError(err) : errorMessage(err));
  process.exitCode = 1;
}

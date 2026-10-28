import { arch, hostname, platform, release } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { createApi } from "./api.ts";
import { loadConfig, readToken, writeToken } from "./config.ts";
import { errorMessage, log } from "./log.ts";
import { startRunner } from "./runner.ts";

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
  const runner = startRunner(createApi({ baseUrl: config.NEXUS_API_URL, token }));
  log("info", "runner started", { api: config.NEXUS_API_URL, version: pkg.version });
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

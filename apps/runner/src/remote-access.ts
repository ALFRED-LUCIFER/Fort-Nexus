import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import { RemoteAccessReport, type RemoteAccessDevice, type RemoteAccessState } from "@nexus/contracts";

// Settings → Remote access: what Tailscale says on this machine. Read-only: only ever `status` and `serve status`.
const BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] as const;
const STATUS_ARGV = ["status", "--json"] as const;
const SERVE_ARGV = ["serve", "status", "--json"] as const;
const MAX_DEVICES = 64;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

// Tailscale's JSON is external input: only the fields used here are read and everything else is ignored, so
// addresses, keys and account details never enter the runner's report.
const Node = z.looseObject({
  HostName: z.string().nullish(),
  DNSName: z.string().nullish(),
  OS: z.string().nullish(),
  Online: z.boolean().nullish(),
});
type Node = z.infer<typeof Node>;
const Status = z.looseObject({
  BackendState: z.string(),
  Self: Node.nullish(),
  Peer: z.record(z.string(), Node).nullish(),
});
const Serve = z
  .looseObject({
    Web: z
      .record(
        z.string(),
        z.looseObject({
          Handlers: z.record(z.string(), z.looseObject({ Proxy: z.string().nullish() })).nullish(),
        }),
      )
      .nullish(),
    AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
  })
  .nullable();

const emptyReport = (state: RemoteAccessState): RemoteAccessReport => ({
  state,
  url: null,
  serving: false,
  funnel: false,
  devices: [],
});

const stateOf = (backend: string): RemoteAccessState =>
  backend === "Running"
    ? "RUNNING"
    : backend === "NeedsLogin" || backend === "NeedsMachineAuth"
      ? "NEEDS_LOGIN"
      : "STOPPED";

function proxiesToApi(proxy: string, apiPort: number): boolean {
  try {
    const target = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    return LOOPBACK.has(target.hostname) && Number(port) === apiPort;
  } catch {
    return false;
  }
}

// The iPad reports HostName "localhost", so the MagicDNS label comes first. A nameless or address-only entry is left out.
function toDevice(node: Node, self: boolean): RemoteAccessDevice[] {
  const name = (node.DNSName?.split(".")[0] || node.HostName || "").slice(0, 128);
  if (!name || isIP(name)) return [];
  return [{ name, os: (node.OS ?? "").slice(0, 32), online: node.Online === true, self }];
}

/** Never throws: anything that isn't the Tailscale output we expect is UNAVAILABLE, including a report the API would refuse. */
export function parseRemoteAccess(
  statusJson: string,
  serveJson: string,
  apiPort: number,
): RemoteAccessReport {
  try {
    const status = Status.parse(JSON.parse(statusJson));
    const serve = Serve.parse(JSON.parse(serveJson));
    const web = Object.entries(serve?.Web ?? {});
    const nexus = web.find(([, entry]) =>
      Object.values(entry.Handlers ?? {}).some((h) => h.Proxy && proxiesToApi(h.Proxy, apiPort)),
    );
    const host = (nexus ?? web[0])?.[0];
    const peers = Object.values(status.Peer ?? {})
      .flatMap((peer) => toDevice(peer, false))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return RemoteAccessReport.parse({
      state: stateOf(status.BackendState),
      url: host ? `https://${host.replace(/:443$/, "")}` : null,
      serving: nexus !== undefined,
      funnel: Object.values(serve?.AllowFunnel ?? {}).some(Boolean),
      devices: [...(status.Self ? toDevice(status.Self, true) : []), ...peers].slice(0, MAX_DEVICES),
    });
  } catch {
    return emptyReport("UNAVAILABLE");
  }
}

type ExecOptions = {
  shell: false;
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};
export type Exec = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const realExec: Exec = (file, args, options) =>
  execFileAsync(file, [...args], { ...options, encoding: "utf8" });

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** The port the runner reaches NEXUS on (NEXUS_API_URL), which is the one Tailscale Serve must forward to. */
export function apiPortOf(apiUrl: string): number {
  const url = new URL(apiUrl);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** Asks Tailscale on this machine. Never throws, and its output is never logged. */
export async function collectRemoteAccess(
  apiPort: number,
  { exec = realExec, signal }: { exec?: Exec; signal?: AbortSignal } = {},
): Promise<RemoteAccessReport> {
  const options: ExecOptions = {
    shell: false,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL",
    // TERM is required: without it the macOS app binary tries to open its GUI, prints an error and exits 0. A launchd
    // service has no TERM of its own. The runner's other variables are none of Tailscale's business.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "dumb" },
    ...(signal ? { signal } : {}),
  };
  try {
    for (const binary of BINARIES) {
      let status: string;
      try {
        ({ stdout: status } = await exec(binary, STATUS_ARGV, options));
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const { stdout: serve } = await exec(binary, SERVE_ARGV, options);
      return parseRemoteAccess(status, serve, apiPort);
    }
    return emptyReport("NOT_INSTALLED");
  } catch {
    return emptyReport("UNAVAILABLE");
  }
}

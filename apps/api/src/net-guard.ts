import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";

// SSRF guard shared by every outbound fetch to an owner- or model-chosen host (FR-MON-02, FR-RES-12): the host is
// resolved once, every address is vetted, and the socket connects to the vetted address, so a DNS rebind between the
// check and the connect can't swap it.

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
export type GuardOptions = {
  /** Test seam only: production resolves with the system resolver. */
  resolve?: Resolve;
  /** Test seam only: production always uses BLOCKED. */
  blocked?: BlockList;
  /** Test seam only: extra trusted CA (PEM) for a local TLS server. */
  ca?: string;
};

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved and v4-embedding v6 ranges. */
export const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 metadata)
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv6");

// IPv4-mapped v6 (::ffff:0:0/96) is refused outright, but from its own list: BlockList checks every IPv4 address
// against that rule in its mapped form, so inside BLOCKED it would refuse all of IPv4.
const MAPPED = new BlockList();
MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/** true for anything that isn't a public IP literal (a name, garbage, a blocked range, an IPv4-mapped v6). */
export function isBlocked(address: string, blocked: BlockList = BLOCKED): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && MAPPED.check(address, "ipv6")) return true;
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The system resolver: every A/AAAA record, in resolver order. */
export const resolveAll: Resolve = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves `host` once and returns the address to connect to, or null when nothing resolves or ANY address is
 * blocked (one private record is enough to refuse). IP literals are vetted without a lookup. Resolver failures
 * (NXDOMAIN, timeouts) reject, so callers can tell "doesn't resolve" from "refused".
 */
export async function vetHost(
  host: string,
  opts: { resolve?: Resolve; blocked?: BlockList } = {},
): Promise<{ address: string; family: 4 | 6 } | null> {
  const name = host.replace(/^\[(.*)\]$/, "$1"); // IPv6 literals come bracketed
  const literal = isIP(name);
  const addresses = literal ? [{ address: name, family: literal }] : await (opts.resolve ?? resolveAll)(name);
  if (addresses.length === 0 || addresses.some((a) => isBlocked(a.address, opts.blocked))) return null;
  const first = addresses[0]!;
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/** The connect error for a refused host; fetch surfaces it as `err.cause`. */
export class BlockedHostError extends Error {
  readonly code = "ERR_NEXUS_BLOCKED_HOST";
  constructor(host: string) {
    super(`${host} resolves to a private, loopback, link-local or reserved address`);
    this.name = "BlockedHostError";
  }
}

export const isBlockedHostError = (err: unknown): err is BlockedHostError =>
  err instanceof Error && (err as { code?: unknown }).code === "ERR_NEXUS_BLOCKED_HOST";

/** What global `fetch` takes as `init.dispatcher`. */
export type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

/**
 * An undici dispatcher for `fetch(url, { dispatcher })` whose every new connection (first hop, each redirect hop,
 * robots.txt) is vetted by `vetHost` and dialled to the vetted address; SNI and the Host header keep the name.
 */
export function guardedAgent(opts: GuardOptions & { connectTimeoutMs?: number } = {}): FetchDispatcher {
  const dial = buildConnector({ ca: opts.ca, timeout: opts.connectTimeoutMs ?? 10_000 });
  const connect: buildConnector.connector = (o, callback) => {
    vetHost(o.hostname, opts).then(
      (vetted) => {
        if (!vetted) return callback(new BlockedHostError(o.hostname), null);
        // `host` (name:port) still drives SNI and the session cache; only the dialled address is pinned.
        dial({ ...o, hostname: vetted.address }, callback);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error("DNS lookup failed"), null),
    );
  };
  const agent = new Agent({ connect, keepAliveTimeout: 1_000, keepAliveMaxTimeout: 5_000 });
  // The undici dependency is pinned to the major Node 24 bundles for `fetch` (the dispatch protocol both speak);
  // @types/node describes it with newer undici-types, so the static types differ. The TLS test in research-web.test.ts
  // drives real requests through this agent, so a runtime mismatch fails CI.
  return agent as unknown as FetchDispatcher;
}

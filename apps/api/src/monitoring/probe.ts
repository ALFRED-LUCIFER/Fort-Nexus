import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { CheckError } from "@nexus/contracts";

// FR-MON-02: one bounded HTTPS GET per check. SSRF guard: the host is resolved once here, every address is vetted,
// and the socket connects to the vetted address (SNI and Host keep the name), so a DNS rebind can't swap it.
export const USER_AGENT = "NEXUS-Monitor/1.0 (self-hosted health check)";
const MAX_BODY = 64 * 1024;

export type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type ProbeResult = {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: CheckError | null;
};
export type ProbeOptions = {
  resolve?: Resolve;
  /** Test seam only: production always uses BLOCKED. */
  blocked?: BlockList;
  /** Test seam only: extra trusted CA (PEM) for a local TLS server. */
  ca?: string;
  /** API shutdown: the probe throws instead of reporting a failure the app didn't cause. */
  signal?: AbortSignal;
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
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 metadata)
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv6");

export const isBlocked = (address: string, blocked = BLOCKED) => {
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 6 ? "ipv6" : "ipv4");
};

const resolveAll: Resolve = (host) => lookup(host, { all: true, verbatim: true });

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/;

export async function probe(url: URL, timeoutMs: number, opts: ProbeOptions = {}): Promise<ProbeResult> {
  opts.signal?.throwIfAborted();
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const fail = (error: CheckError): ProbeResult => ({ ok: false, statusCode: null, latencyMs: null, error });
  if (url.protocol !== "https:" || url.username || url.password) return fail("BLOCKED_TARGET");

  const host = url.hostname.replace(/^\[(.*)\]$/, "$1"); // IPv6 literals come bracketed
  let addresses: Awaited<ReturnType<Resolve>>;
  try {
    addresses = await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      (opts.resolve ?? resolveAll)(host).then(resolve, reject);
    });
  } catch {
    opts.signal?.throwIfAborted();
    return fail(timeout.aborted ? "TIMEOUT" : "DNS");
  }
  if (addresses.length === 0) return fail("DNS");
  if (addresses.some((a) => isBlocked(a.address, opts.blocked))) return fail("BLOCKED_TARGET");
  const target = addresses[0]!;

  return new Promise<ProbeResult>((resolve, reject) => {
    let settled = false;
    const finish = (r: ProbeResult | Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const req = request(
      {
        host: target.address, // connect to the vetted address; no second lookup
        family: target.family,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        servername: isIP(host) ? undefined : host,
        headers: { host: url.host, "user-agent": USER_AGENT, accept: "*/*" },
        agent: false, // no pooled sockets, no cookies, no credentials
        ca: opts.ca,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const result: ProbeResult =
          status >= 200 && status < 300
            ? { ok: true, statusCode: status, latencyMs: null, error: null }
            : {
                ok: false,
                statusCode: status,
                latencyMs: null,
                error: status >= 300 && status < 400 ? "REDIRECT" : "HTTP_STATUS",
              };
        const done = () => finish({ ...result, latencyMs: latency() });
        if (!result.ok) return done(); // redirects are never followed; failing bodies aren't read
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read >= MAX_BODY) done();
        });
        res.on("end", done);
        res.on("error", (err) => onError(err));
      },
    );
    const onError = (err: NodeJS.ErrnoException) => {
      if (opts.signal?.aborted) return finish(opts.signal.reason as Error);
      if (timeout.aborted) return finish(fail("TIMEOUT"));
      finish(fail(TLS_CODES.test(err.code ?? "") ? "TLS" : "CONNECT"));
    };
    req.on("error", onError);
    req.end();
  });
}

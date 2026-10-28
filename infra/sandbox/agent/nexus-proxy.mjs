#!/usr/bin/env node
// Egress allowlist proxy (DEV-G07, FR-SEC-04). Runs in its own container, the only one on the job's
// internal Docker network that also has a route out. Allows HTTPS CONNECT to exactly the hosts in
// NEXUS_PROXY_ALLOW ("host:443,..."), refuses everything else, and logs one JSON line per decision.
import { createServer } from "node:http";
import { connect } from "node:net";

const PORT = 3128;
const allow = new Set(
  (process.env.NEXUS_PROXY_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const log = (decision, target) =>
  process.stdout.write(`${JSON.stringify({ decision, target: String(target).slice(0, 255) })}\n`);

const server = createServer((req, res) => {
  // Plain-HTTP forwarding would bypass TLS to the provider: never.
  log("deny", req.url);
  res.writeHead(403).end();
});

server.on("connect", (req, client, head) => {
  const target = String(req.url).toLowerCase();
  const m = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (!m || !allow.has(target)) {
    log("deny", req.url);
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log("allow", target);
  const upstream = connect(Number(m[2]), m[1], () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () =>
    upstream.connecting ? client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n") : client.destroy(),
  );
  client.on("error", () => upstream.destroy());
});

server.listen(PORT, () => log("listening", PORT));

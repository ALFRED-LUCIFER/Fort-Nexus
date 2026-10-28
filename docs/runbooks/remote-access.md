# Runbook: remote access (Tailscale Serve)

NEXUS listens on `127.0.0.1:8787` only (FR-ACC-03, DEC-03). Remote devices reach it through **Tailscale Serve**: private to your tailnet, HTTPS with a real certificate, no router port forwarding, nothing on the public internet. NEXUS's own GitHub sign-in still applies on top (GATE-01).

## 1. Tailnet

1. Install Tailscale on the home machine and on each device you'll use (office laptop, phone); sign in to the **same personal** tailnet. Check workplace rules before installing it on a work device (PRD §18.3).
2. Admin console → **DNS**: enable **MagicDNS** and **HTTPS Certificates**.
3. Optional hardening: admin console → Access controls, allow only your devices to reach the home machine on port 443.

## 2. Serve NEXUS

On the home machine:

```sh
tailscale serve --bg 8787
tailscale serve status        # → https://<host>.<tailnet>.ts.net proxies to http://127.0.0.1:8787
```

The config survives reboots. Never use `tailscale funnel` (that publishes to the internet). Remove with `tailscale serve --https=443 off`.

## 3. Point NEXUS at the tailnet URL

In `.env`:

```sh
PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net
TRUSTED_ORIGINS=http://127.0.0.1:8787     # keep signing in locally working
```

GitHub → Settings → Developer settings → GitHub Apps → your NEXUS app → General → **Callback URL**: add `https://<host>.<tailnet>.ts.net/api/auth/callback/github` (keep the local one). Then:

```sh
node scripts/nexus.mjs up      # recreates the API with the new origin
```

With an `https` origin the API sends HSTS and secure cookies. Sign in **at the URL in `PUBLIC_ORIGIN`**; another origin fails with `state_mismatch` (github-setup.md, Origins).

## 4. Prove it

- From a tailnet device: `https://<host>.<tailnet>.ts.net` → sign-in page → GitHub → board.
- With Tailscale off on that device: the URL doesn't resolve / connect.
- `curl -i https://<host>.<tailnet>.ts.net/v1/jobs` → `401`.
- From the LAN: `curl http://<home-LAN-IP>:8787/v1/health` → connection refused (bound to loopback).

The runner talks to `http://127.0.0.1:8787` on the same host and needs no change.

## Fallback: Cloudflare Tunnel + Access

Only if Tailscale isn't possible. **Create the Access application first**, so the hostname is never public without it:

1. Cloudflare Zero Trust → Access → Applications → self-hosted, hostname `nexus.<your-domain>`, policy *Allow* → *Emails* → your address only, session ≤ 24 h, MFA on the identity provider.
2. `cloudflared tunnel login && cloudflared tunnel create nexus && cloudflared tunnel route dns nexus nexus.<your-domain>`; ingress `service: http://127.0.0.1:8787`; run it as a service (`sudo cloudflared service install`).
3. `PUBLIC_ORIGIN=https://nexus.<your-domain>` + the GitHub callback URL as in §3.

## Client IP and rate limits

Rate limits are per client IP. Tailscale Serve adds the device's tailnet address in `X-Forwarded-For`; the API believes that header only from one proxy hop (`TRUST_PROXY_HOPS=1`, the default) connecting from loopback or a private address (the Compose gateway). A forged `X-Forwarded-For` from anywhere else is ignored. The Cloudflare fallback is also one hop. Raise it only if another reverse proxy sits between that proxy and the API; `0` ignores the header.

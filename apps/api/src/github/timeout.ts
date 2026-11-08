import { App } from "@octokit/app";
import type { GithubAppConfig } from "./app-config.ts";

/** Every GitHub request gets its own deadline, so one hung connection can't hold a job claim or a route open. */
export const GITHUB_TIMEOUT_MS = 20_000;

/** True for the error a deadline (or a caller's abort) raises; Octokit wraps a TimeoutError in a RequestError (cause). */
export const isAbort = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "AbortError" || e.name === "TimeoutError" || (e.cause !== undefined && isAbort(e.cause)));

// A signal is single-use, so the deadline is created per request here, not once per Octokit instance. A signal
// the caller passed (issues.ts) still applies. fetch is looked up per call so tests can stub it.
const timedFetch = (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  globalThis.fetch(url, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(GITHUB_TIMEOUT_MS)])
      : AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

type OctokitClass = NonNullable<ConstructorParameters<typeof App>[0]["Octokit"]>;

/** NEXUS's GitHub App client: its own Octokit, every installation Octokit and plain-token Octokit inherit the deadline. */
export function createGithubApp(config: GithubAppConfig) {
  const base = new App({ appId: config.appId, privateKey: config.privateKey }).octokit
    .constructor as unknown as OctokitClass & { defaults(o: object): OctokitClass };
  return new App({
    appId: config.appId,
    privateKey: config.privateKey,
    Octokit: base.defaults({ request: { fetch: timedFetch } }),
  });
}

import { and, count, eq, isNull } from "drizzle-orm";
import { GITHUB_SETUP_COMMAND, type SetupStatus, type SetupStep } from "@nexus/contracts";
import { AI_RUNBOOK, loadAi } from "./ai.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { projectRepositories, projects, workspaces } from "./db/schema.ts";
import { HttpError } from "./errors.ts";
import type { GithubCatalog } from "./github/catalog.ts";
import { ISSUES_RUNBOOK } from "./github/issues.ts";
import { SEARCH_RUNBOOK, loadSearch } from "./research/web/search.ts";
import { listRunners } from "./runners.ts";
import { boundRepositoryIds } from "./workspaces.ts";

const RUNNER_RUNBOOK = "docs/runbooks/bootstrap.md";

/** Runs a provider-file check: done, or its owner-safe 409 message (it names the file and runbook, never content). */
async function check(load: () => Promise<string>): Promise<{ done: boolean; detail: string }> {
  try {
    return { done: true, detail: await load() };
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 409) return { done: false, detail: e.message };
    throw e;
  }
}

async function githubStep(github: GithubCatalog | null): Promise<SetupStep> {
  const step = (done: boolean, detail: string): SetupStep => ({
    key: "GITHUB",
    done,
    optional: false,
    detail,
    runbook: ISSUES_RUNBOOK,
  });
  if (!github)
    return step(
      false,
      `GitHub isn't set up. On the home machine run ${GITHUB_SETUP_COMMAND}, then restart the API.`,
    );
  try {
    const s = await github.status();
    if (!s.configured || s.installations.length === 0)
      return step(
        false,
        "Install the NEXUS GitHub App on your account and pick the repositories it may work on.",
      );
    const accounts = s.installations.map((i) => i.account.login).join(", ");
    return step(true, `The NEXUS GitHub App is installed on ${accounts}.`);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return step(false, e.message);
  }
}

async function repositoriesStep(db: Db, ownerId: string, projectId: string | undefined): Promise<SetupStep> {
  const step = (done: boolean, detail: string): SetupStep => ({
    key: "REPOSITORIES",
    done,
    optional: false,
    detail,
    runbook: null,
  });
  if (projectId) {
    // 404 for a project that isn't the owner's, like every project-scoped read.
    const n = (await boundRepositoryIds(db, ownerId, projectId)).size;
    const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
    return n > 0
      ? step(true, `${n} ${n === 1 ? "repository is" : "repositories are"} bound to ${p!.name}.`)
      : step(false, `No repositories are bound to ${p!.name} yet. Bind some in Settings → Workspaces.`);
  }
  const [row] = await db
    .select({ n: count() })
    .from(projectRepositories)
    .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(workspaces.ownerId, ownerId), eq(workspaces.mode, "DEV"), isNull(projects.archivedAt)));
  const n = row?.n ?? 0;
  return n > 0
    ? step(true, `Your Dev projects have ${n} repository ${n === 1 ? "binding" : "bindings"}.`)
    : step(false, "No repository is bound to a Dev project yet. Bind some in Settings → Workspaces.");
}

async function aiStep(file: string): Promise<SetupStep> {
  const r = await check(async () => `An AI provider is set up (model ${(await loadAi(file)).model}).`);
  return { key: "AI_PROVIDER", ...r, optional: false, runbook: AI_RUNBOOK };
}

async function runnerStep(db: Db, ownerId: string): Promise<SetupStep> {
  const runners = (await listRunners(db, ownerId)).filter((r) => r.status !== "REVOKED");
  const online = runners.find((r) => r.status === "ONLINE");
  const step = (done: boolean, detail: string): SetupStep => ({
    key: "RUNNER",
    done,
    optional: false,
    detail,
    runbook: RUNNER_RUNBOOK,
  });
  if (online) return step(true, `Runner ${online.name} is online.`);
  if (runners.length > 0)
    return step(
      false,
      `Runner ${runners[0]!.name} is paired but not online. Start it on the home machine (node scripts/runner-service.mjs status).`,
    );
  return step(
    false,
    "No runner is paired. Build the sandbox, then pair the home machine from the Systems zone.",
  );
}

async function searchStep(file: string): Promise<SetupStep> {
  const r = await check(async () => (await loadSearch(file), "Web search is set up."));
  return { key: "WEB_SEARCH", ...r, optional: true, runbook: SEARCH_RUNBOOK };
}

/** What NEXUS still needs before a job can go from words to a draft PR, checked live (FR-ACC, FR-RUN-01, FR-GH-01). */
export async function setupStatus(
  deps: { db: Db; config: Pick<Config, "aiFile" | "searchFile">; github: GithubCatalog | null },
  ownerId: string,
  projectId: string | undefined,
): Promise<SetupStatus> {
  const steps = await Promise.all([
    githubStep(deps.github),
    repositoriesStep(deps.db, ownerId, projectId),
    aiStep(deps.config.aiFile),
    runnerStep(deps.db, ownerId),
    searchStep(deps.config.searchFile),
  ]);
  return {
    steps,
    ready: steps.every((s) => s.done || s.optional),
    checkedAt: new Date().toISOString(),
  };
}

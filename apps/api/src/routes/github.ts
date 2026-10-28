import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  GITHUB_SETUP_COMMAND,
  GithubStatus,
  IssueDetail,
  IssueList,
  IssueListQuery,
  RepoId,
  RepositoryList,
  RepositoryQuery,
} from "@nexus/contracts";
import { HttpError } from "../errors.ts";
import type { Deps } from "../app.ts";
import type { GithubCatalog } from "../github/catalog.ts";

const RepoParams = z.object({ repoId: RepoId });
const IssueParams = RepoParams.extend({
  number: z.coerce
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1),
});

/** The catalog, or 409 explaining how to set GitHub up. */
export const requireGithub = (catalog: GithubCatalog | null) => {
  if (!catalog)
    throw new HttpError(
      409,
      "CONFLICT",
      `GitHub isn't set up. On the home machine run \`${GITHUB_SETUP_COMMAND}\`, then restart the API.`,
      { setupCommand: GITHUB_SETUP_COMMAND },
    );
  return catalog;
};

/** Read-only GitHub catalog (EPIC GH). Registered inside the owner scope: every route needs the owner session. */
export async function githubRoutes(app: FastifyInstance, { github: catalog }: Deps) {
  const need = () => requireGithub(catalog);

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/github/status", { schema: { response: { 200: GithubStatus } } }, async () =>
    catalog ? catalog.status() : { configured: false as const },
  );

  r.get(
    "/v1/repositories",
    { schema: { querystring: RepositoryQuery, response: { 200: RepositoryList } } },
    async (req) => need().repositories(req.query.q),
  );

  r.get(
    "/v1/repositories/:repoId/issues",
    { schema: { params: RepoParams, querystring: IssueListQuery, response: { 200: IssueList } } },
    async (req) => need().issues(req.params.repoId, req.query),
  );

  r.get(
    "/v1/repositories/:repoId/issues/:number",
    { schema: { params: IssueParams, response: { 200: IssueDetail } } },
    async (req) => need().issue(req.params.repoId, req.params.number),
  );
}

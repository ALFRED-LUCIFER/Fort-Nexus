import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CreateProjectRequest, Project, RepoId, UpdateProjectRequest, WorkspaceList } from "@nexus/contracts";
import type { Deps } from "../app.ts";
import {
  bindRepository,
  createProject,
  listWorkspaces,
  unbindRepository,
  updateProject,
} from "../workspaces.ts";
import { requireGithub } from "./github.ts";
import { owner } from "./owner.ts";

const IdParams = z.object({ id: z.uuid() });
const BindParams = IdParams.extend({ repoId: RepoId });

/** Workspaces and projects (EPIC WKS). Registered inside the owner scope: session + trusted Origin on mutations. */
export async function workspaceRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/workspaces", { schema: { response: { 200: WorkspaceList } } }, async (req) =>
    listWorkspaces(db, owner(req).id),
  );

  r.post(
    "/v1/workspaces/:id/projects",
    { schema: { params: IdParams, body: CreateProjectRequest, response: { 201: Project } } },
    async (req, reply) => {
      const project = await createProject(db, {
        ownerId: owner(req).id,
        workspaceId: req.params.id,
        body: req.body,
        correlationId: req.id,
      });
      reply.code(201);
      return project;
    },
  );

  r.patch(
    "/v1/projects/:id",
    { schema: { params: IdParams, body: UpdateProjectRequest, response: { 200: Project } } },
    async (req) =>
      updateProject(db, {
        ownerId: owner(req).id,
        projectId: req.params.id,
        body: req.body,
        correlationId: req.id,
      }),
  );

  r.put(
    "/v1/projects/:id/repositories/:repoId",
    { schema: { params: BindParams, response: { 200: Project } } },
    async (req) =>
      bindRepository(db, requireGithub(deps.github), {
        ownerId: owner(req).id,
        projectId: req.params.id,
        repositoryId: req.params.repoId,
        correlationId: req.id,
      }),
  );

  r.delete(
    "/v1/projects/:id/repositories/:repoId",
    { schema: { params: BindParams, response: { 200: Project } } },
    async (req) =>
      unbindRepository(db, {
        ownerId: owner(req).id,
        projectId: req.params.id,
        repositoryId: req.params.repoId,
        correlationId: req.id,
      }),
  );
}

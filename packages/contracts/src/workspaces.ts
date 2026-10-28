import { z } from "zod";
import { RepoId } from "./github.ts";

// FR-WKS-01..03, FR-CSP-01, FR-CXR-01: one identity, Dev | Business workspaces, projects as the hard scope boundary.

export const WorkspaceMode = z.enum(["DEV", "BUSINESS"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

export const Project = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  mode: WorkspaceMode,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(80),
  // GitHub repositories this project may use (Dev); a repo can be bound to several projects, each binding explicit.
  repositoryIds: z.array(RepoId),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof Project>;

export const Workspace = z.object({
  id: z.uuid(),
  mode: WorkspaceMode,
  name: z.string().min(1).max(80),
  projects: z.array(Project),
});
export type Workspace = z.infer<typeof Workspace>;

// GET /v1/workspaces — exactly one DEV and one BUSINESS workspace per owner (created on first use).
export const WorkspaceList = z.object({ items: z.array(Workspace) });
export type WorkspaceList = z.infer<typeof WorkspaceList>;

// POST /v1/workspaces/:id/projects
export const CreateProjectRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// PATCH /v1/projects/:id
export const UpdateProjectRequest = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// PUT / DELETE /v1/projects/:id/repositories/:repoId — binding is an explicit, audited owner action.

// P1 list endpoints: a project, or omitted for the read-only "All" view across the owner's projects (C-05).
export const ProjectFilterQuery = z.object({ projectId: z.uuid().optional() });
export type ProjectFilterQuery = z.infer<typeof ProjectFilterQuery>;

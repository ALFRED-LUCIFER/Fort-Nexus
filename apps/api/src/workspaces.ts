import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  CreateJobRequest,
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
  WorkspaceList,
  WorkspaceMode,
} from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { projectRepositories, projects, workspaces } from "./db/schema.ts";
import { HttpError, notFound } from "./errors.ts";
import type { GithubCatalog } from "./github/catalog.ts";
import { ownerActor } from "./jobs.ts";

// FR-WKS-01..03, FR-CSP-01, NFR-CNV-05: projects are the hard scope boundary. Every check here fails closed and
// never falls back to another project.

type ProjectRow = typeof projects.$inferSelect;
const MODE_ORDER: WorkspaceMode[] = ["DEV", "BUSINESS"];

const toProjectDto = (p: ProjectRow, mode: WorkspaceMode, repositoryIds: string[]): Project => ({
  id: p.id,
  workspaceId: p.workspaceId,
  mode,
  slug: p.slug,
  name: p.name,
  repositoryIds,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
});

/** Dev + Business on first use; the Dev workspace starts with project "home" (as the migration does). */
async function ensureWorkspaces(db: Db, ownerId: string) {
  await db.transaction(async (tx) => {
    const created = await tx
      .insert(workspaces)
      .values([
        { ownerId, mode: "DEV", name: "Dev" },
        { ownerId, mode: "BUSINESS", name: "Business" },
      ])
      .onConflictDoNothing()
      .returning();
    const dev = created.find((w) => w.mode === "DEV");
    if (dev) await tx.insert(projects).values({ workspaceId: dev.id, slug: "home", name: "Home" });
  });
}

export async function listWorkspaces(db: Db, ownerId: string): Promise<WorkspaceList> {
  await ensureWorkspaces(db, ownerId);
  const ws = await db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId));
  const ps = await db
    .select()
    .from(projects)
    .where(
      inArray(
        projects.workspaceId,
        ws.map((w) => w.id),
      ),
    )
    .orderBy(asc(projects.id));
  const binds = ps.length
    ? await db
        .select()
        .from(projectRepositories)
        .where(
          inArray(
            projectRepositories.projectId,
            ps.map((p) => p.id),
          ),
        )
        .orderBy(asc(projectRepositories.repositoryId))
    : [];
  return {
    items: ws
      .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode))
      .map((w) => ({
        id: w.id,
        mode: w.mode,
        name: w.name,
        projects: ps
          .filter((p) => p.workspaceId === w.id)
          .map((p) =>
            toProjectDto(
              p,
              w.mode,
              binds.filter((b) => b.projectId === p.id).map((b) => b.repositoryId),
            ),
          ),
      })),
  };
}

/** The owner's project and its workspace mode, or 404 (another owner's project doesn't exist for this caller). */
async function ownedProject(tx: Db | Tx, ownerId: string, projectId: string, lock?: "share" | "update") {
  const q = tx
    .select({ p: projects, mode: workspaces.mode })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(projects.id, projectId), eq(workspaces.ownerId, ownerId)));
  const [row] = lock ? await q.for(lock, { of: projects }) : await q;
  if (!row) throw notFound("Project");
  return row;
}

async function projectDto(tx: Db | Tx, p: ProjectRow, mode: WorkspaceMode) {
  const binds = await tx
    .select({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, p.id))
    .orderBy(asc(projectRepositories.repositoryId));
  return toProjectDto(
    p,
    mode,
    binds.map((b) => b.id),
  );
}

const archived = () =>
  new HttpError(409, "CONFLICT", "This project is archived; it can't start or decide runs");

/**
 * A job may start only in an existing, non-archived project of the owner; an issue job additionally needs a Dev
 * project with the repository bound. Inside a transaction it share-locks the project so an archive waits.
 */
export async function assertProjectAllowsJob(tx: Db | Tx, ownerId: string, body: CreateJobRequest) {
  const { p, mode } = await ownedProject(tx, ownerId, body.projectId, "share");
  if (p.archivedAt) throw archived();
  if (body.jobType !== "DEV_ISSUE_TO_PR") return;
  if (mode !== "DEV")
    throw new HttpError(403, "FORBIDDEN", "Issue runs need a Dev project", { field: "projectId" });
  const [bound] = await tx
    .select({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .where(
      and(eq(projectRepositories.projectId, p.id), eq(projectRepositories.repositoryId, body.repositoryId)),
    );
  if (!bound)
    throw new HttpError(403, "FORBIDDEN", "This repository isn't bound to this project", {
      field: "repositoryId",
    });
}

/** Deciding an approval needs its project to still be active (share-locked against a concurrent archive). */
export async function assertProjectActive(tx: Tx, projectId: string) {
  const [p] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("share");
  if (!p) throw notFound("Project");
  if (p.archivedAt) throw archived();
}

/** Repository ids bound to the owner's project (404 for an unknown project). */
export async function boundRepositoryIds(db: Db, ownerId: string, projectId: string) {
  const { p } = await ownedProject(db, ownerId, projectId);
  const rows = await db
    .select({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, p.id));
  return new Set(rows.map((r) => r.id));
}

export async function createProject(
  db: Db,
  input: { ownerId: string; workspaceId: string; body: CreateProjectRequest; correlationId: string },
): Promise<Project> {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.ownerId, input.ownerId)));
    if (!ws) throw notFound("Workspace");
    const [p] = await tx
      .insert(projects)
      .values({ workspaceId: ws.id, slug: input.body.slug, name: input.body.name })
      .onConflictDoNothing({ target: [projects.workspaceId, projects.slug] })
      .returning();
    if (!p)
      throw new HttpError(409, "CONFLICT", `A project with slug "${input.body.slug}" already exists here`, {
        field: "slug",
      });
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "project.create",
      resourceType: "project",
      resourceId: p.id,
      correlationId: input.correlationId,
      metadata: { workspaceId: ws.id, mode: ws.mode, slug: p.slug },
    });
    return toProjectDto(p, ws.mode, []);
  });
}

export async function updateProject(
  db: Db,
  input: { ownerId: string; projectId: string; body: UpdateProjectRequest; correlationId: string },
): Promise<Project> {
  const { name, archived: archive } = input.body;
  if (name === undefined && archive === undefined)
    throw new HttpError(400, "VALIDATION_FAILED", "Nothing to change: send name and/or archived");
  return db.transaction(async (tx) => {
    const { p, mode } = await ownedProject(tx, input.ownerId, input.projectId, "update");
    const [updated] = await tx
      .update(projects)
      .set({
        ...(name === undefined ? {} : { name }),
        // Archiving keeps history (jobs, approvals, bindings); it only blocks new runs and decisions.
        ...(archive === undefined ? {} : { archivedAt: archive ? (p.archivedAt ?? new Date()) : null }),
      })
      .where(eq(projects.id, p.id))
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: archive === undefined ? "project.rename" : archive ? "project.archive" : "project.unarchive",
      resourceType: "project",
      resourceId: p.id,
      correlationId: input.correlationId,
      metadata: {
        ...(name === undefined ? {} : { name }),
        ...(archive === undefined ? {} : { archived: archive }),
      },
    });
    return projectDto(tx, updated!, mode);
  });
}

/** Explicit, audited binding; the repository must belong to one of the NEXUS app's installations. */
export async function bindRepository(
  db: Db,
  catalog: GithubCatalog,
  input: { ownerId: string; projectId: string; repositoryId: string; correlationId: string },
): Promise<Project> {
  const { p: before, mode } = await ownedProject(db, input.ownerId, input.projectId);
  if (mode !== "DEV")
    throw new HttpError(400, "VALIDATION_FAILED", "Only Dev projects use repositories", {
      field: "projectId",
    });
  const repo = (await catalog.repositories()).items.find((r) => r.id === input.repositoryId);
  if (!repo) throw notFound("Repository");
  return db.transaction(async (tx) => {
    const { p } = await ownedProject(tx, input.ownerId, before.id, "update");
    if (p.archivedAt) throw archived();
    await tx
      .insert(projectRepositories)
      .values({ projectId: p.id, repositoryId: repo.id })
      .onConflictDoNothing();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "project.repository.bind",
      resourceType: "project",
      resourceId: p.id,
      correlationId: input.correlationId,
      metadata: { repositoryId: repo.id, fullName: repo.fullName },
    });
    return projectDto(tx, p, mode);
  });
}

/** Unbinding blocks new runs on that repository in this project; existing jobs and approvals are untouched. */
export async function unbindRepository(
  db: Db,
  input: { ownerId: string; projectId: string; repositoryId: string; correlationId: string },
): Promise<Project> {
  return db.transaction(async (tx) => {
    const { p, mode } = await ownedProject(tx, input.ownerId, input.projectId, "update");
    const removed = await tx
      .delete(projectRepositories)
      .where(
        and(
          eq(projectRepositories.projectId, p.id),
          eq(projectRepositories.repositoryId, input.repositoryId),
        ),
      )
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "project.repository.unbind",
      resourceType: "project",
      resourceId: p.id,
      correlationId: input.correlationId,
      metadata: { repositoryId: input.repositoryId, wasBound: removed.length > 0 },
    });
    return projectDto(tx, p, mode);
  });
}

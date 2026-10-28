import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CreateProjectRequest,
  UpdateProjectRequest,
  type Project,
  type RepositoryList,
  type Workspace,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { useGithubStatus, useRepositories, useWorkspaces } from "../lib/queries.ts";
import { DrawerState } from "./Drawer.tsx";

const rowBtn =
  "rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink disabled:opacity-60";
const field =
  "min-w-0 rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink aria-[invalid=true]:border-coral";
const submitBtn =
  "rounded-xl bg-teal px-4 py-2 text-[12.5px] font-medium text-onacc disabled:opacity-60 self-start";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** Every change re-reads the workspaces and the project-scoped repository lists. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.workspaces });
    void queryClient.invalidateQueries({ queryKey: keys.repositories });
  };
}

/** Settings → Workspaces: create, rename and archive projects; bind and unbind repositories (FR-WKS-01..03). */
export function WorkspacesSettings() {
  const workspaces = useWorkspaces();
  const status = useGithubStatus();
  const repos = useRepositories(status.data?.configured === true && status.data.installations.length > 0);
  if (!workspaces.data) return <DrawerState error={workspaces.error} />;
  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        A project is a hard boundary: each run, approval and repository binding belongs to exactly one
        project, and nothing crosses over. Archiving keeps the history and blocks new runs. Every change is
        audited.
      </p>
      {workspaces.data.items.map((w) => (
        <WorkspaceSection key={w.id} workspace={w} repos={w.mode === "DEV" ? repos.data : undefined} />
      ))}
      {repos.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {repos.error.message}
        </p>
      )}
    </>
  );
}

function WorkspaceSection({ workspace: w, repos }: { workspace: Workspace; repos?: RepositoryList }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-none flex-col gap-2">
      <h3 id={id} className="kicker m-0">
        {w.name} workspace
      </h3>
      {w.mode === "BUSINESS" && (
        <p className="m-0 text-[12.5px] leading-[1.5] text-ink3">
          Business projects hold no data yet: read-only connectors arrive in P1.
        </p>
      )}
      <ul
        aria-label={`${w.name} projects`}
        className="m-0 list-none overflow-hidden rounded-[18px] border border-hair p-0"
      >
        {w.projects.length === 0 && (
          <li className="px-4 py-[13px] text-[13px] text-ink2">No projects yet.</li>
        )}
        {w.projects.map((p) => (
          <ProjectRow key={p.id} project={p} repos={w.mode === "DEV" ? repos : undefined} />
        ))}
      </ul>
      <NewProject workspace={w} />
    </section>
  );
}

function ProjectRow({ project: p, repos }: { project: Project; repos?: RepositoryList }) {
  const refresh = useRefresh();
  const [renaming, setRenaming] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateProjectRequest) => api.updateProject(p.id, body),
    onSuccess: () => setRenaming(false),
    onSettled: refresh,
  });
  const bind = useMutation({
    mutationFn: ({ repoId, bound }: { repoId: string; bound: boolean }) =>
      api.bindRepository(p.id, repoId, bound),
    onSettled: refresh,
  });
  const archived = p.archivedAt !== null;
  // Bindings whose repository left the installations stay visible so they can still be removed.
  const gone = p.repositoryIds.filter((id) => repos && !repos.items.some((r) => r.id === id));
  const error = update.error ?? bind.error;

  return (
    <li className="flex flex-col gap-2.5 border-b border-hair px-4 py-[13px] last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[13.5px] leading-[1.3] font-medium">{p.name}</span>
          <span className="truncate font-mono text-[11.5px] leading-[1.4] text-ink3">
            {p.slug}
            {p.mode === "DEV" && ` · ${p.repositoryIds.length} bound`}
            {archived && " · archived, read-only"}
          </span>
        </div>
        <span className="flex gap-1.5">
          <button
            type="button"
            aria-expanded={renaming}
            onClick={() => setRenaming(!renaming)}
            aria-label={`Rename ${p.name}`}
            className={rowBtn}
          >
            Rename
          </button>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ archived: !archived })}
            aria-label={`${archived ? "Unarchive" : "Archive"} ${p.name}`}
            className={rowBtn}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
        </span>
      </div>
      {renaming && (
        <Rename project={p} pending={update.isPending} onSave={(name) => update.mutate({ name })} />
      )}
      {p.mode === "DEV" && (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 p-0 font-mono text-[10.5px] text-ink3 uppercase">Repositories</legend>
          {!repos ? (
            <span className="text-[12.5px] text-ink3">
              Install the NEXUS GitHub App on an account to bind its repositories.
            </span>
          ) : (
            <>
              {repos.items.length === 0 && gone.length === 0 && (
                <span className="text-[12.5px] text-ink3">
                  The app&apos;s installations have no repositories.
                </span>
              )}
              {[
                ...repos.items.map((r) => [r.id, r.fullName] as const),
                ...gone.map((id) => [id, `repository ${id} (no longer installed)`] as const),
              ].map(([repoId, label]) => {
                const bound = p.repositoryIds.includes(repoId);
                return (
                  <label key={repoId} className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={bound}
                      // Archived projects keep their bindings frozen; unbinding stays possible.
                      disabled={bind.isPending || (archived && !bound)}
                      onChange={() => bind.mutate({ repoId, bound: !bound })}
                      className="size-4 accent-teal"
                    />
                    <span className="truncate font-mono text-[12px]">{label}</span>
                  </label>
                );
              })}
            </>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {error.message}
        </p>
      )}
    </li>
  );
}

function Rename({
  project: p,
  pending,
  onSave,
}: {
  project: Project;
  pending: boolean;
  onSave: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(p.name);
  const [touched, setTouched] = useState(false);
  const parsed = UpdateProjectRequest.shape.name.safeParse(name);
  const invalid = touched && (!parsed.success || !parsed.data);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success && parsed.data) onSave(parsed.data);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="text-[12px] text-ink3">
          New name for {p.name}
        </label>
        <input
          id={id}
          value={name}
          maxLength={80}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setName(e.target.value)}
          className={field}
        />
        <span id={`${id}-hint`} className={`text-[11.5px] ${invalid ? "text-coral" : "text-ink3"}`}>
          {invalid ? "Enter 1 to 80 characters." : "Only the name changes; the slug stays."}
        </span>
      </div>
      <button type="submit" disabled={pending} className={submitBtn}>
        {pending ? "Saving…" : "Save name"}
      </button>
    </form>
  );
}

function NewProject({ workspace: w }: { workspace: Workspace }) {
  const id = useId();
  const refresh = useRefresh();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null); // null = follow the name
  const [touched, setTouched] = useState(false);
  const body = { name, slug: slug ?? slugify(name) };
  const parsed = CreateProjectRequest.safeParse(body);
  const bad = new Set(touched ? parsed.error?.issues.map((i) => i.path[0]) : []);
  const create = useMutation({
    mutationFn: (b: CreateProjectRequest) => api.createProject(w.id, b),
    onSuccess: () => {
      setName("");
      setSlug(null);
      setTouched(false);
    },
    onSettled: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success) create.mutate(parsed.data);
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`New ${w.name} project`}
      className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
    >
      <span className="text-[13.5px] font-medium">New {w.name} project</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-[12px] text-ink3">
            Name
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            aria-invalid={bad.has("name")}
            onChange={(e) => {
              setName(e.target.value);
              create.reset();
            }}
            className={field}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-slug`} className="text-[12px] text-ink3">
            Slug
          </label>
          <input
            id={`${id}-slug`}
            value={body.slug}
            maxLength={63}
            aria-invalid={bad.has("slug")}
            aria-describedby={`${id}-slug-hint`}
            onChange={(e) => {
              setSlug(e.target.value);
              create.reset();
            }}
            className={`${field} font-mono`}
          />
        </div>
      </div>
      <span id={`${id}-slug-hint`} className={`text-[11.5px] ${bad.size ? "text-coral" : "text-ink3"}`}>
        {bad.has("name")
          ? "Enter a name of 1 to 80 characters."
          : bad.has("slug")
            ? "Slug: lowercase letters, digits and dashes, starting with a letter or digit."
            : "The slug is unique in this workspace and never changes."}
      </span>
      <button type="submit" disabled={create.isPending} className={submitBtn}>
        {create.isPending ? "Creating…" : "Create project"}
      </button>
      {create.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {create.error.message}
        </p>
      )}
      {create.isSuccess && (
        <p role="status" className="m-0 text-[12.5px] text-green">
          Created {create.data.name}.
        </p>
      )}
    </form>
  );
}

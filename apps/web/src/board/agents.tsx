import { useId, useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  AgentProfileSettings,
  AgentTool,
  TOOL_RISK,
  type AgentKey,
  type AgentSummary,
  type AutonomyLevel,
  type EffectiveAgentProfile,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { clock } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { PICK_PROJECT, useScope } from "./scope.tsx";
import { EmptyZone, type ZoneProps } from "./zones.tsx";

// EPIC AGT registry, FR-WKS-04/05 versioned profiles and the C-04 autonomy dial. The server resolves and caps every
// profile; this UI only shows what it says and saves new versions.

const route = getRouteApi("/");

export const AUTONOMY: Record<AutonomyLevel, { label: string; means: string; tone: string }> = {
  SUGGEST: { label: "Suggest", means: "recommends only", tone: "var(--ink3)" },
  DRAFT: { label: "Draft", means: "prepares, never runs", tone: "var(--violet)" },
  ACT_WITH_APPROVAL: { label: "Act with approval", means: "runs after you OK it", tone: "var(--teal)" },
  AUTONOMOUS: { label: "Autonomous", means: "low-risk (R0/R1) only", tone: "var(--amber)" },
};
const ENGINE = { MESSAGES_API: "Messages API", CLAUDE_AGENT_SDK: "Claude Agent SDK" } as const;
const DETAIL = { BRIEF: "Brief", STANDARD: "Standard", DETAILED: "Detailed" } as const;
const CEILING_NOTE =
  "No profile can loosen the global ceiling: Autonomous acts alone only when every allowed tool is R0/R1, pushes and other R2/R3 writes always wait for your approval, only Developer and QA may use the Claude Agent SDK engine, and a task is capped at $50 and 200 turns.";

const toolCount = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;
const versionLabel = (e: EffectiveAgentProfile) =>
  e.level === "DEFAULT"
    ? "built-in default"
    : `v${e.version} · ${e.level === "PROJECT" ? "this project" : "workspace"}`;

/** The project's agents with their effective profiles; disabled in the "All" view (profiles resolve per project). */
export const useAgents = (projectId: string | undefined) =>
  useQuery({
    queryKey: keys.agentsOf(projectId),
    queryFn: () => api.agents(projectId!),
    enabled: !!projectId,
  });

const useAgentVersions = (agent: AgentKey, projectId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: keys.agentVersions(agent, projectId),
    queryFn: () => api.agentVersions(agent, projectId!),
    enabled: enabled && !!projectId,
  });

function AgentsState({ query, projectId }: { query: UseQueryResult<AgentSummary[]>; projectId?: string }) {
  if (!projectId)
    return <EmptyZone>Pick a project to see its agents: profiles resolve per project.</EmptyZone>;
  return <EmptyZone>{query.error ? query.error.message : "Loading…"}</EmptyZone>;
}

function AgentCard({ a, onOpen, wide }: { a: AgentSummary; onOpen: (k: AgentKey) => void; wide?: boolean }) {
  const s = a.effective.settings;
  return (
    <button
      type="button"
      onClick={() => onOpen(a.agent)}
      className={`flex flex-col gap-2 rounded-[20px] border border-line bg-card px-4 py-3.5 text-left shadow-nx transition-shadow hover:shadow-[0_0_0_2px_var(--teal),var(--shadow)] ${wide ? "w-[220px]" : "w-full"}`}
    >
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 flex-none rounded-full"
          style={{ background: AUTONOMY[s.autonomy].tone }}
        />
        <span className="kicker flex-1 truncate">{AUTONOMY[s.autonomy].label}</span>
      </span>
      <span className="text-[14px] leading-[1.3] font-medium">{a.label}</span>
      <span className="font-mono text-[11.5px] leading-[1.45] text-ink2">
        {toolCount(s.tools.length)} · {versionLabel(a.effective)}
      </span>
    </button>
  );
}

/** Domains grouping: the Agents zone's cards. */
export function AgentsZone({
  query,
  projectId,
  onOpen,
}: {
  query: UseQueryResult<AgentSummary[]>;
  projectId?: string;
  onOpen: (k: AgentKey) => void;
}) {
  if (!query.data) return <AgentsState query={query} projectId={projectId} />;
  return (
    <ul aria-label="Agents" className="m-0 flex list-none flex-wrap content-start gap-[30px] p-0">
      {query.data.map((a) => (
        <li key={a.agent}>
          <AgentCard a={a} onOpen={onOpen} wide />
        </li>
      ))}
    </ul>
  );
}

const LANE_TINT = ["rgba(127,120,105,.09)", "rgba(127,120,105,.05)"];

/** Agents grouping: one swim-lane per agent with its card, effective autonomy and tools (plan steps join later). */
export function agentLanes(
  query: UseQueryResult<AgentSummary[]>,
  projectId: string | undefined,
  onOpen: (k: AgentKey) => void,
): (Omit<ZoneProps, "dim" | "children"> & { body: ReactNode })[] {
  if (!query.data)
    return [
      {
        id: "lanes",
        label: "Agents",
        sub: "",
        x: 40,
        y: 40,
        w: 2000,
        h: 400,
        tint: LANE_TINT[0]!,
        body: <AgentsState query={query} projectId={projectId} />,
      },
    ];
  return query.data.map((a, i) => ({
    id: `lane-${a.agent}`,
    label: a.label,
    sub: "",
    x: 40 + i * 290,
    y: 40,
    w: 270,
    h: 2260,
    tint: LANE_TINT[i % 2]!,
    body: (
      <div className="flex flex-col gap-4">
        <AgentCard a={a} onOpen={onOpen} />
        <dl className="m-0 flex flex-col gap-1 font-mono text-[11.5px] leading-[1.45] text-ink2">
          <dt className="kicker">Autonomy</dt>
          <dd className="m-0 mb-2">{AUTONOMY[a.effective.settings.autonomy].label}</dd>
          <dt className="kicker">Tools</dt>
          {a.effective.settings.tools.length === 0 && <dd className="m-0">none</dd>}
          {a.effective.settings.tools.map((t) => (
            <dd key={t} className="m-0 break-all">
              {t} · {TOOL_RISK[t]}
            </dd>
          ))}
        </dl>
      </div>
    ),
  }));
}

/** The `agent:<KEY>` drawer: effective profile, autonomy dial, tools, limits, history and Save (FR-WKS-04/05). */
export function AgentDrawer({
  agent,
  banner,
  onClose,
}: {
  agent: AgentKey;
  banner?: ReactNode;
  onClose: () => void;
}) {
  const scope = useScope();
  const project = scope.project;
  const agents = useAgents(project?.id);
  const versions = useAgentVersions(agent, project?.id);
  const summary = agents.data?.find((a) => a.agent === agent);
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="Agent · profile" title={summary?.label ?? "Agent"} />
      {!project ? (
        <p className="m-0 px-6 py-5 text-[14px] text-ink2">{PICK_PROJECT}</p>
      ) : !summary || !versions.data ? (
        <DrawerState error={agents.error ?? versions.error} />
      ) : (
        <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 pt-5 pb-6">
          <p className="m-0 text-[14px] leading-[1.55] text-ink2">{summary.description}</p>
          <section aria-label="In effect" className="flex flex-col gap-1.5 rounded-[18px] bg-hair p-4">
            <span className="font-mono text-[12px] text-ink2">
              In effect in {project.name}: {versionLabel(summary.effective)} ·{" "}
              {AUTONOMY[summary.effective.settings.autonomy].label} ·{" "}
              {ENGINE[summary.effective.settings.engine]}
            </span>
            {summary.effective.ceilingApplied.map((c) => (
              <span key={c} className="text-[12.5px] text-amber">
                Ceiling: {c}
              </span>
            ))}
            <span className="font-mono text-[11.5px] text-ink3">
              record · {summary.record.stepsSucceeded} steps succeeded · {summary.record.stepsFailed} failed ·
              last active {summary.record.lastActiveAt ? clock(summary.record.lastActiveAt) : "never"}
            </span>
          </section>
          <ProfileForm
            // Keeps what was just saved on screen; another agent starts from its own profile.
            key={agent}
            agent={agent}
            initial={
              versions.data.find((v) => v.id === summary.effective.versionId)?.settings ??
              summary.effective.settings
            }
            readOnly={
              project.archivedAt
                ? `${project.name} is archived: its agent profiles are read-only. Unarchive it in Settings → Workspaces.`
                : null
            }
          />
          <section aria-labelledby="agent-history" className="flex flex-col gap-2">
            <h3 id="agent-history" className="kicker m-0">
              Version history
            </h3>
            {versions.data.length === 0 ? (
              <p className="m-0 text-[13px] text-ink3">No saved versions: the built-in default applies.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {versions.data.map((v) => (
                  <li key={v.id} className="font-mono text-[11.5px] leading-[1.5] text-ink2">
                    v{v.version} · {v.level === "PROJECT" ? "this project" : "workspace"} ·{" "}
                    {new Date(v.createdAt).toLocaleString([], { hour12: false })} ·{" "}
                    {AUTONOMY[v.settings.autonomy].label} · {toolCount(v.settings.tools.length)}
                    {v.id === summary.effective.versionId && <span className="text-teal"> · in effect</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

const input = "rounded-xl border border-line bg-card px-3 py-2 font-mono text-[13px]";
const fieldset = "m-0 flex flex-col gap-2 rounded-[18px] border border-hair p-4";
const legend = "px-1 text-[13px] font-medium";

function ProfileForm({
  agent,
  initial,
  readOnly,
}: {
  agent: AgentKey;
  initial: AgentProfileSettings;
  readOnly: string | null;
}) {
  const scope = useScope();
  const project = scope.project!;
  const queryClient = useQueryClient();
  const id = useId();
  const [s, setS] = useState(initial);
  const [cost, setCost] = useState(String(initial.maxCostUsdPerTask));
  const [turns, setTurns] = useState(String(initial.maxTurns));
  const [level, setLevel] = useState<"PROJECT" | "WORKSPACE">("PROJECT");
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (settings: AgentProfileSettings) =>
      api.setAgentProfile(agent, {
        level:
          level === "PROJECT"
            ? { kind: "PROJECT", projectId: project.id }
            : { kind: "WORKSPACE", workspaceId: project.workspaceId },
        settings,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.agents }),
  });
  const set = (patch: Partial<AgentProfileSettings>) => {
    setS((cur) => ({ ...cur, ...patch }));
    save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = AgentProfileSettings.safeParse({
      ...s,
      model: s.model?.trim() || undefined,
      maxCostUsdPerTask: cost.trim() === "" ? NaN : Number(cost),
      maxTurns: turns.trim() === "" ? NaN : Number(turns),
    });
    if (!parsed.success) {
      setInvalid("Check the limits: a model id (not a URL), $0.01–$50 per task and 1–200 whole turns.");
      return;
    }
    setInvalid(null);
    save.mutate(parsed.data);
  };
  const toggleTool = (t: AgentTool, on: boolean) =>
    set({ tools: on ? [...s.tools, t] : s.tools.filter((x) => x !== t) });

  return (
    <form onSubmit={submit} noValidate aria-label="Edit profile" className="flex flex-col gap-3">
      <fieldset className={fieldset}>
        <legend className={legend}>Autonomy</legend>
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-hair p-1 sm:grid-cols-4">
          {(Object.keys(AUTONOMY) as AutonomyLevel[]).map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl px-2 py-3 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-teal ${s.autonomy === k ? "bg-glass2 text-ink shadow-[0_2px_8px_rgba(0,0,0,.12)]" : "text-ink3"}`}
            >
              <input
                type="radio"
                name={`${id}-autonomy`}
                value={k}
                checked={s.autonomy === k}
                onChange={() => set({ autonomy: k })}
                className="sr-only"
              />
              <span className="text-[12.5px] font-medium">{AUTONOMY[k].label}</span>
              <span className="text-[10.5px] leading-tight opacity-75">{AUTONOMY[k].means}</span>
            </label>
          ))}
        </div>
        <p className="m-0 text-[12px] leading-[1.5] text-ink3">{CEILING_NOTE}</p>
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>Allowed tools</legend>
        {AgentTool.options.map((t) => (
          <label key={t} className="flex items-center gap-2.5 font-mono text-[12px]">
            <input
              type="checkbox"
              checked={s.tools.includes(t)}
              onChange={(e) => toggleTool(t, e.target.checked)}
            />
            <span className="flex-1">{t}</span>
            <span className="rounded-full bg-hair px-2 py-[4px] text-[10px] text-ink2">
              risk {TOOL_RISK[t]}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className={`${fieldset} sm:grid sm:grid-cols-2`}>
        <legend className={legend}>Limits</legend>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
          Model
          <input
            value={s.model ?? ""}
            placeholder="ai.json default"
            maxLength={128}
            onChange={(e) => set({ model: e.target.value })}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
          Engine
          <select
            value={s.engine}
            onChange={(e) => set({ engine: e.target.value as AgentProfileSettings["engine"] })}
            className={input}
          >
            {Object.entries(ENGINE).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
          Max cost per task (USD)
          <input
            type="number"
            inputMode="decimal"
            min="0.01"
            max="50"
            step="0.01"
            value={cost}
            aria-invalid={!!invalid}
            onChange={(e) => {
              setCost(e.target.value);
              save.reset();
            }}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
          Max turns
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="200"
            step="1"
            value={turns}
            aria-invalid={!!invalid}
            onChange={(e) => {
              setTurns(e.target.value);
              save.reset();
            }}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
          Response detail
          <select
            value={s.responseDetail}
            onChange={(e) =>
              set({ responseDetail: e.target.value as AgentProfileSettings["responseDetail"] })
            }
            className={input}
          >
            {Object.entries(DETAIL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>Save for</legend>
        {(
          [
            ["PROJECT", `This project (${project.name})`],
            ["WORKSPACE", "Whole workspace (projects without their own version)"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2.5 text-[13px]">
            <input
              type="radio"
              name={`${id}-level`}
              checked={level === k}
              onChange={() => {
                setLevel(k);
                save.reset();
              }}
            />
            {l}
          </label>
        ))}
        <p className="m-0 text-[12px] leading-[1.5] text-ink3">
          Saving adds a new version. Conversations keep the version they started with.
        </p>
      </fieldset>

      {invalid && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {invalid}
        </p>
      )}
      {save.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {save.error.message}
        </p>
      )}
      {save.data && (
        <p role="status" className="m-0 text-[12.5px] text-ink2">
          Saved as {save.data.level === "PROJECT" ? "project" : "workspace"} version v{save.data.version}.
        </p>
      )}
      {readOnly && <p className="m-0 text-[12.5px] text-ink2">{readOnly}</p>}
      <button
        type="submit"
        disabled={save.isPending || !!readOnly}
        className="self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
      >
        {save.isPending ? "Saving…" : "Save new version"}
      </button>
    </form>
  );
}

/** Settings → Agent profiles: each agent's version in effect for the selected project; editing opens its drawer. */
export function AgentProfilesSettings() {
  const scope = useScope();
  const navigate = route.useNavigate();
  const agents = useAgents(scope.project?.id);
  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        Agent profiles are versioned. A conversation pins the Chief of Staff version it started with; saving a
        new one only affects new conversations. A project's own version beats the workspace's, which beats the
        built-in default.
      </p>
      {!scope.project ? (
        <p className="m-0 flex-none text-[14px] text-ink2">{PICK_PROJECT}</p>
      ) : !agents.data ? (
        <DrawerState error={agents.error} />
      ) : (
        <ul
          aria-label="Agent profiles"
          className="m-0 flex-none list-none overflow-hidden rounded-[18px] border border-hair p-0"
        >
          {agents.data.map((a) => (
            <li
              key={a.agent}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hair px-4 py-[13px] last:border-b-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[13.5px] leading-[1.3] font-medium">{a.label}</span>
                <span className="truncate font-mono text-[11.5px] leading-[1.4] text-ink3">
                  {versionLabel(a.effective)} · {AUTONOMY[a.effective.settings.autonomy].label} ·{" "}
                  {toolCount(a.effective.settings.tools.length)}
                  {a.effective.ceilingApplied.length > 0 && " · capped by the ceiling"}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Edit ${a.label}`}
                onClick={() => void navigate({ search: { ...scope.keep, drawer: `agent:${a.agent}` } })}
                className="rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Talk: which Chief of Staff profile version a conversation pinned (FR-WKS-05). */
export function PinnedProfile({ projectId, versionId }: { projectId: string; versionId: string | null }) {
  const versions = useAgentVersions("CHIEF_OF_STAFF", projectId, !!versionId);
  const v = versions.data?.find((x) => x.id === versionId);
  return (
    <span>
      Chief of Staff{" "}
      {!versionId
        ? "default"
        : v
          ? `v${v.version}${v.level === "WORKSPACE" ? " (workspace)" : ""}`
          : "pinned version"}
    </span>
  );
}

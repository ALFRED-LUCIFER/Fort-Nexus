import type { SetupStatus, SetupStep, SetupStepKey } from "@nexus/contracts";
import { useGithubStatus, useRunners } from "../lib/queries.ts";
import { useChooseRepositories } from "./repos.tsx";
import { useOpenSettings } from "./Settings.tsx";
import { useScope } from "./scope.tsx";
import { PairRunner } from "./zones.tsx";

// The Home setup checklist: what NEXUS still needs before a job can go from words to a draft PR. Every line comes
// from the API's live check on the home machine (GET /v1/setup); nothing here guesses.

const TITLE: Record<SetupStepKey, string> = {
  GITHUB: "GitHub App",
  REPOSITORIES: "Your repositories",
  AI_PROVIDER: "AI provider",
  RUNNER: "Home runner",
  WEB_SEARCH: "Web search",
};

const btn = "self-start rounded-xl border border-hair px-3.5 py-2 text-[12.5px] font-medium text-ink";

/** "3 of 4 done" over the required steps. */
export const setupMeta = (s: SetupStatus) => {
  const required = s.steps.filter((x) => !x.optional);
  return `${required.filter((x) => x.done).length} of ${required.length} done · checked live`;
};

export function SetupSteps({ status }: { status: SetupStatus }) {
  return (
    <ol aria-label="Setup steps" className="m-0 flex list-none flex-col gap-2 p-0">
      {status.steps.map((s) => (
        <Step key={s.key} step={s} />
      ))}
    </ol>
  );
}

function Step({ step: s }: { step: SetupStep }) {
  const state = s.done ? "Done" : s.optional ? "Optional" : "To do";
  const tone = s.done ? "var(--green)" : s.optional ? "var(--ink3)" : "var(--coral)";
  return (
    <li className="flex flex-col gap-2 rounded-[16px] border border-hair bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full px-2 py-[4px] font-mono text-[10.5px] leading-none"
          style={{ color: tone, background: "var(--hair)" }}
        >
          {s.done ? "✓ " : ""}
          {state}
        </span>
        <span className="text-[13.5px] font-medium">{TITLE[s.key]}</span>
      </div>
      <p className="m-0 text-[13px] leading-[1.5] text-pretty text-ink2">{s.detail}</p>
      {!s.done && <StepAction step={s} />}
    </li>
  );
}

function StepAction({ step: s }: { step: SetupStep }) {
  const openSettings = useOpenSettings();
  const choose = useChooseRepositories();
  const { project } = useScope();
  const github = useGithubStatus();
  const runners = useRunners();
  // In a project the picker chooses its repositories; in All, Settings → Workspaces holds every project's.
  if (s.key === "REPOSITORIES")
    return (
      <button type="button" onClick={project ? choose : () => openSettings("ws")} className={btn}>
        Choose repositories
      </button>
    );
  if (s.key === "GITHUB" && github.data?.configured)
    return (
      <a href={github.data.installUrl} target="_blank" rel="noopener noreferrer" className={btn}>
        Install on GitHub<span className="sr-only"> (opens GitHub in a new tab)</span>
      </a>
    );
  // Pairing from here only when nothing is paired; a paired runner that is offline needs starting, not a new code.
  if (s.key === "RUNNER" && runners.data && runners.data.every((r) => r.status === "REVOKED"))
    return <PairRunner />;
  if (s.runbook)
    return (
      <span className="font-mono text-[11.5px] text-ink3">
        How: <span className="select-all">{s.runbook}</span> on the home machine
      </span>
    );
  return null;
}

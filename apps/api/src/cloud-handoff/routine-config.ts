import { z } from "zod";
import { CLOUD_HANDOFF_RUNBOOK, RoutineId, type CloudRoutineStatus } from "@nexus/contracts";
import { HttpError } from "../errors.ts";
import { readSecretJson } from "../secret-file.ts";

// ~/.nexus/claude-cloud.json (docs/specs/cloud-handoff.md): one Claude Code routine per repository, each with its
// API-trigger fire URL and token. Read on every call, so a new token needs no restart. The token is used only by
// fire.ts, only towards a fire URL this file's schema accepted; nothing else ever sees it.

/** Only Anthropic's routine fire endpoint: the token can't be sent anywhere else. */
export const FIRE_URL =
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]+)\/fire$/;
const TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;
// GitHub's owner/name rules (owner ≤ 39, name ≤ 100 characters).
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const Routine = z.strictObject({
  repository: z.string().regex(REPOSITORY),
  fireUrl: z
    .string()
    .regex(FIRE_URL)
    .refine((u) => RoutineId.safeParse(FIRE_URL.exec(u)?.[1]).success, "routine id too long"),
  token: z.string().max(1024).regex(TOKEN),
});

export const CloudRoutinesFile = z
  .strictObject({ routines: z.array(Routine).min(1) })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.routines.forEach((r, i) => {
      const key = r.repository.toLowerCase();
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["routines", i, "repository"],
          message: "duplicate repository",
        });
      seen.add(key);
    });
  });
export type CloudRoutinesFile = z.infer<typeof CloudRoutinesFile>;

/** What the fire needs. `token` must only ever go into fire.ts's Authorization header. */
export type CloudRoutine = { routineId: string; repository: string; fireUrl: string; token: string };

const missingMessage = (file: string) =>
  `Claude cloud handoff isn't set up. On the home machine create ${file} with mode 0600 (see ${CLOUD_HANDOFF_RUNBOOK}).`;

/** The whole file, or 409 (reason NO_FILE / INVALID_FILE) naming the file and runbook, never its content. */
export const loadCloudRoutines = (file: string) =>
  readSecretJson(file, CloudRoutinesFile, {
    runbook: CLOUD_HANDOFF_RUNBOOK,
    missing: { reason: "NO_FILE", message: missingMessage(file) },
    invalidReason: "INVALID_FILE",
  });

type Lookup =
  { ok: true; routine: CloudRoutine } | { ok: false; status: CloudRoutineStatus & { configured: false } };

async function lookup(file: string, repositoryFullName: string): Promise<Lookup> {
  let routines: CloudRoutinesFile;
  try {
    routines = await loadCloudRoutines(file);
  } catch (e) {
    if (!(e instanceof HttpError) || e.statusCode !== 409) throw e;
    const reason =
      (e.details as { reason?: string } | undefined)?.reason === "NO_FILE" ? "NO_FILE" : "INVALID_FILE";
    return {
      ok: false,
      status: { configured: false, reason, detail: e.message, runbook: CLOUD_HANDOFF_RUNBOOK },
    };
  }
  const wanted = repositoryFullName.toLowerCase();
  const r = routines.routines.find((x) => x.repository.toLowerCase() === wanted);
  if (!r)
    return {
      ok: false,
      status: {
        configured: false,
        reason: "NO_ROUTINE_FOR_REPO",
        detail: `${file} has no routine for ${repositoryFullName}. Create one on claude.ai/code/routines and add it to the file (see ${CLOUD_HANDOFF_RUNBOOK}).`,
        runbook: CLOUD_HANDOFF_RUNBOOK,
      },
    };
  return {
    ok: true,
    routine: {
      routineId: FIRE_URL.exec(r.fireUrl)![1]!,
      repository: r.repository,
      fireUrl: r.fireUrl,
      token: r.token,
    },
  };
}

/** Whether `repositoryFullName` has a routine: never the token or the file's content. */
export async function routineStatus(file: string, repositoryFullName: string): Promise<CloudRoutineStatus> {
  const l = await lookup(file, repositoryFullName);
  return l.ok ? { configured: true, routineId: l.routine.routineId } : l.status;
}

/** The routine to fire for `repositoryFullName`, or 409 saying what to do on the home machine. */
export async function routineFor(file: string, repositoryFullName: string): Promise<CloudRoutine> {
  const l = await lookup(file, repositoryFullName);
  if (l.ok) return l.routine;
  throw new HttpError(409, "CONFLICT", l.status.detail, {
    reason: l.status.reason,
    runbook: l.status.runbook,
  });
}

import { and, eq, sql } from "drizzle-orm";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_MAX_SECONDS,
  type UpdateVoiceSettingsRequest,
  type VoiceAudioType,
  type VoiceSettings,
  type VoiceStatus,
  type Transcript,
} from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { HttpError } from "../errors.ts";
import { ownerActor } from "../jobs.ts";
import { localDate } from "../research/schedule.ts";
import { resolveProject, type ProjectScope } from "../workspaces.ts";
import { speak as azureSpeak, ssml, transcribe as azureTranscribe } from "./azure.ts";
import { VOICE_RUNBOOK, loadVoice, type VoiceConfig } from "./config.ts";
import { voiceSettings, voiceUsage } from "./schema.ts";

// The VoiceGateway (FR-CWV-02/03, FR-CSP-02/05): consent settings, the provider disclosure, push-to-talk and
// spoken replies. A transcript is the owner's words to review, never a command. Audit records hold ids, counts and
// outcomes only: never audio, transcript or spoken text.

export type VoiceDeps = { db: Db; voiceFile: string; timezone: string };
export type Ctx = { ownerId: string; correlationId: string };

const SETTINGS_PATH = "Settings → Voice & consent";

async function settingsOf(db: Db, ownerId: string): Promise<VoiceSettings> {
  const [row] = await db.select().from(voiceSettings).where(eq(voiceSettings.ownerId, ownerId));
  return toSettings(row);
}

const toSettings = (row: typeof voiceSettings.$inferSelect | undefined): VoiceSettings =>
  row
    ? {
        micEnabled: row.micEnabled,
        speakReplies: row.speakReplies,
        speechRate: row.speechRate,
        language: row.language as VoiceSettings["language"],
      }
    : DEFAULT_VOICE_SETTINGS;

/** voice.json, or null when missing; `problem` is the owner-safe reason when it exists but is unusable. */
async function configOf(file: string): Promise<{ config: VoiceConfig | null; problem: string | null }> {
  try {
    return { config: await loadVoice(file), problem: null };
  } catch (err) {
    if (!(err instanceof HttpError) || err.statusCode !== 409) throw err;
    const reason = (err.details as { reason?: string } | undefined)?.reason;
    return { config: null, problem: reason === "voice_config_invalid" ? err.message : null };
  }
}

function disclosure(c: VoiceConfig | null): string[] {
  if (!c) return ["Voice isn't set up on the home machine, so nothing is recorded or sent anywhere."];
  const lines: string[] = [];
  if (c.transcribe)
    lines.push(
      `Your recording is sent to Azure OpenAI (deployment ${c.transcribe.deployment}) on your Foundry resource ${c.transcribe.resourceLabel} to turn it into text.`,
      "Microsoft doesn't use it to train models; prompts and audio may be kept for abuse monitoring in your resource's region.",
    );
  if (c.speech)
    lines.push(
      `Replies you choose to hear are sent to Azure AI Speech (voice ${c.speech.voice}, region ${c.speech.region}) to be spoken.`,
      "Azure AI Speech doesn't store the text it speaks.",
    );
  lines.push("Nothing is recorded until you press the mic.");
  return lines;
}

/** GET /v1/voice/status */
export async function voiceStatus(deps: VoiceDeps, ownerId: string): Promise<VoiceStatus> {
  const [{ config, problem }, settings, usage] = await Promise.all([
    configOf(deps.voiceFile),
    settingsOf(deps.db, ownerId),
    deps.db
      .select()
      .from(voiceUsage)
      .where(
        and(eq(voiceUsage.ownerId, ownerId), eq(voiceUsage.localDate, localDate(new Date(), deps.timezone))),
      ),
  ]);
  return {
    configured: config !== null,
    transcribe: config?.transcribe
      ? { provider: "AZURE_OPENAI", deployment: config.transcribe.deployment }
      : null,
    speak: config?.speech ? { provider: "AZURE_SPEECH", voice: config.speech.voice } : null,
    disclosure: disclosure(config),
    runbook: VOICE_RUNBOOK,
    problem,
    settings,
    usageToday: {
      transcribedSeconds: usage[0]?.transcribedSeconds ?? 0,
      spokenCharacters: usage[0]?.spokenCharacters ?? 0,
    },
  };
}

/** PUT /v1/voice/settings: audited with the names of the changed fields (and the new switch/rate values). */
export async function updateVoiceSettings(
  deps: VoiceDeps,
  ctx: Ctx,
  body: UpdateVoiceSettingsRequest,
): Promise<VoiceStatus> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(voiceSettings)
      .where(eq(voiceSettings.ownerId, ctx.ownerId))
      .for("update");
    const before = toSettings(row);
    const next: VoiceSettings = { ...before, ...body };
    const changed = (Object.keys(next) as (keyof VoiceSettings)[]).filter((k) => next[k] !== before[k]);
    if (changed.length === 0) return;
    await tx
      .insert(voiceSettings)
      .values({ ownerId: ctx.ownerId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: voiceSettings.ownerId, set: { ...next, updatedAt: new Date() } });
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: "voice.settings",
      resourceType: "voice",
      resourceId: ctx.ownerId,
      correlationId: ctx.correlationId,
      metadata: {
        changed,
        ...(changed.includes("micEnabled") ? { micEnabled: next.micEnabled } : {}),
        ...(changed.includes("speakReplies") ? { speakReplies: next.speakReplies } : {}),
        ...(changed.includes("speechRate") ? { speechRate: next.speechRate } : {}),
      },
    });
  });
  return voiceStatus(deps, ctx.ownerId);
}

const notConfigured = (half: "transcribe" | "speech", file: string) =>
  new HttpError(
    409,
    "CONFLICT",
    half === "transcribe"
      ? `Speech-to-text isn't set up. On the home machine add "transcribe" to ${file} (see ${VOICE_RUNBOOK}).`
      : `Spoken replies aren't set up on the home machine. Add "speech" to ${file} (see ${VOICE_RUNBOOK}); the browser's own voice can read replies meanwhile.`,
    { reason: `voice_${half}_not_configured`, file, runbook: VOICE_RUNBOOK },
  );

/** The half of voice.json a call needs, or 409 (missing file, invalid file or that half not set up). */
async function requireHalf<H extends "transcribe" | "speech">(
  file: string,
  half: H,
): Promise<NonNullable<VoiceConfig[H]>> {
  const c = await loadVoice(file);
  const cfg = c[half];
  if (!cfg) throw notConfigured(half, file);
  return cfg as NonNullable<VoiceConfig[H]>;
}

const addUsage = (
  db: Pick<Db, "insert">,
  ownerId: string,
  timezone: string,
  add: { transcribedSeconds?: number; spokenCharacters?: number },
) =>
  db
    .insert(voiceUsage)
    .values({
      ownerId,
      localDate: localDate(new Date(), timezone),
      transcribedSeconds: add.transcribedSeconds ?? 0,
      spokenCharacters: add.spokenCharacters ?? 0,
    })
    .onConflictDoUpdate({
      target: [voiceUsage.ownerId, voiceUsage.localDate],
      set: {
        transcribedSeconds: sql`${voiceUsage.transcribedSeconds} + excluded.transcribed_seconds`,
        spokenCharacters: sql`${voiceUsage.spokenCharacters} + excluded.spoken_characters`,
      },
    });

const reasonOf = (err: unknown) =>
  err instanceof HttpError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : "error";

/** Runs one provider call with its audit (and usage on success); any failure is audited and rethrown. */
async function audited<T>(
  deps: VoiceDeps,
  ctx: Ctx,
  scope: ProjectScope,
  action: "voice.transcribe" | "voice.speak",
  metadata: Record<string, unknown>,
  call: () => Promise<T>,
  usage: { transcribedSeconds?: number; spokenCharacters?: number },
): Promise<T> {
  const entry = {
    actor: ownerActor(ctx.ownerId),
    action,
    resourceType: "voice" as const,
    resourceId: scope.projectId,
    correlationId: ctx.correlationId,
  };
  const meta = { workspaceId: scope.workspaceId, projectId: scope.projectId, ...metadata };
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await audit(deps.db, { ...entry, outcome: "FAILED", metadata: { ...meta, reason: reasonOf(err) } });
    throw err;
  }
  await deps.db.transaction(async (tx) => {
    await addUsage(tx, ctx.ownerId, deps.timezone, usage);
    await audit(tx, { ...entry, metadata: meta });
  });
  return result;
}

const denied = (deps: VoiceDeps, ctx: Ctx, scope: ProjectScope, action: string, reason: string) =>
  audit(deps.db, {
    actor: ownerActor(ctx.ownerId),
    action,
    resourceType: "voice",
    resourceId: scope.projectId,
    correlationId: ctx.correlationId,
    outcome: "DENIED",
    metadata: { workspaceId: scope.workspaceId, projectId: scope.projectId, reason },
  });

/** POST /v1/voice/transcribe: the owner's clip to text, for review. */
export async function transcribeClip(
  deps: VoiceDeps,
  ctx: Ctx,
  input: { projectId: string; audio: Buffer; type: VoiceAudioType; durationMs: number },
): Promise<Transcript> {
  const scope = await resolveProject(deps.db, ctx.ownerId, input.projectId, { write: true });
  const settings = await settingsOf(deps.db, ctx.ownerId);
  if (!settings.micEnabled) {
    await denied(deps, ctx, scope, "voice.transcribe", "mic_disabled");
    throw new HttpError(403, "FORBIDDEN", `The microphone is off. Turn it on in ${SETTINGS_PATH}.`, {
      reason: "mic_disabled",
    });
  }
  const cfg = await requireHalf(deps.voiceFile, "transcribe");
  if (input.durationMs > VOICE_MAX_SECONDS * 1000)
    throw new HttpError(
      413,
      "VALIDATION_FAILED",
      `Recordings can be up to ${VOICE_MAX_SECONDS} seconds. Record a shorter clip.`,
      { reason: "audio_too_long" },
    );
  const text = await audited(
    deps,
    ctx,
    scope,
    "voice.transcribe",
    { durationMs: input.durationMs, bytes: input.audio.length, deployment: cfg.deployment },
    () => azureTranscribe(cfg, { audio: input.audio, type: input.type, language: settings.language }),
    { transcribedSeconds: input.durationMs / 1000 },
  );
  return {
    text: text.slice(0, 10_000),
    durationMs: input.durationMs,
    provider: "AZURE_OPENAI",
    deployment: cfg.deployment,
  };
}

/** POST /v1/voice/speak: a reply as MP3 bytes. */
export async function speakText(
  deps: VoiceDeps,
  ctx: Ctx,
  input: { projectId: string; text: string },
): Promise<Buffer> {
  const scope = await resolveProject(deps.db, ctx.ownerId, input.projectId);
  const settings = await settingsOf(deps.db, ctx.ownerId);
  if (!settings.speakReplies) {
    await denied(deps, ctx, scope, "voice.speak", "speak_disabled");
    throw new HttpError(403, "FORBIDDEN", `Spoken replies are off. Turn them on in ${SETTINGS_PATH}.`, {
      reason: "speak_disabled",
    });
  }
  const cfg = await requireHalf(deps.voiceFile, "speech");
  const characters = input.text.length;
  return audited(
    deps,
    ctx,
    scope,
    "voice.speak",
    { characters, voice: cfg.voice },
    () =>
      azureSpeak(
        cfg,
        ssml(input.text, { voice: cfg.voice, language: settings.language, rate: settings.speechRate }),
      ),
    { spokenCharacters: characters },
  );
}

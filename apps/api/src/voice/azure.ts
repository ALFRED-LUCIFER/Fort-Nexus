import { z } from "zod";
import type { VoiceAudioType } from "@nexus/contracts";
import { HttpError } from "../errors.ts";
import type { VoiceConfig } from "./config.ts";

// The two Azure calls behind the VoiceGateway (docs/specs/cofounder-wave.md "Decisions", checked 2026-11-04):
// - STT: https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview (audio/transcriptions)
// - TTS: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
// Neither the audio, the text nor a provider's response body is logged or put in an error: every failure becomes
// an owner-safe HttpError whose details carry a reason only.

const TRANSCRIBE_API_VERSION = "2025-04-01-preview";
const TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_RESPONSE_BYTES = 256 * 1024;
// 2000 characters at 48 kbit/s is ~3 minutes of speech (~1 MB); anything far beyond that isn't a reply.
const MAX_AUDIO_RESPONSE_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "NEXUS-Voice/1.0";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const RUNBOOK_HINT = "Check ~/.nexus/voice.json on the home machine (docs/runbooks/voice.md).";

const EXTENSION: Record<VoiceAudioType, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

type Op = "transcribe" | "speak";
const SERVICE: Record<Op, string> = { transcribe: "Azure OpenAI", speak: "Azure AI Speech" };

export type VoiceFailureReason =
  | "voice_provider_auth"
  | "voice_provider_not_found"
  | "voice_provider_rejected"
  | "voice_provider_rate_limited"
  | "voice_provider_unavailable";

const failure = (
  status: 502 | 503,
  code: "INTERNAL" | "RATE_LIMITED",
  reason: VoiceFailureReason,
  message: string,
) => new HttpError(status, code, message, { reason });

const unavailable = (op: Op) =>
  failure(
    503,
    "INTERNAL",
    "voice_provider_unavailable",
    `${SERVICE[op]} couldn't be reached or answered unexpectedly. Try again shortly.`,
  );

/** The owner-safe error for a provider's non-2xx answer. */
export function providerFailure(op: Op, status: number, deployment?: string): HttpError {
  if (status === 401 || status === 403)
    return failure(
      502,
      "INTERNAL",
      "voice_provider_auth",
      `${SERVICE[op]} rejected NEXUS's key or it lacks permission. ${RUNBOOK_HINT}`,
    );
  if (status === 404)
    return failure(
      502,
      "INTERNAL",
      "voice_provider_not_found",
      op === "transcribe"
        ? `Azure OpenAI has no deployment named ${deployment ?? "(unknown)"} on this resource. ${RUNBOOK_HINT}`
        : `Azure AI Speech isn't available at this region. ${RUNBOOK_HINT}`,
    );
  if (status === 429)
    return failure(
      503,
      "RATE_LIMITED",
      "voice_provider_rate_limited",
      `${SERVICE[op]} is rate limiting NEXUS or the quota is used up. Try again in a minute.`,
    );
  if (status >= 400 && status < 500)
    return failure(
      502,
      "INTERNAL",
      "voice_provider_rejected",
      op === "transcribe"
        ? "Azure OpenAI couldn't use this recording. Try recording again."
        : `Azure AI Speech couldn't speak this reply; the voice name may be wrong. ${RUNBOOK_HINT}`,
    );
  return unavailable(op);
}

/** The body, capped (a provider can't make NEXUS buffer an unbounded response); null when over the cap. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function send(op: Op, url: string, init: RequestInit, deployment?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw unavailable(op); // network, TLS, timeout: the cause may echo request details, so it isn't passed on
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw providerFailure(op, res.status, deployment);
  }
  return res;
}

const TranscriptionResponse = z.object({ text: z.string() });

/** Speech to text on the owner's Azure OpenAI transcribe deployment. `language`: BCP-47 or "auto". */
export async function transcribe(
  cfg: NonNullable<VoiceConfig["transcribe"]>,
  clip: { audio: Buffer; type: VoiceAudioType; language: string },
): Promise<string> {
  const form = new FormData();
  // Azure infers the container from the file name, so the extension has to match the type.
  form.append(
    "file",
    new Blob([new Uint8Array(clip.audio)], { type: clip.type }),
    `clip.${EXTENSION[clip.type]}`,
  );
  form.append("model", cfg.deployment);
  if (clip.language !== "auto") form.append("language", clip.language.split("-")[0]!);
  form.append("response_format", "json");
  const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/audio/transcriptions?api-version=${TRANSCRIBE_API_VERSION}`;
  const res = await send(
    "transcribe",
    url,
    { headers: { "api-key": cfg.apiKey, accept: "application/json" }, body: form },
    cfg.deployment,
  );
  const body = await readCapped(res, MAX_TRANSCRIPT_RESPONSE_BYTES).catch(() => null);
  let parsed: z.ZodSafeParseResult<{ text: string }>;
  try {
    parsed = TranscriptionResponse.safeParse(body === null ? null : JSON.parse(body.toString("utf8")));
  } catch {
    throw unavailable("transcribe");
  }
  if (!parsed.success) throw unavailable("transcribe");
  return parsed.data.text.trim();
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * The SSML NEXUS sends: the text XML-escaped (and stripped of characters XML 1.0 forbids), so a reply can never
 * open a tag or change the voice. `voice` and `lang` are validated config/settings values.
 */
export function ssml(text: string, opts: { voice: string; language: string; rate: number }) {
  const lang = opts.language === "auto" ? "en-US" : opts.language;
  const pct = Math.round((opts.rate - 1) * 100);
  const body = [...text]
    .filter((c) => {
      const n = c.codePointAt(0)!;
      return (n >= 0x20 || n === 0x9 || n === 0xa || n === 0xd) && n !== 0xfffe && n !== 0xffff;
    })
    .join("")
    .replace(/[<>&"']/g, (c) => XML_ESCAPES[c]!);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${opts.voice}"><prosody rate="${pct >= 0 ? "+" : ""}${pct}%">${body}</prosody></voice></speak>`;
}

/** Text to speech on Azure AI Speech: MP3 bytes. */
export async function speak(cfg: NonNullable<VoiceConfig["speech"]>, document: string): Promise<Buffer> {
  const res = await send("speak", `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    headers: {
      "ocp-apim-subscription-key": cfg.apiKey,
      "content-type": "application/ssml+xml",
      "x-microsoft-outputformat": OUTPUT_FORMAT,
      "user-agent": USER_AGENT,
    },
    body: document,
  });
  const audio = await readCapped(res, MAX_AUDIO_RESPONSE_BYTES).catch(() => null);
  if (!audio || audio.length === 0) throw unavailable("speak");
  return audio;
}

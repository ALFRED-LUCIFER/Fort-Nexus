import { z } from "zod";

// Push-to-talk and spoken replies (FR-CWV-02/03, FR-CHN-01, FR-CSP-02/05, CWV-G06..G08; PRD §A "Voice"). The server is
// the VoiceGateway: the browser records, NEXUS sends the audio to the owner's configured provider and returns text.
// A transcript is the owner's words to review, never a command: it fills the input and the owner sends it.

// Speech-to-text: an Azure OpenAI transcribe deployment on the owner's Foundry resource. Spoken replies: Azure AI
// Speech (neural voice) on the same resource. Without ~/.nexus/voice.json neither runs; the web app may still speak
// replies with the browser's own speechSynthesis, labelled as such.
export const VOICE_AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"] as const;
export const VoiceAudioType = z.enum(VOICE_AUDIO_TYPES);
export type VoiceAudioType = z.infer<typeof VoiceAudioType>;

// Push-to-talk clips, not dictation sessions.
export const VOICE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 120;
export const VOICE_SPEAK_MAX_CHARS = 2000;

export const VoiceSettings = z.object({
  // Off until the owner turns it on after reading the provider disclosure (FR-CSP-05).
  micEnabled: z.boolean(),
  // Speak Cofounder / Talk replies aloud.
  speakReplies: z.boolean(),
  speechRate: z.number().min(0.75).max(1.5),
  // BCP-47 tag for recognition and the voice, e.g. "en-US"; "auto" lets the model detect it.
  language: z.union([z.literal("auto"), z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)]),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  micEnabled: false,
  speakReplies: false,
  speechRate: 1,
  language: "auto",
};

// PUT /v1/voice/settings
export const UpdateVoiceSettingsRequest = z
  .strictObject({
    micEnabled: z.boolean().optional(),
    speakReplies: z.boolean().optional(),
    speechRate: VoiceSettings.shape.speechRate.optional(),
    language: VoiceSettings.shape.language.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateVoiceSettingsRequest = z.infer<typeof UpdateVoiceSettingsRequest>;

// GET /v1/voice/status
export const VoiceStatus = z.object({
  configured: z.boolean(),
  // Null when not configured or that half isn't set up.
  transcribe: z.object({ provider: z.literal("AZURE_OPENAI"), deployment: z.string() }).nullable(),
  speak: z.object({ provider: z.literal("AZURE_SPEECH"), voice: z.string() }).nullable(),
  // Plain sentences for the consent UI: who processes the audio, where, and what they keep. Server-written.
  disclosure: z.array(z.string().max(400)).max(6),
  runbook: z.string(),
  // Present when configured but the file is wrong (owner-safe; never the file's content).
  problem: z.string().max(400).nullable(),
  settings: VoiceSettings,
  // Usage counters (PRD §15: speech minutes and TTS characters are counted apart from model tokens). Local day.
  usageToday: z.object({
    transcribedSeconds: z.number().nonnegative(),
    spokenCharacters: z.int().nonnegative(),
  }),
});
export type VoiceStatus = z.infer<typeof VoiceStatus>;

// POST /v1/voice/transcribe?projectId=<uuid> — the body is the raw clip with Content-Type in VOICE_AUDIO_TYPES
// (codec parameters allowed), header `x-audio-duration-ms` (the browser's measurement, capped and used for the usage
// counter only). 409 when not configured, 403 when the mic is off in settings, 413 over the limits.
export const TranscribeQuery = z.object({ projectId: z.uuid() });
export type TranscribeQuery = z.infer<typeof TranscribeQuery>;

export const Transcript = z.object({
  // The owner's words as the provider heard them: untrusted input, shown for review before anything is sent.
  text: z.string().max(10_000),
  durationMs: z.int().nonnegative(),
  provider: z.literal("AZURE_OPENAI"),
  deployment: z.string(),
});
export type Transcript = z.infer<typeof Transcript>;

// POST /v1/voice/speak — answers audio/mpeg. 409 when the Speech half isn't configured (the UI then uses the
// browser's voice), 403 when speakReplies is off.
export const SpeakRequest = z.strictObject({
  projectId: z.uuid(),
  text: z.string().trim().min(1).max(VOICE_SPEAK_MAX_CHARS),
});
export type SpeakRequest = z.infer<typeof SpeakRequest>;

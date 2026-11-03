import { readSecretJson } from "../secret-file.ts";
import { z } from "zod";

// The VoiceGateway's provider config, ~/.nexus/voice.json (docs/runbooks/voice.md). Read on every call, so a key
// rotation needs no restart; the keys are never logged, returned or put in an error.

export const VOICE_RUNBOOK = "docs/runbooks/voice.md";
export const DEFAULT_VOICE = "en-US-AvaMultilingualNeural";

// Printable ASCII without spaces: keys go into a header, so nothing that could split one.
const ApiKey = z.string().regex(/^[\x21-\x7e]{16,256}$/);

const VoiceFile = z
  .strictObject({
    provider: z.literal("foundry"),
    resource: z
      .string()
      .regex(/^[a-z0-9-]{2,64}$/)
      .optional(),
    // A custom domain for the Azure OpenAI endpoint: the origin only, on the default https port.
    baseUrl: z
      .url({ protocol: /^https$/ })
      .refine((u) => {
        const url = new URL(u);
        return url.port === "" && url.pathname === "/" && !url.search && !url.hash && !url.username;
      }, "baseUrl must be an https origin on the default port")
      .optional(),
    apiKey: ApiKey,
    transcribe: z.strictObject({ deployment: z.string().regex(/^[\w.-]{1,64}$/) }).optional(),
    speech: z
      .strictObject({
        region: z.string().regex(/^[a-z0-9]{2,32}$/),
        // Goes into an SSML attribute: names like en-US-AvaMultilingualNeural or en-US-Ava:DragonHDLatestNeural only.
        voice: z
          .string()
          .regex(/^[A-Za-z0-9:-]{3,100}$/)
          .default(DEFAULT_VOICE),
        apiKey: ApiKey.optional(),
      })
      .optional(),
  })
  .refine((c) => !(c.resource !== undefined && c.baseUrl !== undefined), {
    message: "set resource or baseUrl, not both",
  })
  .refine((c) => !c.transcribe || c.resource !== undefined || c.baseUrl !== undefined, {
    message: "transcribe needs resource or baseUrl",
  })
  .refine((c) => c.transcribe || c.speech, { message: "set transcribe, speech or both" });

export type VoiceConfig = {
  transcribe: {
    /** https://<resource>.openai.azure.com or the custom baseUrl origin, without a trailing slash. */
    endpoint: string;
    /** What the consent text names: the resource, or the custom host. */
    resourceLabel: string;
    deployment: string;
    apiKey: string;
  } | null;
  speech: { region: string; voice: string; apiKey: string } | null;
};

export type VoiceProblemReason = "voice_not_configured" | "voice_config_invalid";

/**
 * Reads and checks voice.json: a regular file, mode 0600, owned by the API user, strict JSON matching the shape.
 * Missing or unusable → 409 naming the file and runbook; messages never include the file's content.
 */
export async function loadVoice(file: string): Promise<VoiceConfig> {
  const c = await readSecretJson(file, VoiceFile, {
    runbook: VOICE_RUNBOOK,
    missing: {
      reason: "voice_not_configured" satisfies VoiceProblemReason,
      message: `Voice isn't set up. On the home machine create ${file} with mode 0600 (see ${VOICE_RUNBOOK}), then try again.`,
    },
    invalidReason: "voice_config_invalid" satisfies VoiceProblemReason,
  });
  const endpoint = c.baseUrl ? new URL(c.baseUrl).origin : `https://${c.resource}.openai.azure.com`;
  return {
    transcribe: c.transcribe
      ? {
          endpoint,
          resourceLabel: c.resource ?? new URL(endpoint).host,
          deployment: c.transcribe.deployment,
          apiKey: c.apiKey,
        }
      : null,
    speech: c.speech
      ? { region: c.speech.region, voice: c.speech.voice, apiKey: c.speech.apiKey ?? c.apiKey }
      : null,
  };
}

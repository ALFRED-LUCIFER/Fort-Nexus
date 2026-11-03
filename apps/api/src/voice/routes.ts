import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  SpeakRequest,
  TranscribeQuery,
  Transcript,
  UpdateVoiceSettingsRequest,
  VOICE_MAX_AUDIO_BYTES,
  VoiceAudioType,
  VoiceStatus,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { owner } from "../routes/owner.ts";
import { speakText, transcribeClip, updateVoiceSettings, voiceStatus, type VoiceDeps } from "./service.ts";

// Matched against the normalised Content-Type, codec parameters allowed (audio/webm;codecs=opus).
const AUDIO_CONTENT_TYPE = new RegExp(
  `^(?:${VoiceAudioType.options.join("|").replaceAll("/", "\\/")})(?:;|$)`,
);

// Each call is billed by Azure (per audio minute / per character): a runaway client must not run up the bill.
const providerLimit = {
  max: 20,
  timeWindow: "1 minute",
  keyGenerator: (req: FastifyRequest) => `voice:${req.owner?.id ?? req.ip}`,
};

const TranscribeHeaders = z.object({
  "content-type": z.string().optional(),
  "x-audio-duration-ms": z.coerce.number().int().nonnegative(),
});

/** VoiceGateway routes, inside the owner scope (session + trusted Origin on mutations). */
export async function voiceRoutes(app: FastifyInstance, deps: Deps) {
  const vd: VoiceDeps = {
    db: deps.db,
    voiceFile: deps.config.voiceFile,
    timezone: deps.config.ownerTimezone,
  };
  const ctx = (req: FastifyRequest) => ({ ownerId: owner(req).id, correlationId: req.id });
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/voice/status", { schema: { response: { 200: VoiceStatus } } }, async (req) =>
    voiceStatus(vd, owner(req).id),
  );

  r.put(
    "/v1/voice/settings",
    { schema: { body: UpdateVoiceSettingsRequest, response: { 200: VoiceStatus } } },
    async (req) => updateVoiceSettings(vd, ctx(req), req.body),
  );

  r.post(
    "/v1/voice/speak",
    { config: { rateLimit: providerLimit }, schema: { body: SpeakRequest } },
    async (req, reply) => {
      const audio = await speakText(vd, ctx(req), req.body);
      return reply.type("audio/mpeg").header("cache-control", "no-store").send(audio);
    },
  );

  // Raw audio bodies only here: a child scope keeps the parser and its error wording off every other route.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(AUDIO_CONTENT_TYPE, { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    scope.setErrorHandler((err: FastifyError) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE")
        throw new HttpError(
          413,
          "VALIDATION_FAILED",
          `Recordings can be up to ${VOICE_MAX_AUDIO_BYTES / 1024 / 1024} MB. Record a shorter clip.`,
          { reason: "audio_too_large" },
        );
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") throw unsupportedType();
      throw err; // the app's error handler renders everything else
    });

    scope.withTypeProvider<ZodTypeProvider>().post(
      "/v1/voice/transcribe",
      {
        bodyLimit: VOICE_MAX_AUDIO_BYTES,
        config: { rateLimit: providerLimit },
        schema: { querystring: TranscribeQuery, headers: TranscribeHeaders, response: { 200: Transcript } },
      },
      async (req) => {
        const type = VoiceAudioType.safeParse(
          (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase(),
        );
        if (!type.success) throw unsupportedType();
        if (!Buffer.isBuffer(req.body) || req.body.length === 0)
          throw new HttpError(400, "VALIDATION_FAILED", "The recording is empty. Try again.", {
            reason: "audio_empty",
          });
        return transcribeClip(vd, ctx(req), {
          projectId: req.query.projectId,
          audio: req.body,
          type: type.data,
          durationMs: req.headers["x-audio-duration-ms"],
        });
      },
    );
  });
}

const unsupportedType = () =>
  new HttpError(
    415,
    "VALIDATION_FAILED",
    `Recordings must be one of: ${VoiceAudioType.options.join(", ")}.`,
    {
      reason: "audio_type_unsupported",
    },
  );

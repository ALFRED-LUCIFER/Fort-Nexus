import type { AiConfidence } from "@nexus/contracts";
import { ApiRequestError } from "../lib/api.ts";

// Anything AI-written (FR-RES-08, FR-MON-07) reads as unverified inference with its confidence and model, never as
// fact. Text only: the label is the same in every theme and needs no colour to be understood.

/** `confidence` is left out when each item carries its own (triage hypotheses). */
export function AiLabel({ confidence, model }: { confidence?: AiConfidence; model: string }) {
  return (
    <p className="kicker m-0 text-ink2">
      AI inference: unverified · {confidence && `${confidence.toLowerCase()} confidence · `}
      {model}
    </p>
  );
}

/** Not configured (no or unusable ai.json) gets the setup hint, as in Talk; anything else is an error. */
export function AiError({ error }: { error: Error }) {
  const reason =
    error instanceof ApiRequestError ? (error.details as { reason?: string } | undefined)?.reason : null;
  if (reason === "ai_provider_not_configured" || reason === "ai_provider_config_invalid")
    return (
      <div role="alert" className="flex flex-col gap-1 rounded-xl bg-hair px-3 py-2.5">
        <span className="text-[13px] font-medium text-ink">AI isn&apos;t set up yet</span>
        <span className="text-[12.5px] leading-snug text-ink2">{error.message}</span>
      </div>
    );
  return (
    <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
      {error.message}
    </p>
  );
}

import { readFile, stat } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import AnthropicFoundry from "@anthropic-ai/foundry-sdk";
import { z } from "zod";
import { HttpError } from "./errors.ts";

// ADR-0003: Anthropic API or Microsoft Foundry, chosen by ~/.nexus/ai.json; one place builds the client.
// shortcut: duplicates the runner's schema and file checks (apps/runner/src/ai-config.ts); move both to a shared
// package after P1 merges.
export const AI_RUNBOOK = "docs/runbooks/ai-provider.md";
const REQUEST_TIMEOUT_MS = 60_000;

const ApiKey = z.string().regex(/^[\w.~+/=-]{20,512}$/);
const Model = z
  .string()
  .regex(/^[\w.:@/-]{1,128}$/)
  .default("claude-opus-5-5");

const AiConfig = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("anthropic"), apiKey: ApiKey, model: Model }),
  z
    .strictObject({
      provider: z.literal("foundry"),
      apiKey: ApiKey,
      model: Model,
      resource: z
        .string()
        .regex(/^[a-z0-9-]{2,64}$/)
        .optional(),
      baseUrl: z
        .url({ protocol: /^https$/ })
        .refine((u) => new URL(u).port === "", "baseUrl must use the default https port")
        .optional(),
    })
    .refine((c) => (c.resource === undefined) !== (c.baseUrl === undefined), {
      message: "set exactly one of resource or baseUrl",
    }),
]);

// The Messages surface both clients share (Foundry has no batches).
export type AiClient = { client: { messages: Pick<Anthropic.Messages, "create"> }; model: string };

/**
 * Reads the provider config on every call (key rotation needs no restart) and builds the client.
 * Missing or unusable config → 409 naming the file and runbook; messages never include the file's content.
 */
export async function loadAi(file: string): Promise<AiClient> {
  const fail = (reason: "ai_provider_not_configured" | "ai_provider_config_invalid", message: string) =>
    new HttpError(409, "CONFLICT", message, { reason, file, runbook: AI_RUNBOOK });
  const invalid = (why: string) =>
    fail("ai_provider_config_invalid", `${file} ${why}. See ${AI_RUNBOOK} on the home machine.`);

  const st = await stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT")
      throw fail(
        "ai_provider_not_configured",
        `Talk needs an AI provider. On the home machine create ${file} with mode 0600 (see ${AI_RUNBOOK}), then send again.`,
      );
    throw invalid(`could not be read (${err.code ?? "error"})`);
  });
  if (!st.isFile()) throw invalid("is not a regular file");
  if ((st.mode & 0o077) !== 0) throw invalid("must not be readable by group or others: run chmod 600");
  if (process.getuid && st.uid !== process.getuid()) throw invalid("must be owned by the API user");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalid("is not valid JSON"); // JSON.parse messages quote the input: never pass them on
  }
  const parsed = AiConfig.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      `is invalid (${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ")})`,
    );
  const c = parsed.data;
  const common = { apiKey: c.apiKey, timeout: REQUEST_TIMEOUT_MS };
  if (c.provider === "anthropic") return { client: new Anthropic(common), model: c.model };
  return {
    client: c.resource
      ? new AnthropicFoundry({ ...common, resource: c.resource })
      : new AnthropicFoundry({ ...common, resource: null, baseURL: c.baseUrl }), // null: ignore the env var
    model: c.model,
  };
}

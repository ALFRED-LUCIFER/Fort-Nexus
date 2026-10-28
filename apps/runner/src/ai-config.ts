import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Coding-engine provider config (ADR-0003): ~/.nexus/ai.json, mode 0600, owned by the runner user.
export const AI_CONFIG_FILE = join(homedir(), ".nexus", "ai.json");
export const DEFAULT_MODEL = "claude-opus-5-5";
const RUNBOOK = "docs/runbooks/ai-provider.md";

const ApiKey = z.string().regex(/^[\w.~+/=-]{20,512}$/);
const Model = z
  .string()
  .regex(/^[\w.:@/-]{1,128}$/)
  .default(DEFAULT_MODEL);

const AiConfig = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("anthropic"), apiKey: ApiKey, model: Model }),
  z
    .strictObject({
      provider: z.literal("foundry"),
      apiKey: ApiKey,
      model: Model,
      // Bare Foundry resource name (https://<resource>.services.ai.azure.com), as Claude Code expects it.
      resource: z
        .string()
        .regex(/^[a-z0-9-]{2,64}$/)
        .optional(),
      // https on the default port only: the egress proxy allows host:443 and nothing else.
      baseUrl: z
        .url({ protocol: /^https$/ })
        .refine((u) => new URL(u).port === "", "baseUrl must use the default https port")
        .optional(),
    })
    .refine((c) => (c.resource === undefined) !== (c.baseUrl === undefined), {
      message: "set exactly one of resource or baseUrl",
    }),
]);

export type AiProvider = {
  provider: "anthropic" | "foundry";
  model: string;
  /** The only host the job container may reach (port 443). */
  host: string;
  /** Plain container env (no secrets). */
  env: Record<string, string>;
  /** Secret container env: passed by name only, never logged. */
  secretEnv: Record<string, string>;
};

export type AiConfigReason = "ai_provider_not_configured" | "ai_provider_config_invalid";

export class AiConfigError extends Error {
  readonly reason: AiConfigReason;
  readonly path: string;
  constructor(reason: AiConfigReason, path: string, message: string) {
    super(message);
    this.reason = reason;
    this.path = path;
  }
}

/** Reads and validates the provider config. Errors never include file content (it holds the key). */
export async function loadAiProvider(file = AI_CONFIG_FILE): Promise<AiProvider> {
  const invalid = (why: string) =>
    new AiConfigError("ai_provider_config_invalid", file, `${file} ${why} (see ${RUNBOOK})`);
  const st = await stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT")
      throw new AiConfigError(
        "ai_provider_not_configured",
        file,
        `AI provider is not configured: create ${file} with mode 0600 (see ${RUNBOOK})`,
      );
    throw invalid(`could not be read (${err.code ?? "error"})`);
  });
  if (!st.isFile()) throw invalid("is not a regular file");
  if ((st.mode & 0o077) !== 0) throw invalid("must not be readable by group or others: run chmod 600");
  if (process.getuid && st.uid !== process.getuid()) throw invalid("must be owned by the runner user");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalid("is not valid JSON"); // JSON.parse messages quote the input: never pass them on
  }
  const parsed = AiConfig.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
    throw invalid(`is invalid: ${fields.join("; ")}`);
  }
  const c = parsed.data;
  if (c.provider === "anthropic")
    return {
      provider: "anthropic",
      model: c.model,
      host: "api.anthropic.com",
      env: {},
      secretEnv: { ANTHROPIC_API_KEY: c.apiKey },
    };
  return {
    provider: "foundry",
    model: c.model,
    host: c.resource ? `${c.resource}.services.ai.azure.com` : new URL(c.baseUrl ?? "").hostname,
    env: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ...(c.resource
        ? { ANTHROPIC_FOUNDRY_RESOURCE: c.resource }
        : { ANTHROPIC_FOUNDRY_BASE_URL: c.baseUrl ?? "" }),
    },
    secretEnv: { ANTHROPIC_FOUNDRY_API_KEY: c.apiKey },
  };
}

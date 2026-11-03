import type Anthropic from "@anthropic-ai/sdk";

// FR-CSP-08: the cost of one Messages API response, from the provider's `usage` × the model's price, never from model
// text. USD per million tokens, Anthropic first-party rates (Microsoft Foundry bills Claude at the same rates).
// Source: the claude-api skill's model table (cached 2026-10-06) and its prompt-caching economics: cache writes are
// 1.25× input (5-minute TTL) and 2× input (1-hour TTL); cache reads are 0.1× input except where a model lists its own.
// shortcut: a static table; update it with each model release (an unknown model is billed at the highest listed price).

type Price = { input: number; output: number; cacheRead: number };

const PRICES: Readonly<Record<string, Price>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
// Claude Haiku 5.5 is billed at its long-prompt rate when the whole prompt is over 100K tokens.
const LONG_PROMPT = {
  model: "claude-haiku-5-5",
  over: 100_000,
  price: { input: 0.5, output: 2.5, cacheRead: 0.05 },
};
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

const HIGHEST: Price = {
  input: Math.max(...Object.values(PRICES).map((p) => p.input)),
  output: Math.max(...Object.values(PRICES).map((p) => p.output)),
  cacheRead: Math.max(...Object.values(PRICES).map((p) => p.cacheRead)),
};

/** The listed model id `model` names: exact, or a dated/suffixed form of the longest listed id it starts with. */
function listedModel(model: string): string | null {
  const id = model.toLowerCase().replace(/^anthropic\./, "");
  if (PRICES[id]) return id;
  const prefixes = Object.keys(PRICES).filter((k) => id.startsWith(`${k}-`) || id.startsWith(`${k}@`));
  return prefixes.sort((a, b) => b.length - a.length)[0] ?? null;
}

export type CostUsage = Pick<
  Anthropic.Usage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
> & { cache_creation?: Anthropic.CacheCreation | null };

/** USD for one response's usage. A model NEXUS doesn't know is priced at the highest listed rates (conservative). */
export function costUsd(model: string, usage: CostUsage): number {
  const listed = listedModel(model);
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + written + read;
  const p =
    listed === null
      ? HIGHEST
      : listed === LONG_PROMPT.model && prompt > LONG_PROMPT.over
        ? LONG_PROMPT.price
        : PRICES[listed]!;
  // The TTL breakdown when the provider sends it; otherwise every write is billed at the 5-minute rate.
  const oneHour = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const fiveMinute = written - oneHour;
  const total =
    usage.input_tokens * p.input +
    fiveMinute * p.input * CACHE_WRITE_5M +
    oneHour * p.input * CACHE_WRITE_1H +
    read * p.cacheRead +
    usage.output_tokens * p.output;
  return total / 1e6;
}

/** Upper bound for one call: every prompt token written to the cache at the 5-minute rate, plus `maxTokens` out. */
export const worstCaseCostUsd = (model: string, promptTokens: number, maxTokens: number) =>
  costUsd(model, {
    input_tokens: 0,
    cache_creation_input_tokens: promptTokens,
    cache_read_input_tokens: 0,
    output_tokens: maxTokens,
  });

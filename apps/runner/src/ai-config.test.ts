import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiConfigError, DEFAULT_MODEL, loadAiProvider } from "./ai-config.ts";
import { FAKE_KEY } from "./test-support.ts";

let dir = "";
let file = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexus-ai-"));
  file = join(dir, "ai.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const write = async (content: unknown, mode = 0o600) => {
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), { mode });
  await chmod(file, mode); // writeFile's mode is masked by the umask
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => {
      if (!(err instanceof AiConfigError)) throw err;
      return err;
    },
  );

describe("loadAiProvider", () => {
  it("anthropic: only api.anthropic.com, key as secret env, default model", async () => {
    await write({ provider: "anthropic", apiKey: FAKE_KEY });
    expect(await loadAiProvider(file)).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODEL,
      host: "api.anthropic.com",
      env: {},
      secretEnv: { ANTHROPIC_API_KEY: FAKE_KEY },
    });
  });

  it("foundry by resource name or https base URL", async () => {
    await write({ provider: "foundry", resource: "my-res", apiKey: FAKE_KEY, model: "claude-sonnet-5" });
    expect(await loadAiProvider(file)).toEqual({
      provider: "foundry",
      model: "claude-sonnet-5",
      host: "my-res.services.ai.azure.com",
      env: { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "my-res" },
      secretEnv: { ANTHROPIC_FOUNDRY_API_KEY: FAKE_KEY },
    });
    const baseUrl = "https://my-res.services.ai.azure.com/anthropic";
    await write({ provider: "foundry", baseUrl, apiKey: FAKE_KEY });
    expect(await loadAiProvider(file)).toMatchObject({
      host: "my-res.services.ai.azure.com",
      env: { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_BASE_URL: baseUrl },
    });
  });

  it("missing file: ai_provider_not_configured, naming the file to create", async () => {
    const err = await failure(loadAiProvider(file));
    expect(err.reason).toBe("ai_provider_not_configured");
    expect(err.path).toBe(file);
    expect(err.message).toContain(`create ${file} with mode 0600`);
  });

  it.each([0o644, 0o640, 0o604])("refuses mode %o (readable beyond the owner)", async (mode) => {
    await write({ provider: "anthropic", apiKey: FAKE_KEY }, mode);
    const err = await failure(loadAiProvider(file));
    expect(err.reason).toBe("ai_provider_config_invalid");
    expect(err.message).toMatch(/chmod 600/);
  });

  it.each([
    ["unknown provider", { provider: "openai", apiKey: FAKE_KEY }],
    ["extra keys", { provider: "anthropic", apiKey: FAKE_KEY, baseUrl: "https://evil.example" }],
    [
      "foundry with both resource and baseUrl",
      { provider: "foundry", resource: "r1", baseUrl: "https://a.b", apiKey: FAKE_KEY },
    ],
    ["foundry with neither", { provider: "foundry", apiKey: FAKE_KEY }],
    [
      "foundry over http",
      { provider: "foundry", baseUrl: "http://my-res.services.ai.azure.com", apiKey: FAKE_KEY },
    ],
    [
      "foundry on another port",
      { provider: "foundry", baseUrl: "https://my-res.services.ai.azure.com:8443", apiKey: FAKE_KEY },
    ],
    ["a resource that is a URL", { provider: "foundry", resource: "https://x", apiKey: FAKE_KEY }],
    ["a key with whitespace", { provider: "anthropic", apiKey: `${FAKE_KEY} x` }],
  ])("rejects %s without echoing the key", async (_, content) => {
    await write(content);
    const err = await failure(loadAiProvider(file));
    expect(err.reason).toBe("ai_provider_config_invalid");
    expect(err.message).not.toContain(FAKE_KEY.slice(0, 20));
  });

  it("broken JSON never quotes the file content", async () => {
    await write(`{"provider":"anthropic","apiKey":"${FAKE_KEY}",`);
    const err = await failure(loadAiProvider(file));
    expect(err.message).toContain("is not valid JSON");
    expect(err.message).not.toContain("sk-ant");
  });
});

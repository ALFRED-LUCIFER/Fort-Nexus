import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_MAX_AUDIO_BYTES,
  type Project,
  type Transcript,
  type VoiceStatus,
  type WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords } from "../src/db/schema.ts";
import { HttpError } from "../src/errors.ts";
import { localDate } from "../src/research/schedule.ts";
import { providerFailure, ssml, transcribe } from "../src/voice/azure.ts";
import { VOICE_RUNBOOK, loadVoice } from "../src/voice/config.ts";
import { voiceUsage } from "../src/voice/schema.ts";
import { transcribeClip } from "../src/voice/service.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// Cofounder wave B: the VoiceGateway. No live Azure: fetch is stubbed per test and answers as the provider would,
// so the exact URL, headers and multipart/SSML body NEXUS sends are asserted. Production code end to end otherwise.

// A zone far from UTC, so the owner's local day differs from the UTC day for half of every day.
const TZ = "Pacific/Kiritimati";
const KEY = randomBytes(24).toString("hex");
const SPEECH_KEY = randomBytes(24).toString("hex");
const STT_URL =
  "https://my-foundry.openai.azure.com/openai/deployments/gpt-4o-mini-transcribe/audio/transcriptions?api-version=2025-04-01-preview";
const TTS_URL = "https://eastus2.tts.speech.microsoft.com/cognitiveservices/v1";

let t: TestApp;
let db: Db;
let sql: { end(): Promise<void> };
let cookie: string;
let dir: string;
let voiceFile: string;
let home: Project;
let ws: WorkspaceList;
let ip = "127.0.0.1";
let tests = 0;

const full = {
  provider: "foundry",
  resource: "my-foundry",
  apiKey: KEY,
  transcribe: { deployment: "gpt-4o-mini-transcribe" },
  speech: { region: "eastus2", apiKey: SPEECH_KEY },
};
function writeVoice(content: unknown, mode = 0o600, file = voiceFile) {
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  chmodSync(file, mode);
  return file;
}

// The provider: every request NEXUS makes, and the answer the test chose.
const sent: Request[] = [];
let respond: (req: Request) => Response | Promise<Response>;
function stubProvider() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    sent.push(req.clone());
    return respond(req);
  });
}

const call = (method: "GET" | "PUT" | "POST" | "PATCH", url: string, body?: unknown) =>
  t.app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: { cookie, origin: t.config.publicOrigin },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const status = async () => (await call("GET", "/v1/voice/status")).json<VoiceStatus>();
async function settings(body: Record<string, unknown>) {
  const res = await call("PUT", "/v1/voice/settings", body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<VoiceStatus>();
}
const CLIP = Buffer.from("OggS-fake-opus-clip-bytes");
const postClip = (
  projectId: string,
  body: Buffer = CLIP,
  type = "audio/webm;codecs=opus",
  durationMs = 4200,
) =>
  t.app.inject({
    method: "POST",
    url: `/v1/voice/transcribe?projectId=${projectId}`,
    remoteAddress: ip,
    headers: {
      cookie,
      origin: t.config.publicOrigin,
      "content-type": type,
      "x-audio-duration-ms": String(durationMs),
    },
    payload: body,
  });
const speak = (text: string, projectId = home.id) => call("POST", "/v1/voice/speak", { projectId, text });
const audits = (action: string) =>
  db.select().from(auditRecords).where(eq(auditRecords.action, action)).orderBy(auditRecords.occurredAt);
const usageRows = () => db.select().from(voiceUsage);
const reason = (res: { json: () => unknown }) =>
  (res.json() as { error: { details?: { reason?: string } } }).error.details?.reason;

async function newProject() {
  const slug = `p-${randomBytes(3).toString("hex")}`;
  const wsId = ws.items.find((w) => w.mode === "DEV")!.id;
  const res = await call("POST", `/v1/workspaces/${wsId}/projects`, { name: slug, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Project>();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-voice-"));
  voiceFile = join(dir, "voice.json");
  t = await createTestApp({ NEXUS_VOICE_FILE: voiceFile, OWNER_TIMEZONE: TZ });
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ws = (await call("GET", "/v1/workspaces")).json<WorkspaceList>();
  home = ws.items.find((w) => w.mode === "DEV")!.projects.find((p) => p.slug === "home")!;
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  ip = `127.0.${Math.floor(++tests / 250)}.${tests % 250}`;
  sent.length = 0;
  respond = () => {
    throw new Error("unexpected provider call");
  };
  stubProvider();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(voiceFile, { force: true });
});

describe("loadVoice (~/.nexus/voice.json)", () => {
  const reasonOf = async (file: string) => {
    const err = await loadVoice(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ file, runbook: VOICE_RUNBOOK });
    expect(e.message).toContain(file);
    expect(e.message).toContain(VOICE_RUNBOOK);
    expect(e.message).not.toContain(KEY);
    return { reason: (e.details as { reason: string }).reason, message: e.message };
  };

  it("is missing, world-readable, not a file, not JSON, has unknown fields or a bad combination", async () => {
    expect(await reasonOf(join(dir, "absent.json"))).toMatchObject({ reason: "voice_not_configured" });
    const invalid = async (content: unknown, mode = 0o600, why?: RegExp) => {
      const r = await reasonOf(writeVoice(content, mode, join(dir, `v-${randomUUID()}.json`)));
      expect(r.reason).toBe("voice_config_invalid");
      if (why) expect(r.message).toMatch(why);
    };
    await invalid(full, 0o644, /chmod 600/);
    await invalid(`{"apiKey": "${KEY}"`, 0o600, /not valid JSON/);
    await invalid({ ...full, region: "eastus2" }, 0o600, /unrecognized_keys/);
    await invalid({ ...full, transcribe: { deployment: "x", extra: 1 } });
    await invalid({ ...full, baseUrl: "https://voice.example.com" }, 0o600, /custom/);
    await invalid({ ...full, resource: undefined }); // transcribe needs an endpoint
    await invalid({ provider: "foundry", resource: "my-foundry", apiKey: KEY }); // neither half
    await invalid({ ...full, resource: undefined, baseUrl: "https://voice.example.com:8443" });
    await invalid({ ...full, resource: undefined, baseUrl: "http://voice.example.com" });
    await invalid({ ...full, speech: { region: "eastus2", voice: "<evil/>" } });
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    expect((await reasonOf(sub)).message).toMatch(/not a regular file/);
  });

  it("defaults the voice and the Speech key, and accepts a custom https origin", async () => {
    const c = await loadVoice(
      writeVoice({
        provider: "foundry",
        baseUrl: "https://voice.example.com",
        apiKey: KEY,
        transcribe: { deployment: "stt" },
        speech: { region: "westeurope" },
      }),
    );
    expect(c).toEqual({
      transcribe: {
        endpoint: "https://voice.example.com",
        resourceLabel: "voice.example.com",
        deployment: "stt",
        apiKey: KEY,
      },
      speech: { region: "westeurope", voice: "en-US-AvaMultilingualNeural", apiKey: KEY },
    });
  });
});

describe("GET /v1/voice/status", () => {
  it("not configured: no providers, defaults, nothing recorded", async () => {
    const s = await status();
    expect(s).toEqual({
      configured: false,
      transcribe: null,
      speak: null,
      disclosure: ["Voice isn't set up on the home machine, so nothing is recorded or sent anywhere."],
      runbook: VOICE_RUNBOOK,
      problem: null,
      settings: { micEnabled: false, speakReplies: false, speechRate: 1, language: "auto" },
      usageToday: { transcribedSeconds: 0, spokenCharacters: 0 },
    });
  });

  it("names who processes what, per configured half, and never echoes a key", async () => {
    writeVoice({ ...full, speech: undefined });
    const stt = await status();
    expect(stt).toMatchObject({
      configured: true,
      transcribe: { provider: "AZURE_OPENAI", deployment: "gpt-4o-mini-transcribe" },
      speak: null,
    });
    expect(stt.disclosure).toEqual([
      "Your recording is sent to Azure OpenAI (deployment gpt-4o-mini-transcribe) on your Foundry resource my-foundry to turn it into text.",
      "Microsoft doesn't use it to train models; prompts and audio may be kept for abuse monitoring in your resource's region.",
      "Nothing is recorded until you press the mic.",
    ]);

    writeVoice({ provider: "foundry", apiKey: KEY, speech: { region: "eastus2" } });
    const tts = await status();
    expect(tts).toMatchObject({
      configured: true,
      transcribe: null,
      speak: { provider: "AZURE_SPEECH", voice: "en-US-AvaMultilingualNeural" },
    });
    expect(tts.disclosure).toEqual([
      "Replies you choose to hear are sent to Azure AI Speech (voice en-US-AvaMultilingualNeural, region eastus2) to be spoken.",
      "Azure AI Speech doesn't store the text it speaks.",
      "Nothing is recorded until you press the mic.",
    ]);

    writeVoice(full);
    const both = await call("GET", "/v1/voice/status");
    expect(both.json<VoiceStatus>().disclosure).toHaveLength(5);
    expect(both.body).not.toContain(KEY);
    expect(both.body).not.toContain(SPEECH_KEY);
  });

  it("an invalid file is a problem, not configured, and its content stays out", async () => {
    writeVoice({ ...full, apiKey: `${KEY} with spaces` });
    const res = await call("GET", "/v1/voice/status");
    const s = res.json<VoiceStatus>();
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/voice\.json is invalid \(apiKey: invalid_format\)/);
    expect(res.body).not.toContain(KEY);
    writeVoice(full, 0o640);
    expect((await status()).problem).toMatch(/chmod 600/);
  });

  it("needs a session", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/voice/status" })).statusCode).toBe(401);
  });
});

describe("PUT /v1/voice/settings", () => {
  it("validates, saves, audits the changed field names and needs a trusted origin", async () => {
    for (const bad of [
      {},
      { speechRate: 2 },
      { speechRate: 0.5 },
      { language: "EN" },
      { language: "english" },
      { micEnabled: "yes" },
      { volume: 1 },
    ])
      expect((await call("PUT", "/v1/voice/settings", bad)).statusCode, JSON.stringify(bad)).toBe(400);

    const s = await settings({ micEnabled: true, language: "de-DE" });
    expect(s.settings).toEqual({ micEnabled: true, speakReplies: false, speechRate: 1, language: "de-DE" });
    expect((await status()).settings.language).toBe("de-DE");
    const [a] = await audits("voice.settings");
    expect(a).toMatchObject({ resourceType: "voice", outcome: "SUCCEEDED" });
    expect(a!.metadata).toEqual({ changed: ["micEnabled", "language"], micEnabled: true });

    await settings({ micEnabled: true }); // no change, no record
    expect(await audits("voice.settings")).toHaveLength(1);

    const csrf = await t.app.inject({
      method: "PUT",
      url: "/v1/voice/settings",
      headers: { cookie, origin: "https://evil.example" },
      payload: { micEnabled: false },
    });
    expect(csrf.statusCode).toBe(403);
    expect((await status()).settings.micEnabled).toBe(true);
    await settings({ micEnabled: false, language: "auto" });
  });
});

describe("POST /v1/voice/transcribe", () => {
  beforeEach(async () => {
    await settings({ micEnabled: true, language: "en-US" });
  });
  afterEach(async () => {
    await settings({ micEnabled: false, speakReplies: false, language: "auto", speechRate: 1 });
  });

  it("sends the clip as multipart to the deployment and returns the text for review", async () => {
    writeVoice(full);
    respond = () => Response.json({ text: "  Ship the cart fix.  " });
    const before = (await status()).usageToday.transcribedSeconds;
    const res = await postClip(home.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Transcript>()).toEqual({
      text: "Ship the cart fix.",
      durationMs: 4200,
      provider: "AZURE_OPENAI",
      deployment: "gpt-4o-mini-transcribe",
    });

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(STT_URL);
    expect(req.headers.get("api-key")).toBe(KEY);
    expect(req.redirect).toBe("manual");
    const form = await req.formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("clip.webm");
    expect(file.type).toBe("audio/webm");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(CLIP);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("response_format")).toBe("json");

    expect((await status()).usageToday.transcribedSeconds).toBeCloseTo(before + 4.2);
    const [a] = (await audits("voice.transcribe")).slice(-1);
    expect(a).toMatchObject({ resourceType: "voice", resourceId: home.id, outcome: "SUCCEEDED" });
    expect(a!.metadata).toMatchObject({ projectId: home.id, durationMs: 4200, bytes: CLIP.length });
    expect(JSON.stringify(a)).not.toContain("cart fix");
  });

  it("auto language sends none; mp4 gets its extension; a custom origin is used as is", async () => {
    await settings({ language: "auto" });
    writeVoice({ ...full, resource: undefined, baseUrl: "https://voice.example.com" });
    respond = () => Response.json({ text: "hello" });
    expect((await postClip(home.id, CLIP, "audio/mp4")).statusCode).toBe(200);
    const req = sent[0]!;
    expect(new URL(req.url).origin).toBe("https://voice.example.com");
    const form = await req.formData();
    expect(form.has("language")).toBe(false);
    expect((form.get("file") as File).name).toBe("clip.mp4");
  });

  it("refuses with the mic off (403), voice not set up (409), and audits the refusal", async () => {
    writeVoice(full);
    await settings({ micEnabled: false });
    const off = await postClip(home.id);
    expect(off.statusCode).toBe(403);
    expect(off.json<{ error: { message: string } }>().error.message).toContain("Settings → Voice & consent");
    expect((await audits("voice.transcribe")).slice(-1)[0]).toMatchObject({ outcome: "DENIED" });

    await settings({ micEnabled: true });
    rmSync(voiceFile);
    const missing = await postClip(home.id);
    expect(missing.statusCode).toBe(409);
    expect(reason(missing)).toBe("voice_not_configured");
    expect(missing.json<{ error: { details: { runbook: string } } }>().error.details.runbook).toBe(
      VOICE_RUNBOOK,
    );

    writeVoice({ provider: "foundry", apiKey: KEY, speech: { region: "eastus2" } });
    const half = await postClip(home.id);
    expect(half.statusCode).toBe(409);
    expect(reason(half)).toBe("voice_transcribe_not_configured");
    expect(sent).toHaveLength(0);
  });

  it("413 over the size or duration limit, 415 for other types, 400 for an empty clip", async () => {
    writeVoice(full);
    const big = await postClip(home.id, Buffer.alloc(VOICE_MAX_AUDIO_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect(reason(big)).toBe("audio_too_large");
    const long = await postClip(home.id, CLIP, "audio/webm", 120_001);
    expect(long.statusCode).toBe(413);
    expect(reason(long)).toBe("audio_too_long");
    for (const type of ["text/plain", "application/json", "audio/flac"]) {
      const res = await postClip(home.id, CLIP, type);
      expect(res.statusCode, type).toBe(415);
      expect(reason(res)).toBe("audio_type_unsupported");
    }
    expect((await postClip(home.id, Buffer.alloc(0))).statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("a decoy project, another owner and an archived project never transcribe", async () => {
    writeVoice(full);
    expect((await postClip(randomUUID())).statusCode).toBe(404);
    await expect(
      transcribeClip(
        { db, voiceFile, timezone: TZ },
        { ownerId: "someone-else", correlationId: randomUUID() },
        { projectId: home.id, audio: CLIP, type: "audio/webm", durationMs: 1000 },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const archived = await newProject();
    expect((await call("PATCH", `/v1/projects/${archived.id}`, { archived: true })).statusCode).toBe(200);
    expect((await postClip(archived.id)).statusCode).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("a provider failure is owner-safe, audited as FAILED and not counted", async () => {
    writeVoice(full);
    const before = (await status()).usageToday.transcribedSeconds;
    respond = () => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 });
    const res = await postClip(home.id);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: { code: "INTERNAL", details: { reason: "voice_provider_auth" } },
    });
    expect(res.body).not.toContain(KEY);
    expect((await audits("voice.transcribe")).slice(-1)[0]).toMatchObject({
      outcome: "FAILED",
      metadata: expect.objectContaining({ reason: "voice_provider_auth" }),
    });
    expect((await status()).usageToday.transcribedSeconds).toBe(before);
  });

  it("counts usage per local day: yesterday's row stays, today's grows", async () => {
    writeVoice(full);
    const ownerId = (await call("GET", "/v1/me")).json<{ id: string }>().id;
    const yesterday = localDate(new Date(Date.now() - 86_400_000), TZ);
    await db
      .insert(voiceUsage)
      .values({ ownerId, localDate: yesterday, transcribedSeconds: 600, spokenCharacters: 9000 })
      .onConflictDoNothing();
    const today = (await status()).usageToday;
    expect(today.transcribedSeconds).toBeLessThan(600);
    respond = () => Response.json({ text: "ok" });
    expect((await postClip(home.id, CLIP, "audio/ogg", 1500)).statusCode).toBe(200);
    const rows = await usageRows();
    expect(rows.find((r) => r.localDate === yesterday)).toMatchObject({
      transcribedSeconds: 600,
      spokenCharacters: 9000,
    });
    expect(rows.find((r) => r.localDate === localDate(new Date(), TZ))!.transcribedSeconds).toBeCloseTo(
      today.transcribedSeconds + 1.5,
    );
  });
});

describe("Azure clients", () => {
  const stt = {
    endpoint: "https://my-foundry.openai.azure.com",
    resourceLabel: "my-foundry",
    deployment: "gpt-4o-mini-transcribe",
    apiKey: KEY,
  };
  const clip = { audio: CLIP, type: "audio/webm" as const, language: "auto" };

  it("maps every provider answer to an owner-safe status, code and reason", async () => {
    const cases: [Response | (() => never), number, string, string][] = [
      [new Response(KEY, { status: 401 }), 502, "INTERNAL", "voice_provider_auth"],
      [new Response(KEY, { status: 403 }), 502, "INTERNAL", "voice_provider_auth"],
      [new Response(KEY, { status: 404 }), 502, "INTERNAL", "voice_provider_not_found"],
      [new Response(KEY, { status: 400 }), 502, "INTERNAL", "voice_provider_rejected"],
      [new Response(KEY, { status: 429 }), 503, "RATE_LIMITED", "voice_provider_rate_limited"],
      [new Response(KEY, { status: 500 }), 503, "INTERNAL", "voice_provider_unavailable"],
      [new Response(KEY, { status: 503 }), 503, "INTERNAL", "voice_provider_unavailable"],
      [
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
        503,
        "INTERNAL",
        "voice_provider_unavailable",
      ],
      [new Response(`<html>${KEY}`, { status: 200 }), 503, "INTERNAL", "voice_provider_unavailable"],
      [Response.json({ txt: KEY }), 503, "INTERNAL", "voice_provider_unavailable"],
      [
        () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
        503,
        "INTERNAL",
        "voice_provider_unavailable",
      ],
      [
        () => {
          throw new TypeError("fetch failed", { cause: new Error(`ECONNREFUSED ${KEY}`) });
        },
        503,
        "INTERNAL",
        "voice_provider_unavailable",
      ],
    ];
    for (const [answer, httpStatus, code, why] of cases) {
      respond = () => (typeof answer === "function" ? answer() : answer);
      const err = await transcribe(stt, clip).catch((e: unknown) => e);
      expect(err, why).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ statusCode: httpStatus, code, details: { reason: why } });
      expect((err as HttpError).message).not.toContain(KEY);
    }
    expect(providerFailure("transcribe", 404, "stt").message).toContain("no deployment named stt");
    expect(providerFailure("speak", 401).message).toContain("Azure AI Speech rejected NEXUS's key");
  });

  it("builds SSML with the text escaped, the language and the rate", () => {
    const voice = "en-US-AvaMultilingualNeural";
    expect(ssml(`Tom & "Jerry" <b>it's</b>\u0007`, { voice, language: "auto", rate: 1.25 })).toBe(
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="+25%">Tom &amp; &quot;Jerry&quot; &lt;b&gt;it&apos;s&lt;/b&gt;</prosody></voice></speak>`,
    );
    expect(ssml("Bonjour", { voice, language: "fr", rate: 0.75 })).toContain(
      `xml:lang="fr"><voice name="${voice}"><prosody rate="-25%">Bonjour<`,
    );
    expect(ssml("Hi", { voice, language: "en-GB", rate: 1 })).toContain(`prosody rate="+0%"`);
  });
});

describe("POST /v1/voice/speak", () => {
  const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
  const TEXT = `Two runs passed & one failed: "cart" <rounding>. It's on #42.`;
  beforeEach(async () => {
    await settings({ speakReplies: true, speechRate: 1.25, language: "auto" });
  });
  afterEach(async () => {
    await settings({ micEnabled: false, speakReplies: false, language: "auto", speechRate: 1 });
  });

  it("answers MP3 from Azure AI Speech with server-built SSML, counts characters, audits no text", async () => {
    writeVoice(full);
    respond = () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    const before = (await status()).usageToday.spokenCharacters;
    const res = await speak(TEXT);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload).toEqual(MP3);

    const req = sent[0]!;
    expect(req.url).toBe(TTS_URL);
    expect(req.headers.get("ocp-apim-subscription-key")).toBe(SPEECH_KEY);
    expect(req.headers.get("content-type")).toBe("application/ssml+xml");
    expect(req.headers.get("x-microsoft-outputformat")).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(req.headers.get("user-agent")).toMatch(/^NEXUS-Voice\//);
    const body = await req.text();
    expect(body).toContain('xml:lang="en-US"');
    expect(body).toContain('<prosody rate="+25%">');
    expect(body).toContain(
      "Two runs passed &amp; one failed: &quot;cart&quot; &lt;rounding&gt;. It&apos;s on #42.",
    );

    expect((await status()).usageToday.spokenCharacters).toBe(before + TEXT.length);
    const [a] = (await audits("voice.speak")).slice(-1);
    expect(a).toMatchObject({ resourceId: home.id, outcome: "SUCCEEDED" });
    expect(a!.metadata).toMatchObject({ characters: TEXT.length });
    const all = JSON.stringify(
      await db.select().from(auditRecords).where(like(auditRecords.action, "voice.%")),
    );
    for (const secret of ["rounding", "cart", "Ship the cart fix", KEY, SPEECH_KEY])
      expect(all).not.toContain(secret);
  });

  it("403 with spoken replies off, 409 without the Speech half, validated body, decoy project", async () => {
    writeVoice({ ...full, speech: undefined });
    const half = await speak("Hello");
    expect(half.statusCode).toBe(409);
    expect(reason(half)).toBe("voice_speech_not_configured");

    writeVoice(full);
    await settings({ speakReplies: false });
    const off = await speak("Hello");
    expect(off.statusCode).toBe(403);
    expect(reason(off)).toBe("speak_disabled");
    await settings({ speakReplies: true });

    for (const body of [
      { projectId: home.id, text: "   " },
      { projectId: home.id, text: "x".repeat(2001) },
      { projectId: home.id, text: "Hi", voice: "other" },
      { projectId: "home", text: "Hi" },
    ])
      expect((await call("POST", "/v1/voice/speak", body)).statusCode).toBe(400);
    expect((await speak("Hello", randomUUID())).statusCode).toBe(404);
    expect(sent).toHaveLength(0);

    respond = () => new Response(null, { status: 429 });
    const limited = await speak("Hello");
    expect(limited.statusCode).toBe(503);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    const ownerId = (await call("GET", "/v1/me")).json<{ id: string }>().id;
    const [row] = await db
      .select()
      .from(voiceUsage)
      .where(and(eq(voiceUsage.ownerId, ownerId), eq(voiceUsage.localDate, localDate(new Date(), TZ))));
    expect(row?.spokenCharacters ?? 0).toBe((await status()).usageToday.spokenCharacters);
  });

  it("is rate limited per owner, whatever address the calls come from", async () => {
    writeVoice(full);
    respond = () => new Response(MP3);
    let limited = 0;
    for (let i = 0; i < 21 && limited === 0; i++) {
      ip = `127.1.0.${i + 1}`;
      if ((await speak("Hi")).statusCode === 429) limited = i;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

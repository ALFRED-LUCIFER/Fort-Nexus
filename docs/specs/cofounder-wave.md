# Cofounder wave: the Cofounder home, push-to-talk and spoken replies

Base: `main` after the Cofounder-wave contracts commit. The owner asked (2026-11-04) for the Cofounder home and for "calling": talking with the Cofounder by voice, using what works best with Microsoft Foundry.

PRD:
- §D.4 Cofounder home (adopted 2026-11-03): brief headline, KPIs, noticed, agent activity, execution, results this week, the Cofounder panel
- §A "Voice": a `VoiceGateway` abstraction; P1 push-to-talk (MediaRecorder → STT via Foundry); TTS via Azure AI Speech; Web Speech API where available
- FR-CWV-02/03 (push-to-talk, spoken replies with mute/replay/speed), FR-CHN-01, FR-CSP-02/05 (provider named in the consent UI; mic and TTS can be turned off separately), CWV-G06/G07/G08, FR-VOICE-04 (sensitive actions still need on-screen confirmation), FR-INB-07, FR-OBS-03

## Decisions

- **Home is the landing view.** `/` shows the Cofounder home. The zone board is `view=board` (Home | Board switch in the header). Drawers open over either view.
- **Every number is NEXUS's own record.** The headline is assembled by the server from counts, not by a model, so it is true, free and works without `ai.json`. Confidence stays a LOW/MEDIUM/HIGH label.
- **Speech-to-text:** an Azure OpenAI transcribe deployment (e.g. `gpt-4o-mini-transcribe`) on the owner's Foundry resource. It accepts Chrome's `audio/webm` and Safari's `audio/mp4` directly (25 MB cap; ours is 10 MB / 120 s). Classic endpoint `https://<resource>.openai.azure.com/openai/deployments/<deployment>/audio/transcriptions?api-version=2025-04-01-preview`, header `api-key`, multipart `file`, `model`, `language`, `response_format=json`. Sources: https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart, https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview
- **Spoken replies:** Azure AI Speech REST TTS (GA; "no data is persisted"), `POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`, headers `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, `X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3`, `User-Agent`. Default voice `en-US-AvaMultilingualNeural`. Source: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
- **One Foundry (AIServices) resource and key** serve Claude, the transcribe deployment and Speech; only the hosts differ. `voice.json` may carry a separate Speech key/region.
- **Without `voice.json`:** no server speech. The mic says how to set it up (no hidden recording, CWV-G06). Replies can still be spoken by the browser's own `speechSynthesis`, labelled "browser voice".
- **A transcript is never a command.** It fills the input for the owner to read and send. Anything that mutates still goes through the existing previews and approvals (FR-VOICE-04).
- **"Calling"** = a voice conversation with the Cofounder in the browser: hold or tap to talk → transcript → send → reply spoken → ready for the next turn. Phone calls (PSTN) are P3 and not in this wave.

## Contracts (binding; changes only through the coordinator)

Already on `main` in the contracts commit:
- `packages/contracts/src/home.ts`: `HomeQuery`, `HomeRef`, `HomeHeadline`, `HomeDecisions`, `HomeKpiKey`, `HomeKpi`, `HomeAgentActivity`, `HomeExecution`, `HomeResultKind`, `HomeResult`, `HomeSummary`.
- `packages/contracts/src/voice.ts`: `VOICE_AUDIO_TYPES`, `VOICE_MAX_AUDIO_BYTES`, `VOICE_MAX_SECONDS`, `VOICE_SPEAK_MAX_CHARS`, `VoiceSettings`, `DEFAULT_VOICE_SETTINGS`, `UpdateVoiceSettingsRequest`, `VoiceStatus`, `TranscribeQuery`, `Transcript`, `SpeakRequest`.
- API: `config.voiceFile` (`NEXUS_VOICE_FILE`, default `~/.nexus/voice.json`).
- Web: `api.home`, `api.voiceStatus`, `api.updateVoiceSettings`, `api.transcribe`, `api.speak` (Blob) and `keys.home`, `keys.voice`. Router: `view=home|board`; the default view comes from the router context (`createApp(history, defaultView)`; the app uses "home", `renderApp(path, { view })` in tests defaults to "board"). `Board.tsx` renders `HomeView` (`board/home.tsx`) for Home, with the Home | Board switch; `board/cofounder.tsx` exports `CofounderPanel({ projectId })`. Both files are coordinator stubs that C and D replace.

## Rules for every module

As in `docs/specs/jobs-wave.md` "Rules for every module": scope checks with decoy tests; production-ready (PRD §16 DoD); honest loading/empty/error/offline states; WCAG 2.2 AA; no secrets in code, logs or audit; audit metadata holds ids and counts only (never transcript or spoken text); dependencies only via `node scripts/with-lock.mjs` and only when unavoidable; don't edit files another builder owns; contract problems go in your report, not into `packages/contracts`.

## A: the home summary (API)

Owns: new `apps/api/src/home.ts`, new `apps/api/src/routes/home.ts` (one `.then(...)` line in `app.ts` after the last owner route, plus its import), new `apps/api/test/home.test.ts`.

`GET /v1/home` (`HomeQuery` → `HomeSummary`), owner session; `projectId` must be the owner's (`resolveProject`, 404 otherwise); omitted = all the owner's projects. Times in `config.ownerTimezone`.
- `date` / `time` / `timezone`: now, local.
- `decisions`: PENDING unexpired approvals, plans awaiting approval, READY/NEEDS_REPO job drafts, NEW opportunities; `top` = up to 5 newest across them, with a server-built title (issue `#n title`, plan goal, draft issue title or text, opportunity title) and expiry where it has one.
- `kpis`, exactly these four, each with a 7-day `series` (oldest → newest; null for days without data) and `previous` over the 7 days before:
  - `REVIEW_READY_MEDIAN` (minutes, better DOWN): median of job created → its first approval created, for jobs created in the window. Source "jobs + approvals · 7 days".
  - `TESTS_PASS_RATE` (ratio, better UP): jobs whose latest NEXUS-run verification is `passed` / jobs with a verification (`passed` or `failed`). Use the same verification rule as `job-history.ts` (reuse its code if it can be shared without editing it; otherwise mirror it). Source "NEXUS test runs · 7 days".
  - `RUNS_TODAY` (count, better UP): jobs created today; series = jobs per day.
  - `WAITING_ON_YOU` (count, better DOWN): `decisions` total now; series = approvals created per day that were still pending at day end, or simply null history if that can't be computed honestly (say so in a comment).
- `agents`: every `AgentKey` in order. WORKING when the agent has a non-terminal job not waiting on the owner (or a RUNNING deep dive for AI_RESEARCHER, or a RUNNING plan step for its agent); WAITING_ON_YOU when its newest active job is AWAITING_APPROVAL / BLOCKED / BLOCKED_NEEDS_INFO / RECOVERY_REQUIRED; else IDLE. `doing` is server-built from that record (e.g. `#42 cart rounding · test` from the issue snapshot and the latest run stage; `Deep dive · <question, cut to 80>`), with `ref`. `costTodayUsd` as in `job-history.ts` performance (jobs' estimatedCostUsd + ai_spend created today, DEEP_DIVE → AI_RESEARCHER, JOB_DRAFT → DEVELOPER).
- `execution`: non-terminal jobs, newest first, ≤ 8, with `stage` = the latest `stage` reported in its run events (null if none), `needsYou` by the same statuses as WAITING_ON_YOU.
- `results`: the last 7 local days, every `HomeResultKind` (zeros included) — PRs from EXECUTED approvals with a result; issues created from job drafts' `created_issue_number` and opportunities with an issue; TESTS_VERIFIED = jobs whose verification passed; COMPLETED deep dives; AI_SPEND = jobs' estimates + ai_spend (`coalesce(cost_usd, reserved_usd)`). Each with a short label and source.
- `headline`: deterministic segments from these facts, e.g. "2 things are ready for you: **a push for #42** and **1 opportunity**." / "Nothing needs you right now. **3 runs today**, 2 with passing tests." / for an empty project: "A quiet start. **Describe a job in plain words** and the Developer drafts it." `sources` = how many record kinds contributed (non-zero), `decisionsWaiting` = decisions total.
- Few queries (no N+1); one request ≤ ~10 queries is fine.

Tests (Testcontainers): every KPI incl. null days and `previous`; local-day boundary in a non-UTC timezone; agent states and `doing` text; execution stage from events; results incl. zeros; headline variants; decisions `top`; decoy project and other owner; All view = only the owner's projects; 401 without a session.

## B: voice gateway (API)

Owns: new `apps/api/src/voice/**` (config loader, Azure clients, service, routes, schema), `drizzle.config.ts` (add your schema), the migration you generate (the coordinator squashes it), one `.then(...)` line in `app.ts` plus its import, the `audit.ts` resourceType union if you need `"voice"`, new `docs/runbooks/voice.md`, new `apps/api/test/voice.test.ts`.

- **`~/.nexus/voice.json`** (`config.voiceFile`): the same file checks as `loadAi` (mode 0600, owned by the API user, strict JSON, errors name the file and runbook, never its content). Shape (strict Zod):
  ```json
  {
    "provider": "foundry",
    "resource": "my-foundry-resource",
    "apiKey": "…",
    "transcribe": { "deployment": "gpt-4o-mini-transcribe" },
    "speech": { "region": "eastus2", "voice": "en-US-AvaMultilingualNeural", "apiKey": "…optional, defaults to apiKey" }
  }
  ```
  `resource` or `baseUrl` (https, default port: `https://<resource>.openai.azure.com`), not both. `transcribe` and `speech` are each optional, but at least one is required. Read on every request, like `ai.json` (no restart to rotate).
- **Tables:** `voice_settings` (owner id PK, the `VoiceSettings` fields, updated_at) and `voice_usage` (owner id, local date, transcribed_seconds, spoken_characters; unique (owner, date); upsert-increment).
- **`GET /v1/voice/status`** → `VoiceStatus`. `disclosure` sentences, server-written: who processes the audio ("Your recording is sent to Azure OpenAI (deployment X) on your Foundry resource Y to turn it into text."), retention ("Microsoft doesn't use it to train models; prompts and audio may be kept for abuse monitoring in your resource's region." for Azure OpenAI; "Azure AI Speech doesn't store the text it speaks." for Speech), and "Nothing is recorded until you press the mic." `problem` = the owner-safe file error when the file exists but is invalid.
- **`PUT /v1/voice/settings`** (`UpdateVoiceSettingsRequest`) → `VoiceStatus`. Audit `voice.settings` (which fields changed, not values of text). CSRF/origin check as every owner mutation.
- **`POST /v1/voice/transcribe?projectId=`**: owner session; the project must be the owner's and not archived; `micEnabled` must be on (403 naming Settings → Voice & consent); `transcribe` configured (409 with runbook). Body: raw bytes, `Content-Type` one of `VOICE_AUDIO_TYPES` (codec params allowed), ≤ `VOICE_MAX_AUDIO_BYTES` (413), `x-audio-duration-ms` ≤ `VOICE_MAX_SECONDS` × 1000 (413) — register a raw body parser for these types scoped to this route. Sends multipart (`file` with an ASCII filename and the right extension, `model` = deployment, `language` unless "auto" (two-letter part), `response_format=json`) with header `api-key`, 30 s timeout, no redirects. Map provider errors to owner-safe messages (401/403 → key/permission, 404 → deployment not found, 429 → rate limited, 5xx/timeout → unavailable; status 502/503 with codes from `ErrorCode`). Never log audio or text. Usage counter += duration. Rate limit (e.g. 20/min per owner). Audit `voice.transcribe` (project, duration, bytes, outcome).
- **`POST /v1/voice/speak`** (`SpeakRequest`): `speakReplies` on (403), `speech` configured (409 with runbook). SSML built by the server with the text XML-escaped, `xml:lang` from the language (en-US when auto), `prosody rate` from `speechRate`. Answer `audio/mpeg` bytes. Same error mapping, timeout and rate limit; usage += characters. Audit `voice.speak` (project, characters, outcome).
- **Runbook `docs/runbooks/voice.md`:** deploy a transcribe model in Foundry, find the resource name, key and region, write `voice.json` (mode 600), what is sent where, cost notes (billed per audio minute / per character on Azure; set a budget alert), and how to turn it off.

Tests: config file checks (missing, bad mode, unknown field, both resource and baseUrl); status disclosure per configured half; settings validation + audit; transcribe happy path against a local fake provider (assert multipart fields, `api-key` header, filename, language), every error mapping, 403 mic off, 409 not configured, 413 size and duration, wrong content type 415, decoy project/other owner, usage counter and its local-day reset; speak SSML escaping (`<`, `&`, quotes), rate, 403/409, usage; nothing of the text in logs or audit.

## C: the Cofounder home (web)

Owns: `apps/web/src/board/home.tsx` (replace the stub; keep `export function HomeView()`), new `home.test.tsx`, and any small new files under `apps/web/src/board/home/` if it helps.

Build `docs/design/NEXUS-Cofounder.dc.html` with the NEXUS v2 tokens and typography (PRD §D.1/§D.4; never its literal palette; never import `support.js`). Layout: a scrollable page between the header and the bottom bar; main column + the docked Cofounder panel on the right (wide screens), panel below the main column on narrow screens.
- **Brief headline:** the date line ("TUESDAY 4 NOVEMBER · 14:32 · YOUR COFOUNDER'S READ"), the headline segments with the emphasised phrase highlighted, "prepared HH:MM · N sources · N decisions waiting on you".
- **KPIs:** Dev projects (and All): the four `HomeKpi` cards — value with unit formatting ("38 min", "92%", "14"), a delta chip worded AND coloured by `better` ("12 min faster than last week"), an inline SVG sparkline from `series` (gaps for null), the source line. Null → "—" with "no data yet". Business projects: KPI cards from the existing business metric calls (`api` sales/payments/revenue for the project's connector, as `business.tsx` does), "partial day" where the API says so; no connector → an honest empty card linking to the Business drawer.
- **Waiting on you:** `decisions.top` rows opening their drawers (`run:`, `plan:`, `opp:`, `jobdraft:`), with expiry.
- **Your cofounder noticed:** reuse the existing opportunity cards (`opportunities.tsx` exports; import, don't copy).
- **Agent activity:** one row per agent: label (`AGENT_LABEL`), state as text + dot (WORKING / waiting on you / idle), `doing` (opens `ref`), cost today "est.". A row opens `agent:<KEY>`.
- **Execution:** each job a segmented 6-stage bar (qualify → publish) with the current stage named in text, "needs you" tag, opens `run:<id>`. Empty: "Nothing running."
- **Results · this week:** the five results with value, label and source; AI spend as "$x.xx est.".
- **Cofounder panel:** mount `<CofounderPanel projectId={…} />` from `./cofounder.tsx` (builder D owns it).
- Motion (the board already uses `motion/react` with `LazyMotion` strict — use `m.*`): staggered entrance of the sections, KPI numbers easing in, sparkline path drawing; all off with reduced motion. Data refreshes every 30 s (TanStack Query `refetchInterval`), stale/offline states like the rest of the app.

Tests: every section from a fixture `HomeSummary` (incl. null KPI → "—", delta wording both directions), Business variant with and without a connector, All view read-only, rows open the right drawer, loading/error/offline, the default `/` (with `renderApp(path, { view: "home" })`) shows Home and the switch goes to Board, a11y (landmarks, headings, list semantics, status text).

## D: Cofounder panel, push-to-talk, spoken replies (web)

Owns: `apps/web/src/board/cofounder.tsx` (replace the stub; keep `export function CofounderPanel({ projectId })`), new `cofounder.test.tsx`, a new `apps/web/src/board/voice.tsx` (hooks + components) and `voice.test.tsx`, `Talk.tsx` (export what you need from it, add the mic and spoken replies there), `CommandBar.tsx` (replace the P1 voice button with the real mic), `Settings.tsx` (the "Voice & consent" tab), and the existing tests of those files.

- **Voice hooks (`voice.tsx`):** `useVoiceStatus()` (`keys.voice`); `usePushToTalk(projectId)`: `getUserMedia({audio:true})` only on an explicit press; `MediaRecorder` with the first supported of `audio/webm;codecs=opus`, `audio/mp4`, `audio/ogg`; live input level for the bars (AnalyserNode); stop on release / second tap / `VOICE_MAX_SECONDS`; **always stop every track** on stop, unmount and End (CWV-G07); then `api.transcribe` → the transcript. States: idle / requesting permission / listening / transcribing / error. Permission denied → text input stays, with how to allow the mic (CWV-G06). `useSpeak()`: `api.speak` → `Audio` with `playbackRate`; on 409 (not configured) fall back to `speechSynthesis` with the configured rate, labelled "browser voice"; stop/replay; never autoplay unless `speakReplies` is on.
- **Mic button** (command bar and Cofounder panel): level bars while listening, `aria-pressed`, an accessible label per state, keyboard (Space/Enter). When the mic is off in settings or voice isn't configured, the button says why and links to Settings → Voice & consent. The transcript fills the input for review; nothing is sent by itself.
- **Voice HUD:** while listening/transcribing/speaking, a small panel with the state in text, the live caption (transcript or the reply being spoken), "mic on this Mac" / provider disclosure, and **End** (releases the mic, stops audio).
- **Cofounder panel:** the project's latest Talk thread (or a new one on first send), its turns with the existing source chips and proposal cards (reuse from `Talk.tsx`), suggestion chips (e.g. "What's waiting on me?", "Summarize today's runs", "What failed?") that fill the input, text input + mic + Send, the scope footer "answers from <project> sources only · runs execute on your home machine · pushes and merges need on-screen approval". **Conversation mode** ("Talk with your cofounder"): after a spoken send, the reply is spoken (if `speakReplies`), then the mic is offered again; End leaves the mode. All view → "Pick a project to talk with your cofounder." No `ai.json` → the Talk 409 message shown honestly.
- **Talk drawer:** the same mic and a replay button on assistant turns.
- **Settings → Voice & consent:** provider status, the disclosure sentences, mic on/off, speak replies on/off, speech rate, language; usage today; the runbook path when not configured, `problem` when invalid.
- Motion: an orb / level animation while listening (off with reduced motion).

Tests (mock `getUserMedia`, `MediaRecorder`, `AudioContext`, `Audio`, `speechSynthesis` in the test): press → permission → listening → stop → transcribe call with the blob type and duration header → transcript in the input, not sent; tracks stopped on stop, End and unmount; permission denied path; mic off / not configured path; speak with server audio and browser fallback; replay; conversation mode turn; panel scope footer and All view; settings toggles send `PUT` and show disclosure; command bar mic; a11y labels and live regions.

## Coordinator at merge

1. Merge A → B → C → D; resolve `app.ts`; remove the stubs' `shortcut:` comments.
2. Squash B's migration into one `0009_cofounder.sql`.
3. All checks (typecheck, lint, prettier, all tests, web build) and a secret scan.
4. Update `docs/p1-tracker.md`, `docs/handoff.md`, then push (the owner asked for it) and watch CI.

## Not in this wave (named)

Phone calls (PSTN, P3) · realtime voice / barge-in (FR-CWV-08, P2) · wake word · a model-written brief · Business "noticed" beyond the existing opportunity cards · browser SpeechRecognition (Chrome sends the audio to Google; not used).

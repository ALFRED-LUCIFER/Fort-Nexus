# Runbook: voice (push-to-talk and spoken replies)

NEXUS can turn what you say into text and read the Cofounder's replies aloud. The API is the voice gateway. The browser records a clip only while you hold or tap the mic. NEXUS sends the clip to your own Microsoft Foundry resource and returns the text, and you read it before you send it. A transcript is never a command: anything that changes something still needs its on-screen preview and approval.

Two halves, each optional:
- **Speech to text:** an Azure OpenAI transcribe deployment, such as `gpt-4o-mini-transcribe`, on your Foundry resource.
- **Spoken replies:** Azure AI Speech neural voices. The default voice is `en-US-AvaMultilingualNeural`.

Without `~/.nexus/voice.json`, the API sends no audio or text to anyone. The mic explains how to set it up, and replies can still be read by your browser's own voice. The app labels that "browser voice".

**Personal accounts only.** Use your own Azure subscription and payment method, never an employer's (PRD §20 lesson 12).

## 1. Set up Foundry

One Foundry (AIServices) resource and key serve Claude, the transcribe deployment and Speech. Only the hosts differ. If you already use Foundry for Claude (`docs/runbooks/ai-provider.md`), use that resource.

1. In the Foundry portal (`https://ai.azure.com`), open your resource's project. Go to **Models + endpoints**, then **Deploy model**, and pick `gpt-4o-mini-transcribe` (or `gpt-4o-transcribe` / `whisper`).
   - Note the **deployment name** you give it. NEXUS calls `https://<resource>.openai.azure.com/openai/deployments/<deployment>/audio/transcriptions`.
2. In the Azure portal, open the resource. Go to **Resource Management**, then **Keys and Endpoint**, and note:
   - the **resource name**: the `<resource>` in `https://<resource>.openai.azure.com`;
   - **KEY 1**;
   - the **Location/Region**, for example `eastus2`. Speech is called at `https://<region>.tts.speech.microsoft.com`.
3. If you use a separate Speech resource, note its key and region too.

## 2. Write `~/.nexus/voice.json`

```json
{
  "provider": "foundry",
  "resource": "my-foundry-resource",
  "apiKey": "…",
  "transcribe": { "deployment": "gpt-4o-mini-transcribe" },
  "speech": { "region": "eastus2", "voice": "en-US-AvaMultilingualNeural" }
}
```

- `resource` or `baseUrl`, not both. Set `baseUrl` only for a custom domain: an `https://` origin on the default port, with no path.
- `transcribe` and `speech` are each optional, but at least one is required. Leave one out to turn that half off.
- `speech.voice` defaults to `en-US-AvaMultilingualNeural`. `speech.apiKey` defaults to `apiKey`, so set it only for a separate Speech resource.
- Unknown fields are refused.

Lock the file down. The API refuses it otherwise:

```sh
mkdir -p ~/.nexus && chmod 700 ~/.nexus
$EDITOR ~/.nexus/voice.json
chmod 600 ~/.nexus/voice.json
```

- The file must be a regular file with mode `0600`, owned by the user the API runs as.
- `NEXUS_VOICE_FILE` points the API at another path.
- The file is read on every request, so creating it or rotating a key needs no restart.

Check it in **Settings → Voice & consent**, or at `GET /v1/voice/status`. Both show which halves are configured, the disclosure sentences, today's usage and, if the file is wrong, the problem. Neither ever shows a key.

Then turn on **Microphone** (and **Speak replies**, if you want them) in Settings → Voice & consent. Both are off until you turn them on.

Failures answer 409 with `details.reason`:
- `voice_not_configured`: the file is missing.
- `voice_config_invalid`: bad JSON, unknown fields, the wrong mode or owner, or a directory. The message names the field and check, never the file's content.
- `voice_transcribe_not_configured` / `voice_speech_not_configured`: that half isn't in the file.

## 3. What is sent where, and what is kept

- **Push-to-talk:** `POST /v1/voice/transcribe?projectId=…`, body = the raw clip.
  - Accepted types: `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav` or `audio/mpeg`.
  - Limits: 10 MB and 120 s (`413` over either limit, `415` for any other type).
  - The microphone must be on in settings (`403`).
  - NEXUS sends multipart (`file`, `model`, `language` unless set to auto, `response_format=json`) to your transcribe deployment, with the key in the `api-key` header only.
  - Microsoft doesn't use the audio to train models. Prompts and audio may be kept for abuse monitoring in your resource's region.
- **Spoken replies:** `POST /v1/voice/speak` with `{ projectId, text }`, up to 2,000 characters.
  - **Speak replies** must be on (`403`).
  - NEXUS builds the SSML itself, with the text XML-escaped and the voice, language and rate from your settings. It sends the SSML to Azure AI Speech with the key in `Ocp-Apim-Subscription-Key`, and returns MP3.
  - Azure AI Speech doesn't store the text it speaks.
- **Every call:** a 30 s timeout, no redirects, and 20 calls per minute per owner for each endpoint.
- **NEXUS keeps:**
  - your settings;
  - per-day counters (seconds transcribed, characters spoken; the day in `OWNER_TIMEZONE`);
  - an audit record per call with ids, duration, bytes or characters, and the outcome.
- **NEXUS never stores or logs** audio, transcripts or spoken text.
- **Provider errors** reach you as owner-safe text, never the provider's own message:
  - `401/403` → `502 voice_provider_auth`: check the key.
  - `404` → `502 voice_provider_not_found`: check the deployment name or region.
  - other `4xx` → `502 voice_provider_rejected`.
  - `429` → `503 RATE_LIMITED voice_provider_rate_limited`.
  - `5xx`, a timeout or a network error → `503 voice_provider_unavailable`.

## 4. Cost

Azure bills both halves to your subscription, apart from Claude's tokens:
- Speech to text is billed **per audio minute**.
- Spoken replies are billed **per character**.

Check current prices on the Azure OpenAI and Azure AI Speech pricing pages for your region.

The usage counters in Settings → Voice & consent are NEXUS's own count, not Azure's invoice. Set a **budget alert** on the subscription or resource group in Azure Cost Management, so a surprise shows up in days, not at month end.

## 5. Turn it off

- **One owner switch:** turn **Microphone** or **Speak replies** off in Settings → Voice & consent. That takes effect immediately.
- **One half:** remove `transcribe` or `speech` from `voice.json`.
- **Everything:** delete `~/.nexus/voice.json`. No audio or text leaves the home machine after that. Replies fall back to the browser voice, which you can mute in the app.
- **Revoke access:** regenerate the key in the Azure portal (**Keys and Endpoint**), and delete the transcribe deployment if you no longer want it.

## 6. Spoken updates

While the app is open, a new notification shows at the top of the docked Cofounder panel as "NEXUS · noticed just now" (on narrower screens, as a toast). **Tell me** reads it, **Open** opens what it is about, **Later** puts it off; it stays in the Inbox either way. Several arriving together collapse into one.

- **Read new updates aloud** (Settings → Voice & consent) is kept per device: Off (default), Only things that need me (approvals, failures and recovery, incidents, security events) or Everything.
- The voice is your Azure AI Speech voice when `speech` is set up and **Speak replies** is on, and this browser's own voice otherwise. The app says which one is speaking.
- Only the notification's own title is said, plus the first sentence of its body when that is NEXUS's plain text. Notifications are written from recorded facts and redacted on the server; quoted source text and business details are never read out.
- Updates wait while a mic is recording or a reply is being read. Ones that waited more than two minutes are not read.
- Browsers block audio until you tap the page. NEXUS then shows **Tap to hear updates** once.
- In **Talk with your cofounder** mode, an update is added to the conversation as an observed line and, when Speak replies is on, said aloud. A recording in progress pauses while it is said (nothing is recorded meanwhile) and then goes on listening.

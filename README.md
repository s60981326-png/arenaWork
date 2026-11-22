# ZENITH

A real, persistent, voice-first personal AI companion — built to feel like a
close, intelligent friend who remembers you, talks to you out loud, and is
genuinely useful while doing it.

Not a search engine, not a generic chatbot, not a wellness bot. ZENITH has
a distinct personality, a memory, a voice, and a persistent profile of you.

---

## What you can do today

- **Talk hands-free** — tap the orb, speak, hear ZENITH reply out loud.
  ElevenLabs streaming voice with an honest fallback to the local Kokoro voice
  (or the browser's system voice) — ZENITH always answers, and never fakes it.
- **See your whole brain** — the brain (provider + model) is honest and
  configured, never hardcoded. Reasoning effort (low/medium/high) is adjustable.
- **Be remembered** — ZENITH keeps a SQLite memory of what you asked it to
  remember (your preferences, stated facts, …) plus rolling conversation
  summaries. Everything is visible, editable, deletable from the Memory panel.
- **Have a profile** — a local `data/profile.md` (identity, goals, preferences)
  that ZENITH reads and only sends the relevant sections to the brain per turn.
  It never leaves your machine as a whole.
- **Set reminders and daily check-ins** — once / daily / weekdays reminders,
  morning and evening check-ins. They fire while ZENITH is running and are
  honest about what happened.
- **Watch it work** — the stage shows IDLE / LISTENING / THINKING / SPEAKING /
  ERROR states, a live transcript, and real connection status. No fake
  success messages.

## Architecture

```
  frontend/                  browser UI (plain HTML/CSS/JS, no framework)
    index.html               the stage: portrait, mic orb, status, panels
    app.js                   state machine, voice pipeline, memory/profile/
                             schedule panels, ElevenLabs + Kokoro orchestration
    style.css                the anime-inspired cinematic skin
    images/zenith-portrait.png
    vendor/kokoro/           vendored browser TTS runtime (local fallback)
  backend/                   Node 22+ backend (the only place secrets live)
    server.js                Express app + routes + SSE + reminders tick
    config.js                all env-var configuration + validation
    logger.js                timestamped structured logging
    brain.js                 the ONLY place that talks to the LLM
    conversation.js          history + rolling summary + bounded context
    memory.js                SQLite long-term memory + markdown export
    profile.js               profile load/save + relevant-section selection
    reminders.js             SQLite reminders + check-ins scheduler
    tts.js                   ElevenLabs streaming proxy (per-turn + monthly caps)
    stt.js                   speech-to-text proxy (OpenAI-compatible)
  config/
    personality.md           ZENITH's identity — the single source of truth
  data/                      created at first run — NEVER committed
    zenith.db                memory + conversation + reminders (SQLite)
    settings.json            voice/checkin/budget settings
    profile.md               your editable profile
    memory.md                human-readable memory export (auto-regenerated)
  tests/                     unit + API integration tests (no network needed)
```

## Requirements

- **Node.js ≥ 22.5** (for the built-in `node:sqlite` module)
- A modern browser with `MediaRecorder` (for voice). Chromium/Edge/Chrome
  recommended — Safari/Firefox handle typing but may lack the SpeechRecognition
  API (then server-side STT is used instead of the browser speech engine).

## Quick start (Windows)

1. Double-click **setup.bat** — installs dependencies and creates your `.env`
   from the template if you don't have one.
2. Open `.env` and fill in your values (see [Configuration](#configuration)).
3. Double-click **start.bat** — ZENITH starts locally. Open
   http://localhost:4567. The stage, mic orb and chat panel are all local.

Windows users on a non-Windows machine: the same commands work on Linux/macOS
with `bash setup.sh` / `bash start.sh` (or `npm start` directly).

## Quick start (CLI / any OS)

```bash
npm install
cp .env.example .env     # then edit .env — see below
npm start                # http://localhost:4567
```

Run the tests (no network, no keys, no real providers — everything is faked):

```bash
npm test
```

## Configuration

All configuration is via environment variables in `.env` (never committed).
The complete, commented reference is in [.env.example](.env.example).

### AI brain (required)

Any OpenAI-compatible chat-completions provider works — OpenAI, Groq,
Together, DeepInfra, OpenRouter, Mistral, LM Studio, Ollama, and most
self-hosted endpoints. Just point `ZENITH_LLM_BASE_URL` at it and pick a model.

| Variable | Default | Notes |
| --- | --- | --- |
| `ZENITH_LLM_PROVIDER` | `openai` | display label for the brain |
| `ZENITH_LLM_BASE_URL` | `https://api.openai.com/v1` | provider base URL |
| `ZENITH_LLM_API_KEY` | *(required)* | your provider key |
| `ZENITH_LLM_MODEL` | `gpt-4o-mini` | model id |
| `ZENITH_LLM_TEMPERATURE` | `0.75` | 0–2 |
| `ZENITH_LLM_MAX_TOKENS` | `1024` | 64–16384 |
| `ZENITH_LLM_TIMEOUT_MS` | `120000` | per-request timeout |
| `ZENITH_LLM_RETRIES` | `1` | retries on 5xx/429/timeout |

### Voice — ElevenLabs (optional but recommended)

Without this, ZENITH speaks with the local browser voice (Kokoro) — fully
working, slower, no subscription. The backend never exposes your key to the
browser.

| Variable | Notes |
| --- | --- |
| `ELEVENLABS_API_KEY` | your key |
| `ELEVENLABS_VOICE_ID` | pick one in Settings or via the ElevenLabs console |
| `ELEVENLABS_MONTHLY_CHARS_CAP` | hard monthly budget guardrail (default 18000) |
| `ELEVENLABS_TURN_CHARS_CAP` | per-reply cap (default 420) |

### Speech-to-text (recommended; falls back to the browser's speech engine)

| Variable | Notes |
| --- | --- |
| `ZENITH_STT_BASE_URL` | OpenAI-compatible (defaults to OpenAI Whisper) |
| `ZENITH_STT_API_KEY` | defaults to `ZENITH_LLM_API_KEY` / `OPENAI_API_KEY` |
| `ZENITH_STT_MODEL` | default `whisper-1` |
| `ZENITH_STT_LANGUAGE` | empty = auto-detect |

Without an STT provider the browser Web Speech API is used instead.

### Backend

`ZENITH_PORT` (default 4567), `ZENITH_HOST` (default 127.0.0.1),
`ZENITH_LOG_LEVEL` (`info`), `ZENITH_DATA_DIR` (default `./data`).

## How the voice pipeline works

1. **Mic → STT** — in voice mode the browser records the user's utterance
   with `MediaRecorder` and sends the clip to the backend `/api/stt`, which
   forwards it to the configured provider. (If the provider is unavailable,
   the browser Web Speech API is used instead.)
2. **STT → Brain** — `GET /api/chat` (SSE) streams the reply. The backend
   assembles the system prompt from `config/personality.md` + the relevant
   memory facts + relevant profile sections + the conversation summary,
   bounded to a character budget — not the entire history.
3. **Brain → TTS** — the reply is split sentence-by-sentence and streamed to
   ElevenLabs (or Kokoro locally) in real time. The spoken characters are
   budgeted per reply (hard cap) and per month (guardrail).
4. **Playback** — audio schedules in the browser. If ElevenLabs fails, the
   local Kokoro voice takes over mid-sentence; if the local voice fails, the
   system speech synthesis runs. Every failure is reported honestly, never
   faked as success.
5. **Interruption** — the mic meter watches for the user talking over ZENITH;
   if the voice rises clearly above the speaker-leak floor for ~450 ms, ZENITH
   stops immediately and starts listening to the user's new words.

## Memory, profile, and reminders — how they actually work

- **Memory** is a SQLite table, user-visible and user-editable through the
  Memory panel. Entries are retrieved by keyword relevance (a cap of ~2600
  characters per turn), never dumped in full. `data/memory.md` is an
  auto-regenerated, human-readable export.
- **Profile** is a single `data/profile.md` you edit in the Profile panel.
  ZENITH only sends the sections relevant to the current message — small talk
  sends nothing. In-app edits require an explicit Save; nothing autosaves.
- **Conversation memory** is rolling: each turn persists to SQLite, and older
  turns are compressed into a running summary so the model never sees
  unbounded history.
- **Reminders and check-ins** fire while ZENITH is running (15 s tick,
  per-fire prompt through the same brain path), persisted in SQLite, never
  faked. Once-reminders delete themselves after firing; daily/weekday ones
  advance to their next occurrence. Check-ins are tracked per day (morning /
  evening) and never double-fire.

## Reliability contract

- Provider unreachable / rejected → clear error shown in the chat panel; the
  brain reports failure honestly instead of inventing an answer.
- Voice provider down → automatic fallback to Kokoro / system voice.
- STT down → browser Web Speech API fallback.
- Mic permission denied → the UI says exactly that; nothing fakes permission.
- Timeouts everywhere (LLM, STT, ElevenLabs, per-request and per-socket).
- Retries on 5xx / 429 / timeouts.
- SQLite handles never leak across requests; graceful shutdown closes them.
- Port binding, SSE, and WebSocket errors are logged, never silent.

## Troubleshooting

**"AI brain: no API key" on startup.**
Edit `.env` and set `ZENITH_LLM_API_KEY` (or `OPENAI_API_KEY`) — restart.

**"Voice: local fallback" / Kokoro shows in the status bar.**
That's expected without ElevenLabs — ZENITH will still speak with the local
voice. Add `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` to use ElevenLabs.

**Mic permission denied / "microphone blocked".**
Allow microphone for http://localhost:4567 in the browser's site settings.
The mic never leaves this machine — no audio is uploaded unless you have an
STT provider configured (and then only that utterance).

**ElevenLabs errors ("input_timeout_exceeded").**
The backend sends each text frame once with an 8s upstream watchdog plus one
automatic retry. If frames keep timing out, the reply falls back honestly
to the local voice.

**"chat unavailable" button disabled.**
The brain is configured but rejected the request — check the log line
`LLM ... answered ...` in the server console. Then fix the key/model in .env.

**Port already in use.**
Change `ZENITH_PORT` in `.env` (and restart).

## Security notes

- The `.env` file is git-ignored; the frontend never receives your keys — it
  talks to `/api/*` on the local backend only.
- Audio/text are sent to your configured providers (LLM / STT / ElevenLabs)
  only when you send a message or record a voice note.
- The `data/` directory is gitignored; user memory, settings, and profile
  stay on your machine.
- Reminders only fire while the app is running (and while ZENITH is not
  busy). They are never "sent" outside this machine — there is no remote
  reminder service.

## Known honest limitations

- Browser Web Speech API (`SpeechRecognition`) is Chromium-only; other
  browsers fall back to server-side STT or typed input.
- Kokoro's local voice is CPU/WASM-bound — expect ~1–2.7× realtime synthesis
  (slower sentences) and browser support via WebGPU/WASM.
- Reminders fire only while the app is running. There is no OS-level scheduler.
- No embedding search; memory retrieval is keyword-based with recency.

## License

See the repo. ZENITH is not shipped under any rights-granting license;
your own usage of its code is yours to decide.

// ZENITH — backend server.
//
// One process: serves the frontend, the AI brain, the voice pipeline, the
// memory store and the scheduler. Everything sensitive (API keys) stays here;
// the browser only sees status signals, SSE text and PCM audio.

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, validateConfig, sttReady, voiceReady, llmReady } from "./config.js";
import { log } from "./logger.js";
import { MemoryStore, openMemoryStore } from "./memory.js";
import { ConversationStore, openConversationStore } from "./conversation.js";
import { ReminderScheduler, openReminderScheduler, CHECKIN_IDS } from "./reminders.js";
import { ProfileStore } from "./profile.js";
import { Brain, extractMemorySuggestion, buildSystemPrompt, brainReady } from "./brain.js";
import { attachVoiceHandler, getElevenLabsKey, resolveVoiceId, usageView, DEFAULT_MONTHLY_CAP, DEFAULT_TURN_CAP } from "./tts.js";
import { transcribeAudio, sttStatus } from "./stt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const DATA = config.dataDir;

// ---------------------------------------------------------------------------
// Settings — small, user-owned, survives restarts
// ---------------------------------------------------------------------------

const settingsPath = path.join(DATA, "settings.json");

async function loadSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

let memoryStore;
let conversationStore;
let scheduler;
let profileStore;
let brain;

let chatBusy = false;
let lastError = null; // last recorded brain/service error (surfaced in /api/status)
let currentEffort = "medium"; // exposed to the brain as reasoning_effort hint

// ---------------------------------------------------------------------------
// Conversation turn — the single pipeline used by both the SSE endpoint and
// reminder firing (shared, so a reminder feels identical to a typed turn).
// ---------------------------------------------------------------------------

function systemModeForPrompt(voiceMode) {
  return voiceMode ? "voice" : "text";
}

async function assembleMessages(text, voiceMode) {
  const personality = await brain.loadPersonality();
  const memoryItems = memoryStore.relevant(text, { cap: 1800, maxItems: 6 });
  const memorySection = memoryItems.length
    ? memoryItems.map((i) => `- [${i.type}] ${i.text}`).join("\n")
    : "";
  let profileSection = "";
  try {
    profileSection = await profileStore.contextForMessage(text);
  } catch {
    profileSection = "";
  }
  const { summary } = conversationStore.getSummary();
  const sys = buildSystemPrompt({
    personality,
    memorySection,
    profileSection,
    summary,
    mode: systemModeForPrompt(voiceMode),
  });

  const { messages: recent, droppedCount } = conversationStore.boundedHistory(6000);
  // The current user message is NOT in the store yet: append it at the end.
  const messages = [
    { role: "system", content: sys },
    ...recent
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })),
    { role: "user", content: text },
  ];
  return { messages, droppedCount };
}

/** Fire-and-forget rolling summary, only for the messages that fall outside the context window. */
function summarizeDropped() {
  (async () => {
    try {
      const { summary, throughMessageId } = conversationStore.getSummary();
      const msgs = conversationStore.listMessages({ limit: 500 });
      const fitIds = new Set(conversationStore.boundedHistory(6000).messages.map((m) => m.id));
      let older = msgs.filter((m) => !fitIds.has(m.id));
      if (throughMessageId) {
        const throughIdx = msgs.findIndex((m) => m.id === throughMessageId);
        if (throughIdx >= 0) older = older.filter((m) => msgs.findIndex((x) => x.id === m.id) > throughIdx);
      }
      if (!older.length) return;
      const next = await brain.summarize({
        previousSummary: summary,
        messages: older,
        conversationId: conversationStore.ensureConversation(),
      });
      conversationStore.setSummary(next, older[older.length - 1].id);
    } catch (err) {
      log.warn("Summarization skipped:", err?.message || err);
    }
  })();
}

/**
 * Run one assistant turn. Persists messages and returns the final text.
 * Throws on hard failure — callers surface the real reason.
 */
async function runTurn({ text, voiceMode = false, onDelta = null, persist = true }) {
  const { messages, droppedCount } = await assembleMessages(text, voiceMode);
  if (persist) conversationStore.addMessage("user", text);

  let full = "";
  try {
    for await (const delta of brain.stream({ messages })) {
      full += delta;
      if (onDelta) onDelta(delta);
    }
  } catch (err) {
    lastError = err?.message || String(err);
    throw err;
  }

  const finalText = full.trim();
  if (persist && finalText) {
    conversationStore.addMessage("assistant", finalText);
  }
  // Summarize older context in the background — the reply is already out.
  if (droppedCount > 0) summarizeDropped();

  const processed = extractMemorySuggestion(finalText);
  return { text: processed.text, suggestion: processed.suggestion };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function originAllowed(origin) {
  return !origin || LOCAL_ORIGIN_RE.test(origin);
}
app.use((req, res, next) => {
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: "forbidden origin" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use("/lib/kokoro", express.static(path.join(config.frontendDir, "vendor", "kokoro"), { fallthrough: false }));
app.use("/images", express.static(path.join(config.frontendDir, "images"), { fallthrough: false }));
app.use(express.static(config.frontendDir));

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/status", async (req, res) => {
  const settings = await loadSettings();
  const key = await getElevenLabsKey(config);
  const ready = llmReady(config);
  res.json({
    ok: ready,
    error: lastError,
    brain: {
      provider: config.llm.provider,
      model: config.llm.model,
      effort: currentEffort,
      ready,
      missingKey: !ready,
    },
    // legacy shape kept for older panels
    model: { providerID: config.llm.provider, id: config.llm.model },
    agent: null,
    voice: {
      engine: voiceReady(config) && !settings.elQuotaExhausted ? "elevenlabs" : "kokoro",
      configured: !!(key && resolveVoiceId(config, settings)),
      voiceId: resolveVoiceId(config, settings),
      voiceName: settings.voiceName || null,
      quotaExhaustedAt: settings.elQuotaExhausted || null,
    },
    stt: sttStatus(config),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", async (req, res) => {
  const problems = validateConfig(config).filter((p) => !/^Voice:|^Speech recognition:/.test(p));
  res.json({
    ok: llmReady(config),
    brain: { ready: llmReady(config), provider: config.llm.provider, model: config.llm.model },
    voice: { configured: voiceReady(config) },
    stt: { configured: sttReady(config) },
    problems,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/history", async (req, res) => {
  try {
    const history = conversationStore.listMessages({ limit: 300 });
    const out = history.map((m) => ({ id: m.id, role: m.role === "assistant" ? "assistant" : "user", text: m.text }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!llmReady(config)) {
    return res.status(503).json({
      error: "The AI brain is not configured. Add ZENITH_LLM_API_KEY (and optionally ZENITH_LLM_BASE_URL / ZENITH_LLM_MODEL) in .env, then restart.",
    });
  }
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message." });
  if (chatBusy) return res.status(409).json({ error: "ZENITH is already answering. Wait for the current reply to finish." });

  chatBusy = true;
  sse(res);
  sseSend(res, "start", {});

  let finished = false;
  let buffer = "";

  res.on("close", () => {
    if (!finished) {
      finished = true;
      chatBusy = false;
      res.end();
    }
  });

  // Safety net: never leave the browser hanging.
  const watchdog = setTimeout(() => {
    if (!finished) {
      finished = true;
      chatBusy = false;
      try {
        sseSend(res, "error", { error: "The reply took too long." });
      } catch {}
      res.end();
    }
  }, 180_000);
  watchdog.unref?.();

  try {
    const voiceMode = req.body?.voice === true || req.body?.voice === "true";
    const { text: final, suggestion } = await runTurn({
      text,
      voiceMode,
      onDelta: (delta) => {
        buffer += delta;
        if (!finished) {
          try {
            sseSend(res, "delta", { delta });
          } catch {
            // client gone
          }
        }
      },
    });
    if (!finished) {
      finished = true;
      chatBusy = false;
      try {
        sseSend(res, "done", { text: final, suggestion });
      } catch {}
      res.end();
    }
  } catch (err) {
    if (!finished) {
      finished = true;
      chatBusy = false;
      try {
        sseSend(res, "error", { error: err.message || String(err) });
      } catch {}
      try {
        sseSend(res, "done", { text: buffer, suggestion: null });
      } catch {}
      res.end();
    }
  } finally {
    clearTimeout(watchdog);
  }
});

// ---------------------------------------------------------------------------
// Memory endpoints
// ---------------------------------------------------------------------------

app.get("/api/memory", async (req, res) => {
  res.json(memoryStore.list());
});

app.post("/api/memory", async (req, res) => {
  try {
    const item = memoryStore.add({
      text: req.body?.text,
      type: req.body?.type,
      confidence: req.body?.confidence,
    });
    await memoryStore.exportMarkdown(path.join(DATA, "memory.md"));
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.patch("/api/memory/:id", async (req, res) => {
  try {
    const item = memoryStore.update(req.params.id, { text: req.body?.text, type: req.body?.type });
    if (!item) return res.status(404).json({ error: "Not found." });
    await memoryStore.exportMarkdown(path.join(DATA, "memory.md"));
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.delete("/api/memory/:id", async (req, res) => {
  const deleted = memoryStore.remove(req.params.id);
  await memoryStore.exportMarkdown(path.join(DATA, "memory.md"));
  res.json({ deleted });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

app.get("/api/profile", async (req, res) => {
  const text = await profileStore.load();
  if (!text.trim()) {
    return res.json({
      text: "",
      missing: true,
      hint: "No profile yet. Add one at data/profile.md — it can be edited at any time from the Profile panel.",
    });
  }
  res.json({ text, missing: false });
});

app.put("/api/profile", async (req, res) => {
  try {
    const result = await profileStore.save(req.body?.text);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Reasoning effort + settings
// ---------------------------------------------------------------------------

app.get("/api/effort", async (req, res) => {
  res.json({ variant: currentEffort, provider: config.llm.provider, model: config.llm.model });
});

app.patch("/api/effort", async (req, res) => {
  const v = ["low", "medium", "high"].includes(req.body?.variant) ? req.body.variant : "medium";
  currentEffort = v;
  await saveSettings({ variant: v });
  res.json({ variant: v, provider: config.llm.provider, model: config.llm.model });
});

app.get("/api/settings", async (req, res) => {
  res.json(await loadSettings());
});

app.patch("/api/settings", async (req, res) => {
  const patch = {};
  if (typeof req.body?.voiceId === "string") patch.voiceId = req.body.voiceId.trim() || null;
  if (typeof req.body?.voiceName === "string") patch.voiceName = req.body.voiceName.trim() || null;
  if (typeof req.body?.checkinEnabled === "boolean") patch.checkinEnabled = req.body.checkinEnabled;
  if (typeof req.body?.checkinMorning === "string") patch.checkinMorning = req.body.checkinMorning.trim();
  if (typeof req.body?.checkinEvening === "string") patch.checkinEvening = req.body.checkinEvening.trim();
  if (typeof req.body?.speakTyped === "boolean") patch.speakTyped = req.body.speakTyped;
  if (Number.isFinite(req.body?.elMonthlyCap)) patch.elMonthlyCap = Math.max(0, Math.floor(req.body.elMonthlyCap));
  if (Number.isFinite(req.body?.elTurnCap)) patch.elTurnCap = Math.max(0, Math.floor(req.body.elTurnCap));
  if (req.body?.voiceSettings && typeof req.body.voiceSettings === "object") {
    const v = req.body.voiceSettings;
    const num = (x, lo, hi) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : undefined);
    patch.voiceSettings = {
      stability: num(v.stability, 0, 1),
      similarity_boost: num(v.similarity_boost, 0, 1),
      style: num(v.style, 0, 1),
      speed: num(v.speed, 0.7, 1.2),
      use_speaker_boost: typeof v.use_speaker_boost === "boolean" ? v.use_speaker_boost : undefined,
    };
  }
  const next = await saveSettings(patch);
  res.json(next);
});

// ---------------------------------------------------------------------------
// ElevenLabs status / usage / voices
// ---------------------------------------------------------------------------

app.get("/api/elevenlabs/status", async (req, res) => {
  const settings = await loadSettings();
  const key = await getElevenLabsKey(config);
  res.json({
    configured: !!key,
    voiceId: resolveVoiceId(config, settings),
    voiceName: settings.voiceName || null,
    keyHint: key ? key.slice(0, 3) + "…" : null,
    speakTyped: settings.speakTyped === true,
    usage: usageView(settings, config),
  });
});

app.get("/api/elevenlabs/usage", async (req, res) => {
  const key = await getElevenLabsKey(config);
  if (!key) return res.status(409).json({ error: "ElevenLabs key not configured. Put your API key in .env or secrets/elevenlabs.key." });
  try {
    const r = await fetch(`${config.elevenlabs.baseUrl}/v1/user/subscription`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return res.status(r.status).json({ error: `ElevenLabs answered ${r.status}` });
    const d = await r.json();
    const settings = await loadSettings();
    res.json({
      used: d.character_count ?? null,
      limit: d.character_limit ?? null,
      resetsAt: d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000).toISOString() : null,
      tier: d.tier ?? null,
      local: usageView(settings, config),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.get("/api/elevenlabs/voices", async (req, res) => {
  const key = await getElevenLabsKey(config);
  if (!key) {
    return res.status(409).json({
      error: "ElevenLabs key not configured. Add ELEVENLABS_API_KEY in .env (or secrets/elevenlabs.key).",
    });
  }
  try {
    const r = await fetch(`${config.elevenlabs.baseUrl}/v1/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `ElevenLabs rejected the key (${r.status}). ${detail.slice(0, 200)}` });
    }
    const data = await r.json();
    const voices = (data.voices || []).map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      preview_url: v.preview_url,
      labels: v.labels,
    }));
    res.json({ voices });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.get("/api/voice/status", async (req, res) => {
  const settings = await loadSettings();
  const key = await getElevenLabsKey(config);
  const exhausted = !!settings.elQuotaExhausted;
  const configured = !!(key && resolveVoiceId(config, settings));
  res.json({
    engine: !configured || exhausted ? "kokoro" : "elevenlabs",
    configured,
    quotaExhaustedAt: settings.elQuotaExhausted || null,
    elevenLabsConfigured: configured,
    voiceName: settings.voiceName || null,
  });
});

app.post("/api/voice/retry", async (req, res) => {
  // Manual "Retry ElevenLabs" — clears the quota flag so the next turn uses
  // ElevenLabs again. If credits are still out, the quota error will re-flag it.
  const current = await loadSettings();
  await saveSettings({ elQuotaExhausted: null });
  res.json({ engine: "elevenlabs" });
});

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

app.get("/api/stt/status", async (req, res) => {
  res.json(sttStatus(config));
});

app.post("/api/stt", async (req, res) => {
  // Audio arrives as multipart/form-data (file) — express.json only parses JSON.
  // We read the raw body to keep the parser minimal.
  const contentType = req.headers["content-type"] || "";
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);

  const file = extractFile(raw, contentType);
  if (!file || !file.data.length) {
    return res.status(400).json({ error: "No audio file received (expected multipart/form-data with a file field)." });
  }
  try {
    const result = await transcribeAudio({
      config,
      audio: file.data,
      contentType: file.contentType,
      filename: file.filename,
      logger: log,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Reminders + check-ins
// ---------------------------------------------------------------------------

app.get("/api/schedule", async (req, res) => {
  const settings = await loadSettings();
  const reminders = scheduler.list().map((r) => ({
    id: r.id,
    name: r.name,
    when: { type: r.kind, time: r.time, date: r.date },
    whenText: r.whenText,
    status: r.status,
    nextDueAt: r.nextDueAt,
    lastFiredAt: r.lastFiredAt,
    lastOutcome: null,
  }));
  const { nextOccurrenceDate } = await import("./reminders.js");
  const enabled = settings.checkinEnabled === true;
  const morning = settings.checkinMorning || "08:00";
  const evening = settings.checkinEvening || "21:00";
  const checkinView = (enabledFlag, time) => ({
    status: enabledFlag ? "active" : "off",
    nextDueAt: enabledFlag ? nextOccurrenceDate(time).toISOString() : null,
  });
  res.json({
    reminders,
    checkins: {
      enabled,
      morning,
      evening,
      morningSchedule: checkinView(enabled, morning),
      eveningSchedule: checkinView(enabled, evening),
    },
    checkinWarnings: [],
  });
});

app.post("/api/schedule", async (req, res) => {
  const { name, kind, time, date } = req.body || {};
  try {
    const created = scheduler.add({ name, kind, time, date });
    res.json({ id: created.id });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.patch("/api/schedule/:id/pause", async (req, res) => {
  try {
    const r = scheduler.setStatus(req.params.id, "paused");
    if (!r) return res.status(404).json({ error: "Not found." });
    res.json({ status: "paused" });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.patch("/api/schedule/:id/resume", async (req, res) => {
  try {
    const r = scheduler.setStatus(req.params.id, "active");
    if (!r) return res.status(404).json({ error: "Not found." });
    res.json({ status: "active" });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.patch("/api/schedule/:id", async (req, res) => {
  try {
    const r = scheduler.update(req.params.id, {
      name: req.body?.name,
      kind: req.body?.kind,
      time: req.body?.time,
      date: req.body?.date,
    });
    if (!r) return res.status(404).json({ error: "Not found." });
    res.json({ id: r.id });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.delete("/api/schedule/:id", async (req, res) => {
  try {
    const deleted = scheduler.delete(req.params.id);
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Health + start
// ---------------------------------------------------------------------------

function assertHealth() {
  const problems = validateConfig(config);
  return problems;
}

function checkFile(contentType, raw) {
  // Tiny multipart parser — only the file field matters for the STT proxy.
  const boundary = /boundary=([^;]+)/.exec(contentType || "")?.[1]?.trim().replace(/^"|"$/g, "");
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  let idx = raw.indexOf(marker);
  if (idx === -1) return null;
  idx += marker.length;
  if (raw.subarray(idx, idx + 2).toString() === "\r\n") idx += 2;
  // find the header terminator in the raw buffer
  let headerEnd = -1;
  for (let i = idx; i < raw.length - 3; i++) {
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) return null;
  const head = raw.subarray(idx, headerEnd).toString("utf8");
  const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(head);
  const filenameMatch = /filename="([^"]+)"/i.exec(head);
  idx = headerEnd + 4;
  let end = raw.indexOf(marker, idx);
  if (end === -1) end = raw.length;
  // strip the CRLF that precedes the boundary
  let data = raw.subarray(idx, end);
  if (data.length >= 2 && data[data.length - 1] === 0x0a && data[data.length - 2] === 0x0d) {
    data = data.subarray(0, data.length - 2);
  }
  return {
    data: Buffer.from(data),
    contentType: contentTypeMatch?.[1]?.trim() || "application/octet-stream",
    filename: filenameMatch?.[1] || "audio.webm",
  };
}

function extractFile(raw, contentType) {
  return checkFile(contentType, raw);
}

// ---------------------------------------------------------------------------
// Boot — create app, listen, and report startup health honestly
// ---------------------------------------------------------------------------

async function boot() {
  await mkdir(DATA, { recursive: true });

  const problems = validateConfig(config);
  if (problems.length) {
    log.warn("Configuration problems (see README):");
    for (const p of problems) log.warn("  • " + p);
  }

  memoryStore = await openMemoryStore(DATA);
  conversationStore = await openConversationStore(path.join(DATA, "zenith.db"));
  scheduler = await openReminderScheduler(path.join(DATA, "zenith.db"));
  profileStore = new ProfileStore(path.join(DATA, "profile.md"));
  brain = new Brain({
    config,
    logger: log,
    effortProvider: () => ({ variant: currentEffort }),
  });

  const httpServer = app.listen(config.port, config.host, () => {
    log.info(`ZENITH is listening on http://localhost:${config.port}`);
    log.info(`Brain: ${config.llm.provider} / ${config.llm.model} ${llmReady(config) ? "(ready)" : "(NOT configured — chat unavailable)"}`);
    log.info(`Voice: ${voiceReady(config) ? "ElevenLabs configured" : "local fallback"} | STT: ${sttReady(config) ? "server-side " + config.stt.model : "browser fallback"}`);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws/voice" });
  wss.on("connection", (ws, req) => {
    if (!originAllowed(req?.headers?.origin)) {
      ws.close(1008, "forbidden origin");
      return;
    }
    attachVoiceHandler(ws, {
      config,
      settingsLoader: loadSettings,
      saveSettings,
      logger: log,
    });
  });

  // Reminders + check-ins tick.
  const TICK_MS = 15_000;
  setInterval(async () => {
    if (chatBusy) return;
    try {
      const settings = await loadSettings();
      const due = scheduler.dueNow({ settings });
      for (const entry of due) {
        if (chatBusy) return;
        chatBusy = true;
        try {
          const voiceMode = true; // reminders are spoken, not typed
          await runTurn({ text: entry.prompt, voiceMode, onDelta: () => {}, persist: true });
          if (entry.kind === "checkin") {
            scheduler.markCheckinFired(entry.id.includes("morning") ? "morning" : "evening");
          } else {
            scheduler.afterFire(entry);
          }
          log.info(`Fired ${entry.kind}: ${entry.id}`);
        } catch (err) {
          log.warn(`Reminder/check-in fire failed (${entry.kind}):`, err?.message || err);
        } finally {
          chatBusy = false;
        }
      }
    } catch (err) {
      log.warn("Reminder tick failed:", err?.message || err);
    }
  }, TICK_MS).unref?.();

  // Refresh the memory export once at startup (new entries come only via the API).
  try {
    await memoryStore.exportMarkdown(path.join(DATA, "memory.md"));
  } catch {
    /* ignore */
  }

  // Graceful shutdown.
  const shutdown = () => {
    log.info("Shutting down…");
    try {
      memoryStore?.close();
      conversationStore?.close();
      scheduler?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, httpServer, wss, brain, memoryStore, conversationStore, scheduler, profileStore };
}

const started = { ok: false };

export function start() {
  return boot().then((result) => {
    started.ok = true;
    return result;
  });
}

// Direct run (not imported by tests): boot when executed directly.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  start().catch((err) => {
    log.error("Failed to start ZENITH:", err?.message || err);
    process.exit(1);
  });
}

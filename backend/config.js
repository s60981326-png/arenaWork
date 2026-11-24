import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node 20.12+ loads .env natively. Fail soft — a missing .env file is fine
// (env vars may come from the shell instead).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine
}

export function rootDir() {
  return ROOT;
}

function str(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function int(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * Resolve the ZENITH configuration from environment variables.
 * Every field is read-only at runtime — edit .env and restart to change.
 */
export function loadConfig() {
  const llmBase = str(process.env.ZENITH_LLM_BASE_URL, "https://api.openai.com/v1");
  const llmKey = str(process.env.ZENITH_LLM_API_KEY) || str(process.env.OPENAI_API_KEY);
  const llmModel = str(process.env.ZENITH_LLM_MODEL, "gpt-4o-mini");
  const llmProviderId = str(process.env.ZENITH_LLM_PROVIDER, "openai");
  const llmTemp = Number(process.env.ZENITH_LLM_TEMPERATURE ?? "0.75");
  const llmMaxTokens = int(process.env.ZENITH_LLM_MAX_TOKENS, 1024, { min: 64, max: 16384 });
  const llmTimeoutMs = int(process.env.ZENITH_LLM_TIMEOUT_MS, 120_000, { min: 5000, max: 600_000 });
  const llmRetries = int(process.env.ZENITH_LLM_RETRIES, 1, { min: 0, max: 5 });

  const elKey = str(process.env.ELEVENLABS_API_KEY) || str(process.env.ZENITH_ELEVENLABS_API_KEY);
  const elVoiceId = str(process.env.ELEVENLABS_VOICE_ID) || str(process.env.ZENITH_ELEVENLABS_VOICE_ID);
  const elBaseUrl = str(process.env.ELEVENLABS_BASE_URL, "https://api.elevenlabs.io");
  const elMonthlyCap = int(process.env.ELEVENLABS_MONTHLY_CHARS_CAP, 18_000, { min: 0 });
  const elTurnCap = int(process.env.ELEVENLABS_TURN_CHARS_CAP, 420, { min: 0 });

  const sttBaseUrl = str(process.env.ZENITH_STT_BASE_URL, "https://api.openai.com/v1");
  const sttKey = str(process.env.ZENITH_STT_API_KEY) || str(process.env.ZENITH_LLM_API_KEY) || str(process.env.OPENAI_API_KEY);
  const sttModel = str(process.env.ZENITH_STT_MODEL, "whisper-1");
  const sttLanguage = str(process.env.ZENITH_STT_LANGUAGE, ""); // empty = auto-detect
  const sttTimeoutMs = int(process.env.ZENITH_STT_TIMEOUT_MS, 60_000, { min: 5000, max: 300_000 });

  const dataDir = str(process.env.ZENITH_DATA_DIR, "");
  const port = int(process.env.ZENITH_PORT, 4567, { min: 0, max: 65535 }); // 0 = ephemeral (tests)
  const host = str(process.env.ZENITH_HOST, "127.0.0.1");
  const stream = bool(process.env.ZENITH_LLM_STREAM, true);

  return {
    root: ROOT,
    dataDir: dataDir ? path.resolve(ROOT, dataDir) : path.join(ROOT, "data"),
    assetsDir: path.join(ROOT, "frontend", "images"),
    frontendDir: path.join(ROOT, "frontend"),
    personalityPath: path.join(ROOT, "config", "personality.md"),
    port,
    host,
    llm: {
      provider: llmProviderId,
      baseUrl: trimSlash(llmBase),
      apiKey: llmKey,
      model: llmModel,
      temperature: Number.isFinite(llmTemp) ? Math.min(2, Math.max(0, llmTemp)) : 0.75,
      maxTokens: llmMaxTokens,
      timeoutMs: llmTimeoutMs,
      retries: llmRetries,
      stream,
    },
    elevenlabs: {
      apiKey: elKey,
      voiceId: elVoiceId,
      baseUrl: trimSlash(elBaseUrl),
      monthlyCap: elMonthlyCap,
      turnCap: elTurnCap,
    },
    stt: {
      baseUrl: trimSlash(sttBaseUrl),
      apiKey: sttKey,
      model: sttModel,
      language: sttLanguage,
      timeoutMs: sttTimeoutMs,
    },
  };
}

/**
 * Validate credentials at startup. Returns a list of human-readable problems
 * (empty list = everything required is present and looks sane). Does NOT throw.
 */
export function validateConfig(config) {
  const problems = [];
  if (!config.llm.apiKey) {
    problems.push(
      "AI brain: no API key — set ZENITH_LLM_API_KEY (or OPENAI_API_KEY) in .env"
    );
  }
  if (!/^https?:\/\//.test(config.llm.baseUrl)) {
    problems.push(`AI brain: ZENITH_LLM_BASE_URL must start with http:// or https:// (got "${config.llm.baseUrl}")`);
  }
  if (!config.llm.model) {
    problems.push("AI brain: ZENITH_LLM_MODEL is empty");
  }
  if (!config.elevenlabs.apiKey) {
    problems.push("Voice: ELEVENLABS_API_KEY not set — spoken replies will use the local/system voice (optional)");
  }
  if (config.elevenlabs.apiKey && !config.elevenlabs.voiceId) {
    problems.push("Voice: ELEVENLABS_VOICE_ID not set — pick a voice in Settings, or set it in .env");
  }
  if (!config.stt.apiKey) {
    problems.push("Speech recognition: ZENITH_STT_API_KEY (or OPENAI_API_KEY) not set — using the browser's Web Speech API as fallback");
  }
  return problems;
}

/** True when the brain can actually be used. */
export function llmReady(config) {
  return !!config.llm.apiKey;
}

/** True when the ElevenLabs voice can be used. */
export function voiceReady(config) {
  return !!config.elevenlabs.apiKey && !!config.elevenlabs.voiceId;
}

/** True when the server-side STT proxy can be used. */
export function sttReady(config) {
  return !!config.stt.apiKey;
}

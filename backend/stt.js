// Speech-to-text — server-side proxy to an OpenAI-compatible transcription API.
//
// Why server-side: the browser's built-in SpeechRecognition sends the
// microphone audio to whatever vendor backs it and fails silently on
// networks it doesn't like (the classic "network error"). ZENITH's preferred
// path records the user's voice, uploads it to the configured STT provider,
// and gets a transcript back — with the same timeout/retry discipline as
// the brain, and the browser Web Speech API kept as a fallback.
//
// Any endpoint that speaks the OpenAI-compatible /audio/transcriptions API
// works (OpenAI Whisper, Groq, DeepInfra, OpenRouter, …).

import { log } from "./logger.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function sttStatus(config) {
  return {
    configured: !!config.stt.apiKey,
    provider: "openai-compatible",
    model: config.stt.model,
    language: config.stt.language || "auto",
    latencyNotes: "Audio is uploaded once per utterance, not streamed.",
  };
}

/**
 * Transcribe an audio blob. Throws on failure with a clear message.
 * `audio` is a Buffer; `contentType` an audio mime type (e.g. audio/webm).
 */
export async function transcribeAudio({ config, audio, contentType = "audio/webm", filename = "audio.webm", logger = log }) {
  if (!config.stt.apiKey) throw new Error("Speech-to-text is not configured — set ZENITH_STT_API_KEY (or OPENAI_API_KEY) in .env.");
  if (!Buffer.isBuffer(audio) || !audio.length) throw new Error("No audio to transcribe.");

  const maxAttempts = 2; // one retry — bounded, never infinite
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const form = new FormData();
      const blob = new Blob([audio], { type: contentType });
      form.append("file", blob, filename);
      form.append("model", config.stt.model);
      if (config.stt.language) form.append("language", config.stt.language);
      form.append("response_format", "json");

      const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.stt.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(config.stt.timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`STT provider answered ${res.status}: ${detail.slice(0, 240)}`);
        err.status = res.status;
        lastErr = err;
        if (res.status >= 500 || res.status === 429) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw err; // 4xx: retry won't help
      }
      const data = await res.json();
      const text = String(data?.text || "").trim();
      return { text, language: data?.language || null };
    } catch (err) {
      if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        throw new Error("Speech-to-text request timed out");
      }
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        logger.warn(`STT attempt ${attempt + 1} failed: ${err?.message || err} — retrying`);
        await sleep(700);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("Speech-to-text failed");
}

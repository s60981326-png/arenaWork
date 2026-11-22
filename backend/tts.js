// ElevenLabs voice — streaming TTS over a WebSocket.
//
// Browser <-> this server <-> ElevenLabs stream-input. The browser receives
// raw PCM (raw frames, not base64); the API key NEVER leaves this process.
//
// Robustness contract (this is the "ElevenLabs input_timeout_exceeded" fix):
//   - every upstream connection has an 8s open watchdog + a 1-attempt retry
//   - every message frame is budgeted (per-reply cap + monthly cap)
//   - quota errors flag the settings file so the UI can warn honestly
//   - the upstream cannot hang the browser: the browser owns its own
//     sentence-level watchdog and falls back to the local/system voice

import { WebSocket as WsClient } from "ws";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export const DEFAULT_MONTHLY_CAP = 18_000;
export const DEFAULT_TURN_CAP = 420;
const UPSTREAM_OPEN_WATCHDOG_MS = 8_000;

export function wsBaseUrl(config) {
  return (
    config.elevenlabs.baseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:") + "/v1/text-to-speech/"
  );
}

export async function getElevenLabsKey(config) {
  if (config.elevenlabs.apiKey) return config.elevenlabs.apiKey;
  try {
    const key = (await readFile(path.join(config.root, "secrets", "elevenlabs.key"), "utf8")).trim();
    if (key.length >= 8 && !key.startsWith("#") && !key.startsWith("<")) return key;
  } catch {
    // no key file — fall back to the system/local voice
  }
  return null;
}

export function resolveVoiceId(config, settings) {
  const fromSettings = settings?.voiceId ? String(settings.voiceId).trim() : "";
  return fromSettings || config.elevenlabs.voiceId || null;
}

/** Map an ElevenLabs error message to "quota" only for its real quota text. */
export function quotaErrorText(msg) {
  const t = String(msg || "").toLowerCase();
  return /quota_exceeded|quota|insufficient credits|out of credits|insufficient balance|character limit|exceeded your|payment required|detected_unusual_activity/.test(t) ? t : null;
}

export function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

export function usageView(settings, config) {
  const u = settings.elUsage && settings.elUsage.month === monthKey() ? settings.elUsage : { month: monthKey(), chars: 0 };
  return {
    month: u.month,
    chars: u.chars,
    monthlyCap: settings.elMonthlyCap ?? config.elevenlabs.monthlyCap ?? DEFAULT_MONTHLY_CAP,
    turnCap: settings.elTurnCap ?? config.elevenlabs.turnCap ?? DEFAULT_TURN_CAP,
  };
}

export function voiceSettingsFor(settings) {
  const v = settings.voiceSettings || {};
  const out = {
    stability: v.stability ?? 0.45,
    similarity_boost: v.similarity_boost ?? 0.8,
    style: v.style ?? 0.25,
    use_speaker_boost: v.use_speaker_boost ?? true,
  };
  if (Number.isFinite(v.speed)) out.speed = v.speed;
  return out;
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    // client gone — nothing to do
  }
}

function safeSendBuffer(ws, data) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
  } catch {
    // client gone
  }
}

/**
 * Attach the voice WebSocket handler to a browser socket.
 * The browser sends: { type: "start" | "text" | "end" | "stop", text? }
 * The server sends: JSON control frames + binary PCM frames.
 */
export function attachVoiceHandler(ws, { config, settingsLoader, saveSettings, logger = log }) {
  const wsBase = wsBaseUrl(config);

  let turnChars = 0; // characters forwarded to ElevenLabs in the current reply
  let turnCapped = false; // once true, this reply stays on the local voice
  let sentFirstChunk = false; // only the first upstream text frame is flushed
  let el = null; // upstream socket
  let elReady = false; // upstream fully open
  let drainTimer = null;
  let watchdog = null;
  const pending = []; // control messages that arrived before upstream opened

  // Serialized usage accounting: the monthly counter is read-modify-write, so
  // every charge goes through this queue.
  let usageChain = Promise.resolve();
  function chargeUsage(chars) {
    const p = usageChain.then(async () => {
      const settings = await settingsLoader();
      const view = usageView(settings, config);
      if (view.chars + chars > view.monthlyCap) return "month";
      await saveSettings({ elUsage: { month: view.month, chars: view.chars + chars } });
      return null;
    });
    usageChain = p.then(() => {}, () => {});
    return p.catch(() => null);
  }

  async function maybeFlagQuota(msg) {
    if (!quotaErrorText(msg)) return;
    const settings = await settingsLoader();
    if (!settings.elQuotaExhausted) {
      await saveSettings({ elQuotaExhausted: new Date().toISOString() });
    }
  }

  const elClose = () => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    elReady = false;
    if (el) {
      try {
        el.terminate();
      } catch {
        // already gone
      }
      el = null;
    }
  };

  const elSend = (txt) => {
    if (elReady && el && el.readyState === el.OPEN) {
      try {
        el.send(txt);
        return true;
      } catch {
        elClose();
        return false;
      }
    }
    pending.push(txt);
    return false;
  };

  const openUpstream = () =>
    new Promise((resolve) => {
      (async () => {
        const key = await getElevenLabsKey(config);
        const settings = await settingsLoader();
        const voiceId = resolveVoiceId(config, settings);
        if (!key || !voiceId) {
          safeSend(ws, { type: "error", message: "ElevenLabs not configured — add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (or pick a voice in Settings)." });
          resolve(false);
          return;
        }
        const url = `${wsBase}${encodeURIComponent(voiceId)}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_22050&inactivity_timeout=60&optimize_streaming_latency=3`;
        const attempt = (n) => {
          const retryUpstream = () => {
            elClose();
            setTimeout(() => attempt(1), 600).unref?.();
          };
          try {
            el = new WsClient(url, { headers: { "xi-api-key": key } });
          } catch (err) {
            safeSend(ws, { type: "error", message: err?.message || "upstream connection failed" });
            if (n === 0) return retryUpstream();
            resolve(false);
            return;
          }
          el.binaryType = "arraybuffer";

          const armWatchdog = (deadline) => {
            watchdog = setTimeout(() => {
              watchdog = null;
              try {
                el?.terminate();
              } catch {}
              // Pre-open watchdog: fail over to the browser fallback path.
              if (!elReady) {
                safeSend(ws, { type: "error", message: "ElevenLabs did not connect in time." });
                if (n === 0) return retryUpstream();
                resolve(false);
              }
            }, deadline);
            watchdog.unref?.();
          };
          armWatchdog(UPSTREAM_OPEN_WATCHDOG_MS);

          el.on("open", () => {
            if (watchdog) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            elReady = true;
            try {
              // Required init frame; voice_settings shape the whole stream.
              el.send(JSON.stringify({ text: " ", voice_settings: voiceSettingsFor(settings) }));
            } catch {
              // socket closed mid-send; the close handler reports it
            }
            // The one-space protocol frame is reserved against the per-turn
            // cap when the turn started; charge the monthly counter here.
            chargeUsage(1);
            for (const txt of pending.splice(0)) {
              if (!elSend(txt)) break;
            }
            safeSend(ws, { type: "ready" });
            resolve(true);
          });

          el.on("message", async (data, isBinary) => {
            if (isBinary) {
              safeSendBuffer(ws, data);
              return;
            }
            const text = data.toString();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              return; // ignore non-JSON text frames
            }
            if (json.audio != null && typeof json.audio === "string" && json.audio.length > 0) {
              try {
                const pcm = Buffer.from(json.audio, "base64");
                if (pcm.length) safeSendBuffer(ws, pcm);
              } catch {
                // undecodable payload — drop this frame, keep the stream alive
              }
              return;
            }
            if (json.error) {
              const msg = typeof json.error === "string" ? json.error : json.error?.message || "upstream error";
              await maybeFlagQuota(msg);
              safeSend(ws, { type: "error", message: msg });
              return;
            }
            if (json.detail) {
              const msg = typeof json.detail === "string" ? json.detail : json.detail?.message || "upstream rejected the request";
              await maybeFlagQuota(msg);
              safeSend(ws, { type: "error", message: msg });
              return;
            }
            if (json.isFinal || json.audio === null || json.audio === "") {
              safeSend(ws, { type: "audio_end" });
              elClose();
            }
          });

          el.on("close", () => {
            if (watchdog) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (!elReady && n === 0 && pending.length === 0 && turnChars === 0) {
              // The upstream died before the turn even began — retry once.
              retryUpstream();
              return;
            }
            safeSend(ws, { type: "audio_end" });
            elClose();
          });

          el.on("error", (err) => {
            if (watchdog) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (!elReady && n === 0) {
              retryUpstream();
              return;
            }
            safeSend(ws, { type: "error", message: err?.message || "upstream connection error" });
            elClose();
          });
        };
        attempt(0);
      })();
    });

  // Messages are handled strictly in order: the budget checks await disk
  // reads, so without this queue an "end" frame could overtake a sentence
  // still being checked and close the stream early.
  let chain = Promise.resolve();
  ws.on("message", (data) => {
    chain = chain.then(() => handleMessage(data)).catch(() => {});
  });

  async function handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "start") {
      elClose();
      // Reserve the protocol init character BEFORE any text can be processed.
      turnChars = 1;
      turnCapped = false; // fresh reply: ElevenLabs is allowed again
      sentFirstChunk = false;
      await openUpstream();
    } else if (msg.type === "text") {
      const text = String(msg.text || "");
      if (!text.trim()) return;
      const settings = await settingsLoader();
      const turnCap = settings.elTurnCap ?? config.elevenlabs.turnCap ?? DEFAULT_TURN_CAP;
      // Count EXACTLY what goes upstream: the clause plus the one space that
      // separates it from the next chunk (sentence chunks are trimmed).
      const cost = text.length + 1;
      if (turnCapped || turnChars + cost > turnCap) {
        safeSend(ws, { type: "capped", reason: "turn", text });
        turnCapped = true;
        return;
      }
      const reason = await chargeUsage(cost);
      if (reason) {
        safeSend(ws, { type: "capped", reason, text });
        return;
      }
      turnChars += cost;
      // elSend buffers until the upstream is ready, so early sentences are
      // kept, not dropped. Flush only the first sentence (fast start).
      elSend(JSON.stringify({ text: text + " ", flush: !sentFirstChunk }));
      sentFirstChunk = true;
    } else if (msg.type === "end") {
      elSend(JSON.stringify({ text: "", flush: true }));
      // Flush forces the last buffered audio; force-close shortly after so
      // the browser is never left waiting on a silent stream.
      drainTimer = setTimeout(() => {
        safeSend(ws, { type: "audio_end" });
        elClose();
      }, 4000);
      drainTimer.unref?.();
    } else if (msg.type === "stop") {
      elClose();
      safeSend(ws, { type: "stopped" });
    }
  }

  ws.on("close", () => elClose());
}

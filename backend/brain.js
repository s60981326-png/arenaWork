// ZENITH's AI brain.
//
// This module is the ONLY place that talks to an LLM. It speaks the
// OpenAI-compatible /chat/completions API, which covers OpenAI, Groq,
// Together, DeepInfra, OpenRouter, LM Studio, Ollama and most self-hosted
// endpoints — a provider is just a base URL + key + model, all from env vars.
//
// Responsibilities:
//   - load the personality config (config/personality.md)
//   - assemble the system prompt (personality + relevant memory + profile + summary)
//   - stream the reply token-by-token to the caller (async generator of deltas)
//   - summarize older conversation history so context stays bounded
//   - never pretend: if the provider is missing or unreachable, raise a clear error

import { readFile } from "node:fs/promises";
import { log } from "./logger.js";

// Extract a single-line "MEMORY: ..." tag the model may end a reply with.
export function extractMemorySuggestion(text) {
  const match = /^MEMORY:\s*(.+?)\s*$/m.exec(String(text || ""));
  if (!match) return { text: String(text || ""), suggestion: null };
  return {
    text: String(text).replace(/^MEMORY:.*\r?\n?/m, "").trimEnd(),
    suggestion: match[1].trim(),
  };
}

export function buildSystemPrompt({ personality, memorySection, profileSection, summary, mode = "text" }) {
  const parts = [];
  if (personality) parts.push(personality.trim());
  if (mode === "voice") {
    parts.push(
      "[VOICE MODE] Your reply is spoken aloud and read out of a single text-to-speech engine. " +
        "Keep it to one or three short sentences. No lists, no markdown, no emojis, no headings, no URLs, no filler."
    );
  } else {
    parts.push(
      "[TEXT MODE] Your reply is typed. It may be a short, flowing answer with light markdown when it genuinely helps. " +
        "Still keep it human — like a person who knows the user, not a documentation site."
    );
  }
  if (summary) {
    parts.push(
      `[CONVERSATION SO FAR — running summary, newest first]\n${summary}\n` +
        "Use this only to stay grounded; it is a lossy summary, not a transcript."
    );
  }
  if (memorySection) {
    parts.push(
      `[MEMORY — facts the user explicitly asked ZENITH to remember]\n${memorySection}\n` +
        "Everything above was stated or approved by the user. Treat it as the user's own words; confirm before relying on it if it seems stale."
    );
  }
  if (profileSection) {
    parts.push(profileSection);
  }
  return parts.filter(Boolean).join("\n\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Brain {
  constructor({ config, logger = log, effortProvider = null }) {
    this.config = config;
    this.log = logger;
    this._personality = null;
    // Server-injected function returning { variant: 'low'|'medium'|'high' }
    this.effortProvider = effortProvider;
    this._reasoningEffortUnsupported = false; // once a provider rejects it, don't retry every turn
  }

  async loadPersonality() {
    if (this._personality !== null) return this._personality;
    try {
      this._personality = await readFile(this.config.personalityPath, "utf8");
    } catch (err) {
      this.log.warn("Personality config missing/unreadable:", err?.message || err);
      this._personality =
        "You are ZENITH, a personal AI companion. Be warm, honest, calm and composed. Keep spoken replies short and conversational.";
    }
    return this._personality;
  }

  /** Raw fetch to the provider with a timeout. Throws a clear error on failure. */
  async _fetch(body, { signal, method = "POST", url } = {}) {
    const llm = this.config.llm;
    const url0 = url || `${llm.baseUrl}/chat/completions`;
    let lastErr = null;
    const retries = Math.max(0, Number(llm.retries ?? 0));
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url0, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
          signal: signal || AbortSignal.timeout(llm.timeoutMs),
        });
        if (res.ok) return res;
        const detail = await res.text().catch(() => "");
        const err = new Error(`LLM provider answered ${res.status}: ${detail.slice(0, 300)}`);
        err.status = res.status;
        // Retry once on server errors / rate limits / timeouts.
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          this.log.warn(`LLM ${res.status} (attempt ${attempt + 1}) — retrying…`);
          await sleep(800 * (attempt + 1));
          lastErr = err;
          continue;
        }
        throw err;
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
          throw new Error("LLM request was aborted/timed out");
        }
        lastErr = err;
        if (attempt < retries) {
          this.log.warn(`LLM fetch failed (attempt ${attempt + 1}): ${err?.message || err} — retrying…`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error("LLM request failed");
  }

  /**
   * Stream a chat completion. Yields text deltas.
   * Throws on failure — the caller should surface the error, never fake it.
   */
  async *stream({ messages, signal } = {}) {
    const llm = this.config.llm;
    let body = this._body(messages, false);
    try {
      yield* this._streamOnce(body, { signal });
      return;
    } catch (err) {
      // Providers that reject the reasoning_effort parameter get one honest
      // retry without it — the effort is then only a documented intent.
      if (this._reasoningEffortUnsupported || !/reasoning_effort/i.test(String(err?.message || ""))) throw err;
      this._reasoningEffortUnsupported = true;
      this.log.debug("Provider rejected reasoning_effort; falling back to plain request");
      body = this._body(messages, false);
      // remove the reasoning_effort hint entirely on retry
      delete body.reasoning_effort;
      yield* this._streamOnce(body, { signal });
    }
  }

  _body(messages, stream) {
    const llm = this.config.llm;
    const body = {
      model: llm.model,
      messages,
      temperature: llm.temperature,
      max_tokens: llm.maxTokens,
      stream,
    };
    if (llm.stream === false) body.stream = false;
    else body.stream = true;
    // Reasoning effort: only attached when the user picked one AND the
    // provider is configured to use one (reasoning models). Older/unknown
    // providers ignore extra fields; the fallback above handles the rest.
    const effort = this.effortProvider?.()?.variant;
    if (["low", "medium", "high"].includes(effort) && !this._reasoningEffortUnsupported) {
      body.reasoning_effort = effort;
    }
    return body;
  }

  async *_streamOnce(body, { signal } = {}) {
    const res = await this._fetch(body, { signal });
    if (!res.body) throw new Error("LLM provider returned no stream body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const raw of events) {
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") return;
            let chunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue; // ignore partial/malformed frames
            }
            const delta = chunk?.choices?.[0]?.delta;
            if (!delta) continue;
            if (typeof delta.content === "string") {
              if (delta.content) yield delta.content;
            } else if (Array.isArray(delta.content)) {
              for (const part of delta.content) {
                if (part && part.type === "text" && typeof part.text === "string") yield part.text;
              }
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** Non-streaming completion (used by summarization). Returns the full text. */
  async complete({ messages, maxTokens = 400, temperature = 0.4, signal } = {}) {
    const llm = this.config.llm;
    const body = {
      model: llm.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    const res = await this._fetch(body, { signal });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string") return text.trim();
    if (Array.isArray(text)) {
      return text
        .map((p) => (p && p.type === "text" ? p.text : ""))
        .join("")
        .trim();
    }
    return "";
  }

  /**
   * Summarize older messages into a short running summary. Best-effort:
   * never throws — on failure the previous summary stands.
   */
  async summarize({ previousSummary, messages, conversationId }) {
    try {
      const lines = messages
        .map((m) => `${m.role === "user" ? "User" : "ZENITH"}: ${String(m.text || "").slice(0, 1200)}`)
        .join("\n");
      const system = [
        "You maintain a short running summary of a conversation between a personal AI companion (ZENITH) and their user.",
        "The summary must be useful for staying grounded in the user's context: name, goals, decisions, preferences, unresolved threads.",
        "Write 3-6 sentences, neutral tone, no markdown, no preamble. Do not invent facts.",
      ].join(" ");
      const user =
        (previousSummary ? `Previous summary:\n${previousSummary}\n\n` : "") +
        `New messages to fold in:\n${lines}\n\nSummarize the whole thing now (keeping still-true details from the previous summary).`;
      const out = await this.complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        maxTokens: 500,
        temperature: 0.3,
      });
      return out || previousSummary || "";
    } catch (err) {
      this.log.warn("Summarization skipped:", err?.message || err);
      return previousSummary || "";
    }
  }
}

/** True when the brain has enough configuration to be used at all. */
export function brainReady(config) {
  return !!(config.llm && config.llm.apiKey);
}

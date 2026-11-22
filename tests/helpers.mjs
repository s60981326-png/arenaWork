// Test harness — boots a real ZENITH backend (in-process) against an in-process
// fake LLM, on an ephemeral port, with a throwaway data dir. Nothing outside
// the sandbox is touched: no real API keys, no real provider, no network.

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fake-llm.mjs";

export async function startTestServer({ fakeLlm = {}, keepDataDir = false } = {}) {
  const fake = await startFakeLlm(fakeLlm);
  const dataDir = await mkdtemp(path.join(tmpdir(), "zenith-test-"));
  await mkdir(path.join(dataDir, "data"), { recursive: true });
  const tempData = path.join(dataDir, "data");

  process.env.ZENITH_DATA_DIR = tempData;
  process.env.ZENITH_PORT = "0"; // ephemeral — read back after boot
  process.env.ZENITH_HOST = "127.0.0.1";
  process.env.ZENITH_LLM_BASE_URL = fake.baseUrl;
  process.env.ZENITH_LLM_API_KEY = "test-key";
  process.env.ZENITH_LLM_MODEL = "mock-model";
  process.env.ZENITH_LLM_RETRIES = "0";
  process.env.ZENITH_LLM_TIMEOUT_MS = "15000";
  process.env.ZENITH_STT_BASE_URL = fake.baseUrl;
  process.env.ZENITH_STT_API_KEY = "test-key";
  process.env.ZENITH_STT_MODEL = "whisper-1";
  process.env.ELEVENLABS_API_KEY = ""; // never touch the real voice
  process.env.ELEVENLABS_VOICE_ID = "";

  // Import AFTER env is set — server.js reads config at module load.
  const { start } = await import("../backend/server.js");
  const started = await start();
  const port = started.httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    try {
      started.httpServer?.close();
    } catch {}
    try {
      started.brain?.close?.();
    } catch {}
    try {
      started.memoryStore?.close?.();
    } catch {}
    try {
      started.conversationStore?.close?.();
    } catch {}
    try {
      started.scheduler?.close?.();
    } catch {}
    try {
      started.profileStore?.close?.();
    } catch {}
    try {
      await fake.close();
    } catch {}
    if (!keepDataDir) {
      try {
        await rm(dataDir, { recursive: true, force: true });
      } catch {}
    }
  };

  return {
    baseUrl,
    dataDir: tempData,
    fake,
    started,
    cleanup,
    async fetch(path, opts = {}) {
      return fetch(baseUrl + path, opts);
    },
    async json(path, opts) {
      const res = await this.fetch(path, opts);
      const body = await res.json().catch(() => null);
      return { res, body };
    },
  };
}

// Parse an SSE stream of "event: X\ndata: {...}" blocks into { event, data }.
export async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() || "message";
    const data = /^data:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      payload = data;
    }
    events.push({ event, data: payload });
  }
  return events;
}

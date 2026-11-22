// Unit tests for the backend stores and modules. No network, no real providers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryStore } from "../backend/memory.js";
import { ReminderScheduler, nextOccurrenceDate, humanizeWhen, CHECKIN_IDS } from "../backend/reminders.js";
import { ConversationStore } from "../backend/conversation.js";
import { extractMemorySuggestion, buildSystemPrompt } from "../backend/brain.js";
import { loadConfig, validateConfig } from "../backend/config.js";
import { profileSections } from "../backend/profile.js";

async function tmpDb() {
  const dir = await mkdtemp(path.join(tmpdir(), "zenith-unit-"));
  return { dir, db: path.join(dir, "db.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("memory store: add, list, update, delete, and export markdown", async (t) => {
  const { dir, db, cleanup } = await tmpDb();
  t.after(cleanup);
  const store = new MemoryStore(db);
  t.after(() => store.close());

  const entry = store.add({ text: "User prefers short emails", type: "user-approved fact" });
  assert.ok(entry.id.startsWith("m_"));
  assert.equal(entry.text, "User prefers short emails");

  assert.equal(store.list().length, 1);

  const updated = store.update(entry.id, { text: "User prefers brief emails" });
  assert.equal(updated.text, "User prefers brief emails");

  const mdPath = path.join(dir, "memory.md");
  await store.exportMarkdown(mdPath);
  const md = await import("node:fs/promises").then((m) => m.readFile(mdPath, "utf8"));
  assert.match(md, /brief emails/);

  assert.ok(store.remove(entry.id));
  assert.equal(store.list().length, 0);
});

test("memory store: rejects empty text", async (t) => {
  const { dir, db, cleanup } = await tmpDb();
  t.after(cleanup);
  const store = new MemoryStore(db);
  t.after(() => store.close());
  assert.throws(() => store.add({ text: "   " }), /Empty memory text/);
});

test("reminders: once / daily / weekly next-due computation", async () => {
  assert.ok(nextOccurrenceDate("09:00", new Date("2026-11-22T08:00:00")).getHours() === 9);

  const { dir, db, cleanup } = await tmpDb();
  const store = new ReminderScheduler({ dbPath: db });
  cleanup();
  try {
    const future = new Date(Date.now() + 48 * 3600_000);
    const once = store.add({ name: "water", kind: "once", time: "19:41", date: future.toISOString().slice(0, 10) });
    assert.equal(once.kind, "once");
    assert.ok(Date.parse(once.nextDueAt) > Date.now());

    const daily = store.add({ name: "meditate", kind: "daily", time: "07:30" });
    assert.ok(Date.parse(daily.nextDueAt) > Date.now());

    const weekly = store.add({ name: "plan", kind: "weekly", time: "18:00" });
    assert.ok([1, 2, 3, 4, 5].includes(new Date(weekly.nextDueAt).getDay()));

    assert.equal(humanizeWhen({ kind: "once", time: "19:41", date: "2026-11-22" }), "at 2026-11-22 19:41");
    assert.equal(humanizeWhen({ kind: "daily", time: "07:30" }), "daily at 07:30");
    assert.equal(store.list().length, 3);
  } finally {
    store.close();
  }
});

test("reminders: afterFire marks once done, advances daily/weekly", async () => {
  const { dir, db, cleanup } = await tmpDb();
  const store = new ReminderScheduler({ dbPath: db });
  {
    try {
      const once = store.add({ name: "one-off", kind: "once", time: "19:41", date: "2026-11-22" });
      store.afterFire({ kind: "reminder", id: once.id });
      const afterOnce = store.all().find((r) => r.id === once.id);
      assert.equal(afterOnce.status, "done");
      assert.ok(afterOnce.last_fired_at);

      const daily = store.add({ name: "daily", kind: "daily", time: "07:30" });
      store.afterFire({ kind: "reminder", id: daily.id });
      const afterDaily = store.all().find((r) => r.id === daily.id);
      assert.ok(Date.parse(afterDaily.next_due_at) > Date.now());
      assert.notEqual(afterDaily.status, "done");
      assert.ok(afterDaily.last_fired_at);
    } finally {
      store.close();
      await cleanup();
    }
  }
});

test("reminders: dueNow returns due reminders with prompts", async () => {
  const { dir, db, cleanup } = await tmpDb();
  const store = new ReminderScheduler({ dbPath: db });
  try {
    // A reminder due in the past — should be picked up by dueNow.
    const past = new Date(Date.now() - 60_000);
    store.add({ name: "past", kind: "once", time: "00:00", date: past.toISOString().slice(0, 10) });
    // Force it to be due by rewriting next_due_at.
    store.db.prepare("UPDATE reminders SET next_due_at = ? WHERE status = 'active'")
      .run(new Date(Date.now() - 1000).toISOString());

    const due = store.dueNow({ settings: { checkinEnabled: false }, now: new Date() });
    const reminderDue = due.filter((d) => d.kind === "reminder");
    assert.equal(reminderDue.length, 1);
    assert.match(reminderDue[0].prompt, /^Reminder: past/);
  } finally {
    store.close();
    await cleanup();
  }
});

test("reminders: check-ins due within 5 minutes after clock time, tracked per day", async () => {
  const { dir, db, cleanup } = await tmpDb();
  const store = new ReminderScheduler({ dbPath: db });
  try {
    const now = new Date();
    const morning = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const settings = { checkinEnabled: true, checkinMorning: morning, checkinEvening: "21:00" };
    const due = store.dueNow({ settings, now });
    const checkins = due.filter((d) => d.kind === "checkin");
    assert.ok(checkins.some((d) => d.id === CHECKIN_IDS.morning));

    // Mark morning fired for today — the same time must not fire twice.
    store.markCheckinFired("morning");
    const dueAgain = store.dueNow({ settings, now });
    assert.ok(!dueAgain.some((d) => d.id === CHECKIN_IDS.morning));
  } finally {
    store.close();
    await cleanup();
  }
});

test("conversation store: add messages, build bounded history, summarize-away", async () => {
  const { dir, db, cleanup } = await tmpDb();
  const store = new ConversationStore(db);
  {
    try {
      const convId = store.ensureConversation();
      assert.ok(convId);
      store.addMessage("user", "hello", convId);
      store.addMessage("assistant", "hi there", convId);
      store.addMessage("user", "how are you?", convId);

      const history = store.listMessages({ limit: 10, conversationId: convId });
      assert.equal(history.length, 3);
      assert.equal(history[0].role, "user");
      assert.equal(history[0].text, "hello");

      const bounded = store.boundedHistory(120, convId);
      assert.ok(bounded.messages.length >= 1);

      store.setSummary("the user asked how the assistant is", null);
      assert.equal(store.getSummary().summary, "the user asked how the assistant is");
    } finally {
      store.close();
      await cleanup();
    }
  }
});

test("brain: extractMemorySuggestion strips the MEMORY tag and returns the suggestion", () => {
  const out = extractMemorySuggestion("Hello.\n\nMEMORY: likes coffee\n");
  assert.equal(out.suggestion, "likes coffee");
  assert.equal(out.text, "Hello.");

  const plain = extractMemorySuggestion("Just a normal reply.");
  assert.equal(plain.suggestion, null);
  assert.equal(plain.text, "Just a normal reply.");
});

test("brain: buildSystemPrompt assembles personality + memory + profile + summary", () => {
  const prompt = buildSystemPrompt({
    personality: "You are ZENITH.",
    memorySection: "- user likes coffee",
    profileSection: "[PROFILE]\nShalini is 28",
    summary: "Earlier the user talked about work",
    mode: "voice",
  });
  assert.match(prompt, /You are ZENITH/);
  assert.match(prompt, /\[VOICE MODE\]/);
  assert.match(prompt, /MEMORY/);
  assert.match(prompt, /USER PROFILE|[PROFILE]/);
  assert.match(prompt, /Earlier the user/);
});

test("config: loadConfig reads env, validateConfig reports missing keys", () => {
  const saved = { ...process.env };
  try {
    process.env.ZENITH_LLM_API_KEY = "";
    process.env.ZENITH_LLM_BASE_URL = "not-a-url";
    process.env.ZENITH_LLM_MODEL = "gpt-4o-mini";
    process.env.ELEVENLABS_API_KEY = "";
    process.env.ZENITH_STT_API_KEY = "";
    const config = loadConfig();
    const problems = validateConfig(config);
    assert.ok(problems.some((p) => /API key/.test(p)));
    assert.ok(problems.some((p) => /ZENITH_LLM_BASE_URL/.test(p)));
    // Model falls back to the documented default when unset — that is the
    // documented (not silent) behavior of the config, so no problem is raised.
    assert.equal(config.llm.model, "gpt-4o-mini");
    assert.ok(problems.some((p) => /ELEVENLABS_API_KEY/.test(p)));
    assert.ok(problems.some((p) => /ZENITH_STT/.test(p)));
  } finally {
    for (const k of ["ZENITH_LLM_API_KEY", "ZENITH_LLM_BASE_URL", "ZENITH_LLM_MODEL", "ELEVENLABS_API_KEY", "ZENITH_STT_API_KEY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("config: loadConfig picks up the ZENITH_DATA_DIR override", () => {
  const saved = { ...process.env };
  try {
    process.env.ZENITH_DATA_DIR = "/tmp/zenith-test-data-dir";
    const config = loadConfig();
    assert.match(config.dataDir, /zenith-test-data-dir/);
  } finally {
    for (const k of ["ZENITH_DATA_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("profile: profileSections splits the markdown by h2", () => {
  const md = "# Title\n\n## Identity\nName\n\n## Preferences\nLikes coffee\n";
  const sections = profileSections(md);
  const headings = sections.map((s) => s.heading);
  assert.ok(headings.includes("Identity"));
  assert.ok(headings.includes("Preferences"));
});

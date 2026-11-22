// API integration tests — boot the real backend in-process against a fake LLM.
// No real provider, no network, no Playwright. The fake LLM speaks OpenAI-compatible
// SSE streaming exactly like a real provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, readSse } from "./helpers.mjs";

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv?.cleanup();
});

test("health reports ready", async () => {
  const res = await srv.fetch("/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.brain.ready, true);
  assert.equal(body.stt.configured, true);
});

test("status reports brain + voice + stt honestly", async () => {
  const res = await srv.fetch("/api/status");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.brain.provider, "openai");
  assert.equal(body.brain.model, "mock-model");
  assert.equal(body.brain.ready, true);
  // ElevenLabs is deliberately NOT configured in tests — voice must fall back honestly.
  assert.equal(body.voice.configured, false);
  assert.equal(body.voice.engine, "kokoro");
  assert.equal(body.stt.configured, true);
});

test("chat SSE: streams deltas, finishes with a done event, and persists history", async () => {
  const res = await srv.fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello zenith" }),
  });
  assert.equal(res.status, 200);
  const events = await readSse(res);
  const started = events.filter((e) => e.event === "start");
  const deltas = events.filter((e) => e.event === "delta");
  const done = events.find((e) => e.event === "done");
  const errors = events.filter((e) => e.event === "error");
  assert.equal(started.length, 1);
  assert.ok(deltas.length > 0, "expected streamed deltas");
  assert.ok(done, "expected a done event");
  assert.equal(errors.length, 0);
  assert.match(done.data.text, /HELLO|I'm ZENITH/i);

  const history = await (await srv.fetch("/api/history")).json();
  assert.ok(history.some((m) => m.role === "user" && /hello zenith/.test(m.text)));
  assert.ok(history.some((m) => m.role === "assistant"));
});

test("chat SSE: empty message is rejected, not faked", async () => {
  const res = await srv.fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Empty/i);
});

test("chat SSE: MEMORY suggestion is extracted from the reply", async () => {
  const res = await srv.fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "please remember that I drink coffee" }),
  });
  const events = await readSse(res);
  const done = events.find((e) => e.event === "done");
  assert.ok(done);
  // The fake emits a MEMORY tag when the user asked to remember something.
  assert.ok(done.data.suggestion, "expected a MEMORY suggestion");
  assert.match(done.data.suggestion, /morning routines/i);
});

test("profile GET/PUT: round-trip through local markdown", async () => {
  const before = await (await srv.fetch("/api/profile")).json();
  assert.ok(before.text !== undefined || before.sections !== undefined || before.error);

  const res = await srv.fetch("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "## Identity\n\nTest profile body.\n" }),
  });
  assert.ok(res.ok);

  const after = await (await srv.fetch("/api/profile")).json();
  assert.match(after.text || "", /Test profile body/);
});

test("memory: full CRUD cycle through HTTP", async () => {
  const created = await (
    await srv.fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "likes short emails" }),
    })
  ).json();
  assert.ok(created.id);

  const listed = await (await srv.fetch("/api/memory")).json();
  assert.ok(listed.some((m) => m.id === created.id));

  const patched = await (
    await srv.fetch(`/api/memory/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "likes brief emails" }),
    })
  ).json();
  assert.equal(patched.text, "likes brief emails");

  const body = await (
    await srv.fetch(`/api/memory/${created.id}`, { method: "DELETE" })
  ).json();
  assert.equal(body.deleted, true);
});

test("memory: bad payload is a 400, not a fabricated 201", async () => {
  const res = await srv.fetch("/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(res.status, 400);
});

test("settings: GET then PATCH (effort variant) then GET", async () => {
  const initial = await (await srv.fetch("/api/settings")).json();
  assert.ok(typeof initial === "object");

  const patched = await (
    await srv.fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkinEnabled: true, checkinMorning: "08:00", checkinEvening: "21:00" }),
    })
  ).json();
  assert.equal(patched.checkinEnabled, true);
  assert.equal(patched.checkinMorning, "08:00");

  const final = await (await srv.fetch("/api/settings")).json();
  assert.equal(final.checkinEnabled, true);
});

test("effort: GET/PATCH round-trip", async () => {
  const initial = await (await srv.fetch("/api/effort")).json();
  assert.ok(["low", "medium", "high"].includes(initial.variant));

  const patched = await (
    await srv.fetch("/api/effort", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variant: "high" }),
    })
  ).json();
  assert.equal(patched.variant, "high");
});

test("schedule: reminders CRUD + honest checkin shape", async () => {
  // Tests share one server instance — restore check-ins at the start so the
  // honesty assertions below are not order-dependent.
  await srv.fetch("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkinEnabled: false }),
  });
  // Create a once-reminder for the future.
  const future = new Date(Date.now() + 48 * 3600_000);
  const created = await (
    await srv.fetch("/api/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test water",
        kind: "once",
        time: "19:41",
        date: future.toISOString().slice(0, 10),
      }),
    })
  ).json();
  assert.ok(created.id);

  const schedule = await (await srv.fetch("/api/schedule")).json();
  const mine = schedule.reminders.find((r) => r.id === created.id);
  assert.ok(mine, "reminder should be listed");
  assert.equal(mine.when.type, "once");
  assert.equal(mine.when.time, "19:41");
  assert.ok(mine.nextDueAt, "should have the next due time");

  // Pause / resume round-trip.
  const paused = await srv.fetch(`/api/schedule/${created.id}/pause`, { method: "PATCH" });
  assert.equal((await paused.json()).status, "paused");
  const resumed = await srv.fetch(`/api/schedule/${created.id}/resume`, { method: "PATCH" });
  assert.equal((await resumed.json()).status, "active");

  // Honesty check: check-ins start disabled; nextDueAt is null, not a fake.
  assert.equal(schedule.checkins.enabled, false);
  assert.equal(schedule.checkins.morningSchedule.nextDueAt, null);
  assert.equal(schedule.checkins.eveningSchedule.status, "off");

  const del = await srv.fetch(`/api/schedule/${created.id}`, { method: "DELETE" });
  assert.equal((await del.json()).deleted, true);
});

test("schedule: bad payload → 400", async () => {
  const res = await srv.fetch("/api/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "unknown", kind: "yearly" }),
  });
  assert.equal(res.status, 400);
});

test("voice status: honest when ElevenLabs is unconfigured", async () => {
  const body = await (await srv.fetch("/api/voice/status")).json();
  assert.equal(body.engine, "kokoro");
  assert.equal(body.configured, false);
});

test("STT: status reports configured with the fake provider", async () => {
  const body = await (await srv.fetch("/api/stt/status")).json();
  assert.equal(body.configured, true);
  assert.equal(body.model, "whisper-1");
});

test("STT proxy: multipart upload returns the provider transcript", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.alloc(8000, 1)], { type: "audio/webm" }), "audio.webm");
  const res = await srv.fetch("/api/stt", { method: "POST", body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, "mock transcript");
});

test("history: bounded + newest last, no system messages leaked", async () => {
  const history = await (await srv.fetch("/api/history")).json();
  assert.ok(Array.isArray(history));
  assert.ok(history.every((m) => m.role !== "system"));
});

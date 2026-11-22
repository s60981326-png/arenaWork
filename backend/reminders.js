// Reminders & check-ins — in-process scheduler.
//
// The old version delegated scheduling to OpenCode's schedule API. ZENITH now
// owns its own timers: reminders live in SQLite, tick() runs on a short
// interval, and when one is due the server runs a normal chat turn (which
// persists to the conversation store, where the frontend picks it up and
// speaks it) — reminders work while ZENITH is running and never pretend to
// fire when the app is closed.

import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export const CHECKIN_IDS = { morning: "zenith-checkin-morning", evening: "zenith-checkin-evening" };

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nextOccurrenceDate(time, from = new Date()) {
  // "HH:MM" → next Date-like occurrence of that clock time today or tomorrow.
  const [h, m] = String(time || "08:00").split(":").map((v) => Number(v) || 0);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= from.getTime() + 90_000) next.setDate(next.getDate() + 1);
  return next;
}

export function humanizeWhen(r) {
  if (!r) return "";
  if (r.kind === "once") return `at ${r.date} ${r.time}`;
  if (r.kind === "daily") return `daily at ${r.time}`;
  if (r.kind === "weekly") return `weekdays at ${r.time}`;
  return r.kind || "";
}

export class ReminderScheduler {
  constructor({ dbPath, logger = log }) {
    this.log = logger;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('once', 'daily', 'weekly')),
        time TEXT NOT NULL DEFAULT '08:00',
        date TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        next_due_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reminders_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  list() {
    return this.db
      .prepare("SELECT * FROM reminders WHERE status != 'done' ORDER BY created_at ASC")
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        time: r.time,
        date: r.date,
        status: r.status,
        whenText: humanizeWhen(r),
        nextDueAt: r.next_due_at,
        lastFiredAt: r.last_fired_at,
      }));
  }

  all() {
    return this.db.prepare("SELECT * FROM reminders ORDER BY created_at ASC").all();
  }

  _computeNextDue(kind, time, date, now = new Date()) {
    if (kind === "once") {
      if (!date) return null;
      const d = new Date(`${date}T${time}:00`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (kind === "daily") return nextOccurrenceDate(time, now).toISOString();
    if (kind === "weekly") {
      // Next weekday (Mon–Fri) occurrence.
      const d = nextOccurrenceDate(time, now);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    return null;
  }

  add({ name, kind, time, date }) {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Give the reminder a name.");
    if (!["once", "daily", "weekly"].includes(kind)) throw new Error("Unknown reminder kind.");
    if (kind === "once" && !date) throw new Error("One-off reminders need a date.");
    const now = new Date().toISOString();
    const id = uid("r");
    const nextDue = this._computeNextDue(kind, time, date);
    this.db
      .prepare(
        "INSERT INTO reminders (id, name, kind, time, date, status, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)"
      )
      .run(id, trimmed, kind, time || "08:00", date || null, now, nextDue);
    return { id, name: trimmed, kind, time, date, status: "active", nextDueAt: nextDue };
  }

  update(id, { name, time, date, kind }) {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
    if (!row) return null;
    const next = {
      name: typeof name === "string" && name.trim() ? name.trim() : row.name,
      kind: kind === "once" || kind === "daily" || kind === "weekly" ? kind : row.kind,
      time: typeof time === "string" && time.trim() ? time.trim() : row.time,
      date: typeof date === "string" && date.trim() ? date.trim() : row.date,
    };
    if (next.kind === "once" && !next.date) throw new Error("One-off reminders need a date.");
    const nextDue = this._computeNextDue(next.kind, next.time, next.date);
    this.db
      .prepare("UPDATE reminders SET name = ?, kind = ?, time = ?, date = ?, next_due_at = ? WHERE id = ?")
      .run(next.name, next.kind, next.time, next.date || null, nextDue, id);
    return { id, name: next.name, kind: next.kind, time: next.time, date: next.date, status: row.status, nextDueAt: nextDue };
  }

  setStatus(id, status) {
    const row = this.db.prepare("SELECT id FROM reminders WHERE id = ?").get(id);
    if (!row) return null;
    this.db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(status, id);
    return { id, status };
  }

  delete(id) {
    const res = this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
    return (res.changes ?? 0) > 0;
  }

  // -----------------------------------------------------------------------
  // Firing
  // -----------------------------------------------------------------------

  _metaGet(key) {
    const row = this.db.prepare("SELECT value FROM reminders_meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  _metaSet(key, value) {
    this.db
      .prepare("INSERT INTO reminders_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  /**
   * Find reminders + check-ins due right now. Returns a list of turn prompts.
   * Does NOT run them — the caller (server.js) turns them into a chat turn.
   */
  dueNow({ settings, now = new Date() }) {
    const due = [];
    const nowMs = now.getTime();

    for (const r of this.db.prepare("SELECT * FROM reminders WHERE status = 'active'").all()) {
      if (!r.next_due_at) {
        // Defensive: compute on the fly.
        const nd = this._computeNextDue(r.kind, r.time, r.date, now);
        if (nd) this.db.prepare("UPDATE reminders SET next_due_at = ? WHERE id = ?").run(nd, r.id);
        continue;
      }
      const dueMs = Date.parse(r.next_due_at);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
      due.push({
        kind: "reminder",
        id: r.id,
        prompt: `Reminder: ${r.name}. Say it to me in one short line, then wait — don't start a long conversation.`,
      });
    }

    // Check-ins (settings-driven) — one fire per day per kind.
    const enabled = settings.checkinEnabled === true;
    const morning = settings.checkinMorning || "08:00";
    const evening = settings.checkinEvening || "21:00";
    const todayKey = now.toISOString().slice(0, 10);

    if (enabled) {
      if (dueCheckin(morning, now) && this._metaGet(`checkin:morning:${todayKey}`) !== "done") {
        due.push({
          kind: "checkin",
          id: CHECKIN_IDS.morning,
          prompt:
            "Morning check-in. Do the morning check-in with me now: energy, fixed commitments, top priorities, one meaningful personal practice, and likely obstacles. Wait for my answers — don't write a plan without me.",
        });
      }
      if (dueCheckin(evening, now) && this._metaGet(`checkin:evening:${todayKey}`) !== "done") {
        due.push({
          kind: "checkin",
          id: CHECKIN_IDS.evening,
          prompt:
            "Evening check-in. Do the evening review with me now: what happened, what mattered, what I avoided, what can be learned, and what I should carry into tomorrow. Wait for my answers.",
        });
      }
    }

    return due;

    function dueCheckin(time, nowDate) {
      // Due within the 5 minutes after the clock time (one fire, tracked via the meta table).
      const [h, m] = String(time || "08:00").split(":").map((v) => Number(v) || 0);
      const today = new Date(nowDate);
      today.setHours(h, m, 0, 0);
      const elapsed = nowDate.getTime() - today.getTime();
      return elapsed >= 0 && elapsed < 300_000;
    }
  }

  /** Mark a check-in fired for today (called by the caller after a successful fire). */
  markCheckinFired(kind) {
    const todayKey = new Date().toISOString().slice(0, 10);
    this._metaSet(`checkin:${kind}:${todayKey}`, "done");
  }

  /** After a reminder fires: mark once-kind done, advance others. */
  afterFire(entry) {
    if (entry.kind !== "reminder") return;
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(entry.id);
    if (!row) return;
    const now = new Date().toISOString();
    if (row.kind === "once") {
      this.db
        .prepare("UPDATE reminders SET status = 'done', last_fired_at = ? WHERE id = ?")
        .run(now, row.id);
    } else {
      const nd = this._computeNextDue(row.kind, row.time, row.date, new Date());
      this.db
        .prepare("UPDATE reminders SET last_fired_at = ?, next_due_at = ? WHERE id = ?")
        .run(now, nd, row.id);
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

export async function openReminderScheduler(dbPath, opts = {}) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  return new ReminderScheduler({ dbPath, ...opts });
}

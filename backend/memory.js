// Memory store — SQLite (via node:sqlite, Node >= 22.5).
//
// This is the persistent "what ZENITH knows" layer. Memory is RETRIEVED into
// prompts; it is not model retraining. Every entry is user-visible and
// user-editable, and nothing here leaves the machine except the small,
// relevant snippets that are attached to a single chat request.
//
// If a legacy data/memory.json exists (older ZENITH layout), it is imported
// once on first open so existing memories survive the migration.

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'user-approved fact',
        text TEXT NOT NULL,
        date TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'stated by user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** One-time import of the pre-SQLite JSON memory file, if present. */
  async migrateLegacy(legacyPath) {
    try {
      if (!legacyPath) return;
      const raw = await readFile(legacyPath, "utf8");
      const items = JSON.parse(raw);
      if (!Array.isArray(items) || !items.length) return;
      const already = this.db.prepare("SELECT COUNT(*) AS n FROM memory").get().n;
      if (already > 0) return; // database already has entries — leave it alone
      const insert = this.db.prepare(
        "INSERT INTO memory (id, type, text, date, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const it of items) {
        if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
        const now = new Date().toISOString();
        insert.run(
          typeof it.id === "string" && it.id ? it.id : uid("m"),
          String(it.type || "user-approved fact"),
          it.text.trim(),
          String(it.date || today()),
          String(it.confidence || "stated by user"),
          now,
          now
        );
      }
      log.info(`Imported ${items.length} memories from legacy memory.json`);
    } catch (err) {
      if (err?.code !== "ENOENT") log.warn("Legacy memory import skipped:", err?.message || err);
    }
  }

  list() {
    return this.db
      .prepare("SELECT id, type, text, date, confidence FROM memory ORDER BY updated_at DESC")
      .all()
      .map((r) => ({ id: r.id, type: r.type, text: r.text, date: r.date, confidence: r.confidence }));
  }

  add({ text, type = "user-approved fact", confidence = "stated by user" }) {
    const clean = String(text || "").trim();
    if (!clean) throw new Error("Empty memory text.");
    const id = uid("m");
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO memory (id, type, text, date, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, String(type || "user-approved fact").trim() || "user-approved fact", clean, today(), String(confidence || "stated by user").trim() || "stated by user", now, now);
    return { id, type: String(type || "user-approved fact").trim() || "user-approved fact", text: clean, date: today(), confidence: String(confidence || "stated by user").trim() || "stated by user" };
  }

  update(id, { text, type }) {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id);
    if (!row) return null;
    const nextText = typeof text === "string" ? text.trim() : row.text;
    const nextType = typeof type === "string" ? type.trim() : row.type;
    if (!nextText) throw new Error("Memory text cannot be empty.");
    this.db
      .prepare("UPDATE memory SET text = ?, type = ?, updated_at = ? WHERE id = ?")
      .run(nextText, nextType || row.type, new Date().toISOString(), id);
    return { id: row.id, type: nextType || row.type, text: nextText, date: row.date, confidence: row.confidence };
  }

  remove(id) {
    const res = this.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    return (res.changes ?? 0) > 0;
  }

  /**
   * Retrieve the most relevant memories for a message. Cheap keyword scoring:
   * exact/substring hits plus a recency bonus. This stays small — it's a
   * context aid, not an embedding search.
   */
  relevant(text, { cap = 2600, maxItems = 8 } = {}) {
    const hay = String(text || "").toLowerCase();
    const words = new Set(hay.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
    const items = this.list();
    const scored = items.map((it) => {
      const hayWords = it.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/);
      let score = 0;
      for (const w of words) {
        if (hayWords.includes(w)) score += 3; // meaningful word hits
      }
      if (it.type && hay.includes(String(it.type).toLowerCase().slice(0, 12))) score += 1;
      // Recency bonus: newer memories surface first.
      score += Math.max(0, 10 - Math.floor((Date.now() - Date.parse(it.date)) / (1000 * 60 * 60 * 24 * 30)));
      return { it, score };
    }).filter(({ score }) => score > 0);
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    let total = 0;
    for (const { it } of scored) {
      if (picked.length >= maxItems) break;
      if (total + it.text.length > cap && picked.length) break;
      picked.push(it);
      total += it.text.length;
    }
    return picked;
  }

  /** Regenerate the human-readable memory.md export from the table. */
  async exportMarkdown(mdPath) {
    const items = this.list();
    const lines = items.map(
      (m) => `- [${m.type}] ${m.text} — added ${m.date}` + (m.confidence ? ` (confidence: ${m.confidence})` : "")
    );
    const body =
      "# Memory — what the user has chosen to teach ZENITH\n\n" +
      "This file is generated from the ZENITH database (SQLite). The user can read, edit, export, or delete any entry at any time, from the ZENITH app or by editing it. This is memory retrieval, not model retraining.\n\n" +
      (lines.length ? lines.join("\n") : "(nothing saved yet)");
    await writeFile(mdPath, body, "utf8");
    return body;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Open the store for a data directory (creates the DB and migrates legacy JSON). */
export async function openMemoryStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "zenith.db");
  const legacyJsonPath = path.join(dataDir, "memory.json");
  const store = new MemoryStore(dbPath, { legacyJsonPath });
  await store.migrateLegacy(legacyJsonPath);
  await store.exportMarkdown(path.join(dataDir, "memory.md"));
  return store;
}

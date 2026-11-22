// Conversation store + context assembly.
//
// The full chat history must never go upstream every turn. Instead we keep
// the most recent messages (bounded) and roll everything older into a short
// running summary, so context stays small while remaining useful.
//
// History is persisted in the same zenith.db database as memory — it survives
// restarts, which is the point.

import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ConversationStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'ZENITH',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS conversation_summary (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT NOT NULL DEFAULT '',
        through_message_id TEXT,
        updated_at TEXT
      );
    `);
  }

  ensureConversation() {
    const row = this.db
      .prepare("SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1")
      .get();
    if (row) return row.id;
    const id = uid("c");
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'ZENITH', ?, ?)").run(id, now, now);
    this._setSummary("", null);
    return id;
  }

  touch(conversationId) {
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), conversationId);
  }

  addMessage(role, text, conversationId = null) {
    const convId = conversationId || this.ensureConversation();
    const id = uid("msg");
    const clean = String(text ?? "").trim();
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, convId, role, clean, now);
    this.touch(convId);
    return { id, role, text: clean, at: now };
  }

  listMessages({ limit = 500, conversationId = null } = {}) {
    const convId = conversationId || this.ensureConversation();
    return this.db
      .prepare("SELECT id, role, text, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(convId, limit)
      .reverse()
      .filter((r) => r.role !== "system"); // system messages never appear in the transcript
  }

  /**
   * Pick the messages that fit inside `budgetChars`, newest last.
   * Returns { messages, droppedCount } — droppedCount is informational.
   */
  boundedHistory(budgetChars = 6000, conversationId = null) {
    const msgs = this.listMessages({ limit: 200, conversationId });
    const picked = [];
    let total = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const len = String(msgs[i].text || "").length;
      if (picked.length && total + len > budgetChars) break;
      picked.unshift(msgs[i]);
      total += len;
    }
    return { messages: picked, droppedCount: msgs.length - picked.length };
  }

  getSummary() {
    const row = this.db.prepare("SELECT summary, through_message_id FROM conversation_summary WHERE id = 1").get();
    return { summary: row?.summary || "", throughMessageId: row?.through_message_id || null };
  }

  setSummary(summary, throughMessageId) {
    this._setSummary(String(summary || "").trim(), throughMessageId || null);
  }

  _setSummary(summary, throughMessageId) {
    this.db
      .prepare(
        `INSERT INTO conversation_summary (id, summary, through_message_id, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, through_message_id = excluded.through_message_id, updated_at = excluded.updated_at`
      )
      .run(summary, throughMessageId, new Date().toISOString());
  }

  /** Fresh conversation: new rows in the history store. */
  newConversation() {
    const id = uid("c");
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'ZENITH', ?, ?)").run(id, now, now);
    this._setSummary("", null);
    log.debug("New conversation started:", id);
    return id;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

export async function openConversationStore(dbPath) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  return new ConversationStore(dbPath);
}

// Personal profile — load/save, and the rules for sending only the RELEVANT
// sections with a chat request instead of the whole file.
//
// The profile is a plain, user-owned markdown file (data/profile.md by
// default). It never leaves the machine as a whole; only the sections that
// look relevant to the current message travel with the request.
//
// Selection is dynamic: sections are split on level-2 headings, scored by
// word overlap with the message, and attached only when they clear the bar.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export function profileSections(md) {
  const parts = String(md || "").split(/^## /m);
  const out = [];
  for (const part of parts.slice(1)) {
    const body = "## " + part.trim();
    const heading = part.split("\n")[0].trim();
    out.push({ heading, body });
  }
  return out;
}

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// Space given to profile context in a single prompt. The full file may be
// several thousand characters; a cap keeps prompts (and provider wait time)
// bounded.
const CONTEXT_CAP = 2600;

const CONTEXT_HEADER =
  "[PROFILE CONTEXT — only the sections of the user's editable local profile that look relevant to their " +
  "message. Figures and plans below are snapshots from past conversations: confirm with the user before " +
  "treating them as current facts. Personality notes are provisional; goals are not achievements; options " +
  "are not decisions. Do not invent beyond what is written here.]";

export function profileContextFor(md, text, { cap = CONTEXT_CAP } = {}) {
  const message = String(text || "").toLowerCase();
  const words = new Set(tokens(message));
  const sections = profileSections(md);
  if (!sections.length || !words.size) return "";

  const scored = sections.map((sec) => {
    const sectionWords = new Set(tokens(sec.body));
    let score = 0;
    for (const w of words) if (sectionWords.has(w)) score += 1;
    return { sec, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let total = 0;
  for (const { sec, score } of scored) {
    if (score < 2) continue; // require real topical overlap
    if (total + sec.body.length > cap && picked.length) break;
    picked.push(sec);
    total += sec.body.length;
  }
  if (!picked.length) return "";
  return CONTEXT_HEADER + "\n\n" + picked.map((s) => s.body).join("\n\n");
}

export class ProfileStore {
  constructor(profilePath) {
    this.profilePath = profilePath;
  }

  async load() {
    try {
      return await readFile(this.profilePath, "utf8");
    } catch {
      return "";
    }
  }

  async save(text) {
    const clean = String(text ?? "");
    if (!clean.trim()) throw new Error("Profile cannot be empty.");
    await mkdir(path.dirname(this.profilePath), { recursive: true });
    await writeFile(this.profilePath, clean, "utf8");
    return { saved: true, chars: clean.length };
  }

  async contextForMessage(text, opts) {
    const md = await this.load();
    return profileContextFor(md, text, opts);
  }
}

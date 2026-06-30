#!/usr/bin/env node
// Importer for WhatsApp "Export Chat" archives → folds full chat history (incl. old media)
// into the same local store the live daemon writes to (~/.local/share/wa-cli/).
//
// Usage:
//   node import.mjs <path-to-export> [--me "My Name"] [--jid <jid>] [--mdy]
//
// <path-to-export> may be a `_chat.txt` file or the folder/zip-extract containing it + media.
// --me   : your own display name as it appears in the export (marks those rows from_me=1)
// --jid  : force the conversation jid (else derived from a phone-number sender, or a synthetic label)
// --mdy  : dates are MM/DD/YYYY (US). Default assumes DD/MM/YYYY (European), auto-corrected when a value > 12 disambiguates.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureSchema } from './schema.mjs';

const DATA_DIR = process.env.WA_CLI_DATA || path.join(os.homedir(), '.local', 'share', 'wa-cli');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_PATH = path.join(DATA_DIR, 'messages.db');

const EXT_TYPE = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  mp4: 'video', mov: 'video', '3gp': 'video', mkv: 'video',
  mp3: 'audio', ogg: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio',
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document',
  ppt: 'document', pptx: 'document', zip: 'document', txt: 'document', csv: 'document',
};
export const typeForFile = (f) => EXT_TYPE[(f.split('.').pop() || '').toLowerCase()] || 'document';

// Strip the directional/format marks WhatsApp sprinkles into exports.
export const clean = (s) => (s || '').replace(/[‎‏‪-‮]/g, '').trim();

// Match a line that begins a new message; returns {datePart, timePart, rest} or null.
export function parsePrefix(line) {
  // time separator may be ':' (most locales) or '.' (e.g. Danish): 23.59.51
  let m = line.match(
    /^[‎‏]?\[(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*[APap]?\.?[Mm]?\.?)\]\s*[‎‏]?(.*)$/,
  );
  if (m) return { datePart: m[1], timePart: m[2], rest: m[3] };
  m = line.match(
    /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*[APap]?\.?[Mm]?\.?)\s+-\s+(.*)$/,
  );
  if (m) return { datePart: m[1], timePart: m[2], rest: m[3] };
  return null;
}

export function toUnix(datePart, timePart, mdy) {
  const [a, b, cRaw] = datePart.split(/[./-]/).map((x) => parseInt(x, 10));
  let day, month;
  if (a > 12) { day = a; month = b; }            // unambiguous: first is day
  else if (b > 12) { month = a; day = b; }       // unambiguous: second is day
  else if (mdy) { month = a; day = b; }          // user said US order
  else { day = a; month = b; }                   // default European
  let year = cRaw < 100 ? 2000 + cRaw : cRaw;

  const tm = timePart.match(/(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([APap])?/);
  let hh = parseInt(tm[1], 10);
  const mm = parseInt(tm[2], 10);
  const ss = tm[3] ? parseInt(tm[3], 10) : 0;
  const ap = (tm[4] || '').toLowerCase();
  if (ap === 'p' && hh < 12) hh += 12;
  if (ap === 'a' && hh === 12) hh = 0;
  return Math.floor(new Date(year, month - 1, day, hh, mm, ss).getTime() / 1000);
}

// Detect a media reference inside the message text; return the filename or null.
export function mediaRef(text) {
  let m = text.match(/<attached:\s*([^>]+)>/i);                       // iOS
  if (m) return clean(m[1]);
  m = text.match(/^[‎‏]?(.+?\.\w{2,5})\s*\(file attached\)/i);         // Android (broad: any filename chars)
  if (m) return clean(m[1]);
  return null;
}
export const isOmittedMedia = (t) => /\b(media omitted|image omitted|video omitted|audio omitted|document omitted|sticker omitted|gif omitted)\b/i.test(t);

// Parse an export (folder or _chat.txt) into messages + derived chat identity. No DB writes.
export function parseExport(target, opts = {}) {
  let txtPath, baseDir;
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    baseDir = target;
    const found = fs.readdirSync(target).find((f) => f.endsWith('.txt'));
    if (!found) throw new Error('no .txt file found in ' + target);
    txtPath = path.join(target, found);
  } else {
    txtPath = target;
    baseDir = path.dirname(target);
  }

  const raw = fs.readFileSync(txtPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.replace(/\n$/, '').split('\n');   // drop the file's terminating newline (else it appends '\n' to the last message)

  // assemble messages (handle multi-line bodies)
  let msgs = [];
  let cur = null;
  for (const line of lines) {
    const p = parsePrefix(line);
    if (p) {
      const idx = p.rest.indexOf(': ');
      if (idx < 0) { cur = null; continue; }            // system line (no "sender: text") → skip
      const sender = clean(p.rest.slice(0, idx)).replace(/^~\s*/, '');   // strip WhatsApp's ~ pushname marker
      const text = p.rest.slice(idx + 2);
      cur = { datePart: p.datePart, timePart: p.timePart, sender, text };
      msgs.push(cur);
    } else if (cur) {
      cur.text += '\n' + line;                          // continuation of previous message
    }
  }
  // drop the standard E2E-encryption notice (it's attributed to a sender, so the parser otherwise keeps it)
  msgs = msgs.filter((m) => !/Messages and calls are end-to-end encrypted/i.test(m.text));
  if (msgs.length === 0) throw new Error('parsed 0 messages — unexpected export format; share the first few lines so I can adjust the parser');

  // Derive a chat_jid: explicit > 1:1 phone sender > phone number in the export name > synthetic label.
  const senders = [...new Set(msgs.map((m) => m.sender))];
  const others = senders.filter((s) => s !== opts.me);
  let chatJid = opts.jid;
  if (!chatJid) {
    // A numeric sender only implies a direct chat when there's exactly ONE non-self participant.
    // Multiple participants ⇒ group export → never fold it into one person's DM. (Folder-name number
    // is group-safe: group folders are named by subject, not a trailing phone number.)
    const phoneSender = others.length === 1 && /^\+?[\d\s()-]{7,}$/.test(others[0]) ? others[0] : null;
    // only trust a folder-name phone number for a true 1:1 — a group subject/folder can also end in digits
    const nameNum = others.length === 1 ? path.basename(baseDir).match(/(\+?\d[\d\s()-]{6,}\d)\s*$/) : null;
    if (phoneSender) chatJid = phoneSender.replace(/[^\d]/g, '') + '@s.whatsapp.net';
    else if (nameNum) chatJid = nameNum[1].replace(/[^\d]/g, '') + '@s.whatsapp.net';
    // synthetic label from the EXPORT FOLDER name (distinctive), not "_chat.txt" (which collides across exports)
    else chatJid = 'import:' + path.basename(baseDir).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }
  const otherName = others[0] || senders[0];

  return { msgs, senders, chatJid, otherName, baseDir, txtPath };
}

export function runImport(target, opts = {}) {
  const { msgs, senders, chatJid, otherName, baseDir } = parseExport(target, opts);

  const dataDir = opts.dataDir || DATA_DIR;        // overridable so tests can use an isolated temp dir
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });     // ensure the media folder exists (fresh install before daemon ran)
  const db = new DatabaseSync(path.join(dataDir, 'messages.db'));
  ensureSchema(db);                                // create tables if this is a fresh DB (importer can run standalone)

  // Phase 1 — build rows + copy media to disk OUTSIDE any DB lock. Media I/O is slow; holding the write
  // lock across it would block (and drop) the daemon's live inserts. Writes are atomic (temp + rename);
  // a later rollback just leaves harmless orphan files.
  const counter = new Map();
  const rows = [];
  let mediaCopied = 0, mediaMissing = 0;
  for (const m of msgs) {
    const ts = toUnix(m.datePart, m.timePart, opts.mdy);
    const fromMe = opts.me && m.sender === opts.me ? 1 : 0;
    let type = 'text', text = m.text, mediaPath = null;
    // occurrence counter → identical text from the same sender in the same minute still gets a distinct id
    const base = `${chatJid}|${ts}|${fromMe}|${m.sender}|${m.text}`;
    const occ = (counter.get(base) ?? -1) + 1;
    counter.set(base, occ);
    const id = 'imp_' + crypto.createHash('sha1').update(`${base}|${occ}`).digest('hex').slice(0, 22);

    const ref = mediaRef(m.text);
    if (ref) {
      type = typeForFile(ref);
      text = clean(m.text.replace(/<attached:[^>]+>/i, '').replace(/.+?\.\w{2,5}\s*\(file attached\)/i, ''));
      const safeName = path.basename(ref);                 // strip path components → no traversal
      const src = path.join(baseDir, safeName);
      if (fs.existsSync(src)) {
        const dest = `${id}_${safeName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;   // id-prefixed → collision-proof
        const full = path.join(mediaDir, dest);
        fs.copyFileSync(src, full + '.tmp');
        fs.renameSync(full + '.tmp', full);                // atomic publish
        mediaPath = path.join('media', dest);
        mediaCopied++;
      } else {
        mediaMissing++;
      }
    } else if (isOmittedMedia(m.text)) {
      type = 'media-omitted';
    }
    rows.push([id, chatJid, fromMe ? 'me' : chatJid, fromMe, m.sender, ts, type, clean(text), mediaPath]);
  }

  // Phase 2 — short DB-only transaction (delete + inserts). No file I/O inside → the write lock is brief,
  // so a large import can't starve the daemon's live writes.
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, from_me, push_name, timestamp, type, text, media_path) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const upsertC = db.prepare(
    `INSERT INTO contacts (jid, name, updated_at) VALUES (?,?,?) ON CONFLICT(jid) DO UPDATE SET name=excluded.name`,
  );
  const BATCH = 2000;
  let removed = 0, inserted = 0;
  // Commit in batches so a very large import can't hold the write lock long enough to starve the daemon's
  // live inserts. Small imports (≤ one batch) stay a single atomic transaction.
  for (let i = 0; i < Math.max(rows.length, 1); i += BATCH) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (i === 0) {
        if (opts.replace) removed = db.prepare("DELETE FROM messages WHERE chat_jid = ? AND id LIKE 'imp\\_%' ESCAPE '\\'").run(chatJid).changes;
        upsertC.run(chatJid, otherName, rows[0]?.[5] ?? Math.floor(Date.now() / 1000));
      }
      for (const r of rows.slice(i, i + BATCH)) inserted += ins.run(...r).changes;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return { chatJid, otherName, total: msgs.length, inserted, removed, mediaCopied, mediaMissing, senders };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (!target) {
    console.error('usage: node import.mjs <path-to-export> [--me "My Name"] [--jid <jid>] [--mdy]');
    process.exit(1);
  }
  const res = runImport(target, { me: get('--me'), jid: get('--jid'), mdy: args.includes('--mdy'), replace: args.includes('--replace') });
  console.log(`imported "${res.otherName}" → ${res.chatJid}`);
  console.log(`  messages parsed : ${res.total}`);
  console.log(`  rows inserted   : ${res.inserted}  (duplicates skipped: ${res.total - res.inserted})`);
  console.log(`  media copied    : ${res.mediaCopied}${res.mediaMissing ? `  (missing files: ${res.mediaMissing} — export was likely "without media")` : ''}`);
  console.log(`  senders seen    : ${res.senders.join(' | ')}`);
}

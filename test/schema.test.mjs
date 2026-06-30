import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../schema.mjs';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-schema-'));
  return new DatabaseSync(path.join(dir, 'messages.db'));
}

test('ensureSchema creates all tables', () => {
  const db = freshDb();
  ensureSchema(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  for (const t of ['messages', 'contacts', 'meta', 'sent_log']) assert.ok(names.includes(t), `missing table ${t}`);
});

test('ensureSchema is idempotent (safe to run twice)', () => {
  const db = freshDb();
  ensureSchema(db);
  ensureSchema(db); // must not throw
  db.prepare("INSERT INTO messages (id, chat_jid, from_me, timestamp, type, text) VALUES ('x', 'c', 0, 1, 'text', 'hi')").run();
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 1);
});

test('ensureSchema enables WAL', () => {
  const db = freshDb();
  ensureSchema(db);
  assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
});

test('messages.id is the primary key (INSERT OR IGNORE dedups)', () => {
  const db = freshDb();
  ensureSchema(db);
  const ins = db.prepare("INSERT OR IGNORE INTO messages (id, chat_jid, from_me, timestamp, type, text) VALUES (?,?,?,?,?,?)");
  ins.run('dup', 'c', 0, 1, 'text', 'a');
  ins.run('dup', 'c', 0, 1, 'text', 'b'); // ignored
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 1);
});

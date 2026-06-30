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

test('ensureSchema: messages has a status column', () => {
  const db = freshDb();
  ensureSchema(db);
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  assert.ok(cols.includes('status'));
});

test('ensureSchema migrates a pre-status DB (adds status, keeps rows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mig-'));
  const db = new DatabaseSync(path.join(dir, 'messages.db'));
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, from_me INTEGER, timestamp INTEGER, type TEXT, text TEXT)');
  db.prepare("INSERT INTO messages (id,chat_jid,from_me,timestamp,type,text) VALUES ('x','c',1,1,'text','hi')").run();
  ensureSchema(db); // must ALTER-add status without dropping the row
  assert.ok(db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'status'));
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 1);
});

test('messages.id is the primary key (INSERT OR IGNORE dedups)', () => {
  const db = freshDb();
  ensureSchema(db);
  const ins = db.prepare("INSERT OR IGNORE INTO messages (id, chat_jid, from_me, timestamp, type, text) VALUES (?,?,?,?,?,?)");
  ins.run('dup', 'c', 0, 1, 'text', 'a');
  ins.run('dup', 'c', 0, 1, 'text', 'b'); // ignored
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../schema.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

// Build a fixture archive the read-side CLI commands can query (no daemon needed for reads).
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-'));
  const db = new DatabaseSync(path.join(dir, 'messages.db'));
  ensureSchema(db);
  const m = db.prepare('INSERT INTO messages (id,chat_jid,sender_jid,from_me,push_name,timestamp,type,text,media_path) VALUES (?,?,?,?,?,?,?,?,?)');
  db.prepare('INSERT INTO contacts (jid,name,updated_at) VALUES (?,?,?)').run('8610000000003@s.whatsapp.net', 'Sample Supplier', 1);
  m.run('a|0|1', '8610000000003@s.whatsapp.net', '8610000000003@s.whatsapp.net', 0, 'Sample Supplier', 1700000000, 'text', 'do you like the kiosk?', null);
  m.run('a|1|2', '8610000000003@s.whatsapp.net', 'me', 1, null, 1700000060, 'text', 'yes please quote it', null);
  m.run('a|0|3', '8610000000003@s.whatsapp.net', '8610000000003@s.whatsapp.net', 0, 'Sample Supplier', 1700000120, 'document', 'spec sheet', 'media/x.pdf');
  db.prepare("INSERT INTO meta (key,value) VALUES ('self_jid','1234567890@s.whatsapp.net')").run();
  m.run('s|1|1', '1234567890@s.whatsapp.net', 'me', 1, null, 1700001000, 'text', 'note to self', null);
  db.close();
  return dir;
}

function wa(args, dir) {
  return execFileSync('node', [path.join(REPO, 'wa.mjs'), ...args], {
    env: { ...process.env, WA_CLI_DATA: dir },
    encoding: 'utf8',
  });
}

const dir = fixture();

test('wa (no args) prints help', () => {
  assert.match(wa([], dir), /WhatsApp from the terminal/);
});

test('wa chats lists conversations by name', () => {
  assert.match(wa(['chats'], dir), /Sample Supplier/);
});

test('wa read <name> resolves and renders messages + You:', () => {
  const out = wa(['read', 'sample'], dir);
  assert.match(out, /quote it/);
  assert.match(out, /You:/);
});

test('wa read me uses self_jid', () => {
  assert.match(wa(['read', 'me'], dir), /note to self/);
});

test('wa search finds across chats', () => {
  assert.match(wa(['search', 'kiosk'], dir), /kiosk/);
});

test('wa media lists saved media paths', () => {
  assert.match(wa(['media'], dir), /x\.pdf/);
});

test('wa read <unknown> exits non-zero', () => {
  assert.throws(() => wa(['read', 'zzzznotacontact'], dir));
});

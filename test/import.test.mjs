import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parsePrefix, toUnix, mediaRef, clean, typeForFile, isOmittedMedia, parseExport, runImport,
} from '../import.mjs';

// ---------- unit: line/date/media parsing ----------

test('parsePrefix: iOS brackets + Danish dot-time', () => {
  const p = parsePrefix('[29/06/2026, 23.59.51] Alex: hello');
  assert.equal(p.datePart, '29/06/2026');
  assert.equal(p.timePart, '23.59.51');
  assert.equal(p.rest, 'Alex: hello');
});

test('parsePrefix: Android dash separator + colon-time', () => {
  const p = parsePrefix('12/06/2026, 14:05 - +86 138: hi');
  assert.equal(p.rest, '+86 138: hi');
});

test('parsePrefix: continuation/system line → null', () => {
  assert.equal(parsePrefix('just a wrapped continuation line'), null);
});

test('toUnix: default European DD/MM', () => {
  const d = new Date(toUnix('29/06/2026', '12:00:00') * 1000);
  assert.equal(d.getDate(), 29);
  assert.equal(d.getMonth(), 5); // June
});

test('toUnix: auto-disambiguates when first field > 12 (is the day)', () => {
  const d = new Date(toUnix('13/02/2026', '00:00') * 1000);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getMonth(), 1); // Feb
});

test('toUnix: --mdy flag flips to US order', () => {
  const d = new Date(toUnix('02/13/2026', '00:00', true) * 1000);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getMonth(), 1);
});

test('toUnix: dot time separator + 2-digit year', () => {
  const d = new Date(toUnix('01/01/26', '23.59.30') * 1000);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('toUnix: 12-hour PM/AM', () => {
  assert.equal(new Date(toUnix('01/01/2026', '1:05 PM') * 1000).getHours(), 13);
  assert.equal(new Date(toUnix('01/01/2026', '12:00 AM') * 1000).getHours(), 0);
});

test('mediaRef: iOS <attached:> (with direction mark)', () => {
  assert.equal(mediaRef('‎<attached: 00000042-SPEC.pdf>'), '00000042-SPEC.pdf');
});

test('mediaRef: Android "(file attached)" incl. spaces in name', () => {
  assert.equal(mediaRef('My Spec Sheet.pdf (file attached)'), 'My Spec Sheet.pdf');
});

test('mediaRef: plain text → null', () => {
  assert.equal(mediaRef('how are you?'), null);
});

test('typeForFile maps extensions', () => {
  assert.equal(typeForFile('a.pdf'), 'document');
  assert.equal(typeForFile('b.JPG'), 'image');
  assert.equal(typeForFile('c.mp4'), 'video');
  assert.equal(typeForFile('d.xyz'), 'document'); // unknown → document
});

test('isOmittedMedia detects the omitted markers', () => {
  assert.ok(isOmittedMedia('<Media omitted>'));
  assert.ok(isOmittedMedia('image omitted'));
  assert.equal(isOmittedMedia('a normal sentence'), false);
});

test('clean strips LTR/RTL marks and trims', () => {
  assert.equal(clean('‎hello‏ '), 'hello');
});

// ---------- integration: parseExport / runImport ----------

function makeExport(name, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exp-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_chat.txt'), lines.join('\n') + '\n');
  return dir;
}
function freshData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-data-'));
}
function openDb(dataDir) {
  return new DatabaseSync(path.join(dataDir, 'messages.db'), { readOnly: true });
}

test('parseExport: 1:1 export → direct jid from folder number', () => {
  const dir = makeExport('WhatsApp Chat - +86 100 0000 0001', [
    '[29/06/2026, 23.53.50] Alex: hi',
    '[29/06/2026, 23.55.00] ~supplier: hello',
  ]);
  const { chatJid, otherName } = parseExport(dir, { me: 'Alex' });
  assert.equal(chatJid, '8610000000001@s.whatsapp.net');
  assert.equal(otherName, 'supplier'); // ~ stripped
});

test('parseExport: group export (multiple senders) → synthetic jid, never folded into a person', () => {
  const dir = makeExport('WhatsApp Chat - Quote Group', [
    '[01/06/2026, 10:00:00] Alex: team?',
    '[01/06/2026, 10:01:00] +86 111 1111: A',
    '[01/06/2026, 10:02:00] +86 222 2222: B',
  ]);
  const { chatJid } = parseExport(dir, { me: 'Alex' });
  assert.ok(chatJid.startsWith('import:'), `expected synthetic, got ${chatJid}`);
  assert.ok(!chatJid.includes('@s.whatsapp.net'));
});

test('parseExport: drops the E2E-encryption system notice', () => {
  const dir = makeExport('WhatsApp Chat - +1 222 333 4444', [
    '[01/06/2026, 10:00:00] ~x: Messages and calls are end-to-end encrypted. No one outside can read them.',
    '[01/06/2026, 10:01:00] ~x: real message',
  ]);
  const { msgs } = parseExport(dir, { me: 'Alex' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'real message');
});

test('parseExport: multi-line message body is joined', () => {
  const dir = makeExport('WhatsApp Chat - +1 222 333 4444', [
    '[01/06/2026, 10:00:00] Alex: line one',
    'line two',
    '[01/06/2026, 10:01:00] Alex: next',
  ]);
  const { msgs } = parseExport(dir, { me: 'Alex' });
  assert.equal(msgs[0].text, 'line one\nline two');
  assert.equal(msgs.length, 2);
});

test('runImport: inserts rows, marks from_me, copies media', () => {
  const dataDir = freshData();
  const dir = makeExport('WhatsApp Chat - +86 100 0000 0002', [
    '[12/06/2026, 14:03:05] Alex: send the spec?',
    '[12/06/2026, 14:05:30] +86 100 0000 0002: ‎<attached: SPEC.pdf>',
    '[12/06/2026, 14:06:00] +86 100 0000 0002: here',
  ]);
  fs.writeFileSync(path.join(dir, 'SPEC.pdf'), '%PDF fake');
  const res = runImport(dir, { me: 'Alex', dataDir });
  assert.equal(res.inserted, 3);
  assert.equal(res.mediaCopied, 1);
  assert.equal(res.chatJid, '8610000000002@s.whatsapp.net');

  const db = openDb(dataDir);
  const rows = db.prepare('SELECT from_me, type, text, media_path FROM messages ORDER BY timestamp').all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].from_me, 1);                 // Alex
  assert.equal(rows[1].from_me, 0);                 // supplier
  assert.equal(rows[1].type, 'document');
  assert.ok(rows[1].media_path && rows[1].media_path.startsWith('media/imp_'));
  // the copied file exists on disk
  assert.ok(fs.existsSync(path.join(dataDir, rows[1].media_path)));
});

test('runImport: two identical same-minute messages are BOTH kept (no id collapse)', () => {
  const dataDir = freshData();
  const dir = makeExport('WhatsApp Chat - +86 100 0000 0002', [
    '12/06/2026, 10:42 - +86 100 0000 0002: OK',
    '12/06/2026, 10:42 - +86 100 0000 0002: OK',
  ]);
  const res = runImport(dir, { me: 'Alex', dataDir });
  assert.equal(res.inserted, 2);
  const db = openDb(dataDir);
  assert.equal(db.prepare("SELECT count(*) c FROM messages WHERE text='OK'").get().c, 2);
});

test('runImport: idempotent re-import (no --replace) inserts nothing new', () => {
  const dataDir = freshData();
  const dir = makeExport('WhatsApp Chat - +86 100 0000 0002', [
    '[12/06/2026, 14:03:05] Alex: hello',
  ]);
  assert.equal(runImport(dir, { me: 'Alex', dataDir }).inserted, 1);
  assert.equal(runImport(dir, { me: 'Alex', dataDir }).inserted, 0); // dedup by deterministic id
});

test('runImport: --replace clears the prior import of that chat', () => {
  const dataDir = freshData();
  const dir = makeExport('WhatsApp Chat - +86 100 0000 0002', [
    '[12/06/2026, 14:03:05] Alex: v1',
    '[12/06/2026, 14:04:05] Alex: v2',
  ]);
  runImport(dir, { me: 'Alex', dataDir });
  const res = runImport(dir, { me: 'Alex', dataDir, replace: true });
  assert.equal(res.removed, 2);
  assert.equal(res.inserted, 2);
  const db = openDb(dataDir);
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 2);
});

test('runImport: path-traversal attachment name is neutralised (basename only)', () => {
  const dataDir = freshData();
  const dir = makeExport('WhatsApp Chat - +1 999 999 9999', [
    '[12/06/2026, 14:03:05] ~x: ‎<attached: ../../escape.pdf>',
  ]);
  // a file literally named "escape.pdf" sits in the export dir; the traversal target must NOT be read
  fs.writeFileSync(path.join(dir, 'escape.pdf'), 'inside');
  const res = runImport(dir, { me: 'Alex', dataDir });
  // basename('../../escape.pdf') === 'escape.pdf' which exists in the export dir → copied from inside only
  assert.equal(res.mediaCopied, 1);
  const db = openDb(dataDir);
  const mp = db.prepare('SELECT media_path FROM messages WHERE media_path IS NOT NULL').get().media_path;
  assert.ok(mp.startsWith('media/imp_') && !mp.includes('..'));
});

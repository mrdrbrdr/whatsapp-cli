#!/usr/bin/env node
// wa — thin client for the whatsapp-cli daemon.
//   wa chats [n]            list recent conversations (default 20)
//   wa read <who> [n]       print last n messages of a conversation (default 30)
//   wa send <who> <text>    send a message via the live daemon connection
//   wa media [who] [n]      list saved received-media files (default 20)
//   wa tail [who]           follow new messages live (Ctrl-C to stop)
//   wa status               daemon connection status
//
// <who> = "me" | a phone number (e.g. 1234567890) | part of a saved contact/group name | a jid

import { DatabaseSync } from 'node:sqlite';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = process.env.WA_CLI_DATA || path.join(os.homedir(), '.local', 'share', 'wa-cli');
const DB_PATH = path.join(DATA_DIR, 'messages.db');
const PORT = Number(process.env.WA_CLI_PORT || 3737);

function openDb() {
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    console.error('No archive yet at', DB_PATH, '— start the daemon first (see README).');
    process.exit(1);
  }
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nameForJid(db, jid) {
  if (!jid) return '?';
  const row = db.prepare('SELECT name FROM contacts WHERE jid=?').get(jid);
  if (row?.name) return row.name;
  if (jid.endsWith('@g.us')) return jid.replace('@g.us', ' (group)');
  return '+' + jid.replace(/@.*/, '');
}

const looksLikePhone = (s) => /^[+0-9 ()-]{5,}$/.test(s || '');

function selfJid(db) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key='self_jid'").get()?.value || null;
  } catch {
    return null;
  }
}

// Resolve <who> to a chat_jid. Names may match several jids → returns array of candidates.
function resolveChats(db, who) {
  if (!who) return [];
  if (who === 'me') {
    const j = selfJid(db);
    return j ? [j] : [];
  }
  if (who.includes('@')) return [who];
  if (looksLikePhone(who)) return [`${who.replace(/[^0-9]/g, '')}@s.whatsapp.net`];
  // name search across contacts + observed push names
  const like = `%${who}%`;
  const rows = db
    .prepare(
      `SELECT DISTINCT jid FROM (
         SELECT jid, name FROM contacts WHERE name LIKE ?
         UNION
         SELECT chat_jid AS jid, push_name AS name FROM messages WHERE push_name LIKE ?
       ) WHERE jid IS NOT NULL`,
    )
    .all(like, like);
  return rows.map((r) => r.jid);
}

function pickOneChat(db, who, { allowNone } = {}) {
  const cands = resolveChats(db, who);
  if (cands.length === 0) {
    if (allowNone) return null;
    console.error(`No conversation matches "${who}". Try \`wa chats\` to see names, or use a phone number.`);
    process.exit(1);
  }
  if (cands.length > 1) {
    console.error(`"${who}" matches several conversations — be more specific:`);
    for (const j of cands) console.error('  -', nameForJid(db, j), `(${j})`);
    process.exit(1);
  }
  return cands[0];
}

function renderRow(db, r, { showChat } = {}) {
  const when = fmtTime(r.timestamp);
  let who;
  if (r.from_me) who = 'You';
  else if (r.chat_jid.endsWith('@g.us')) who = r.push_name || nameForJid(db, r.sender_jid);
  else who = r.push_name || nameForJid(db, r.chat_jid);
  const media = r.media_path
    ? ` [${r.type} saved: ${r.media_path}]`
    : r.type !== 'text' && r.type !== 'reaction' ? ` [${r.type}]` : '';
  const prefix = showChat ? `${nameForJid(db, r.chat_jid)} | ` : '';
  return `${when}  ${prefix}${who}: ${r.text || ''}${media}`;
}

async function api(method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) {
    console.error('Cannot reach the daemon on port ' + PORT + '. Is the wa-cli service running?');
    process.exit(1);
  }
  return res.json();
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'chats': {
    const db = openDb();
    const n = Number(rest[0]) || 20;
    const rows = db
      .prepare(
        `SELECT chat_jid, MAX(timestamp) AS last_ts FROM messages
         GROUP BY chat_jid ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(n);
    for (const r of rows) {
      const last = db
        .prepare('SELECT text, type, from_me FROM messages WHERE chat_jid=? ORDER BY timestamp DESC, rowid DESC LIMIT 1')
        .get(r.chat_jid);
      const snippet = (last?.from_me ? 'You: ' : '') + (last?.text || `[${last?.type || ''}]`);
      console.log(`${fmtTime(r.last_ts)}  ${nameForJid(db, r.chat_jid).padEnd(24)}  ${snippet.slice(0, 60)}`);
    }
    break;
  }
  case 'read': {
    const db = openDb();
    const who = rest[0];
    const n = Number(rest[1]) || 30;
    const jid = pickOneChat(db, who);
    const rows = db
      .prepare('SELECT * FROM messages WHERE chat_jid=? ORDER BY timestamp DESC, rowid DESC LIMIT ?')
      .all(jid, n)
      .reverse();
    console.log(`# ${nameForJid(db, jid)}  (${jid})  — last ${rows.length} messages\n`);
    for (const r of rows) console.log(renderRow(db, r));
    break;
  }
  case 'media': {
    const db = openDb();
    const who = rest[0];
    const n = Number(rest[1]) || 20;
    const jid = who ? pickOneChat(db, who, { allowNone: true }) : null;
    const rows = jid
      ? db.prepare('SELECT * FROM messages WHERE media_path IS NOT NULL AND chat_jid=? ORDER BY timestamp DESC, rowid DESC LIMIT ?').all(jid, n)
      : db.prepare('SELECT * FROM messages WHERE media_path IS NOT NULL ORDER BY timestamp DESC, rowid DESC LIMIT ?').all(n);
    for (const r of rows) {
      console.log(`${fmtTime(r.timestamp)}  ${nameForJid(db, r.chat_jid).padEnd(20)}  ${r.type.padEnd(9)} ${path.join(DATA_DIR, r.media_path)}`);
    }
    if (rows.length === 0) console.log('(no received media saved yet)');
    break;
  }
  case 'send': {
    const gv = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const idem = gv('--key');   // optional idempotency key: retrying with the same key won't resend
    const pos = rest.filter((a, i) => a !== '--key' && rest[i - 1] !== '--key');
    const who = pos[0];
    const text = pos.slice(1).join(' ');
    if (!who || !text) {
      console.error('usage: wa send <who> <message> [--key <idempotency-key>]');
      process.exit(1);
    }
    // resolve a name to a jid locally so we can show who it's going to
    let to = who;
    if (who !== 'me' && !who.includes('@') && !looksLikePhone(who)) {
      const db = openDb();
      to = pickOneChat(db, who);
      console.error(`→ ${nameForJid(db, to)} (${to})`);
    }
    const out = await api('POST', '/send', { to, message: text, key: idem });
    if (out.ok) console.log('sent ✓', out.jid, out.id);
    else {
      console.error('send failed:', out.error);
      process.exit(1);
    }
    break;
  }
  case 'tail': {
    const db = openDb();
    const who = rest[0];
    const jid = who ? pickOneChat(db, who, { allowNone: true }) : null;
    // cursor by rowid (monotonic insertion order) — same-second messages are never missed or reordered
    let lastRow = db.prepare('SELECT MAX(rowid) AS r FROM messages').get().r || 0;
    const sinceTs = Math.floor(Date.now() / 1000) - 120;   // only genuinely-new messages, not backfilled imports
    console.log('Following new messages… (Ctrl-C to stop)\n');
    const poll = () => {
      const rows = jid
        ? db.prepare('SELECT rowid AS _rid, * FROM messages WHERE rowid > ? AND timestamp >= ? AND chat_jid=? ORDER BY rowid').all(lastRow, sinceTs, jid)
        : db.prepare('SELECT rowid AS _rid, * FROM messages WHERE rowid > ? AND timestamp >= ? ORDER BY rowid').all(lastRow, sinceTs);
      for (const r of rows) {
        console.log(renderRow(db, r, { showChat: !jid }));
        if (r._rid > lastRow) lastRow = r._rid;
      }
    };
    setInterval(poll, 1500);
    break;
  }
  case 'status': {
    const out = await api('GET', '/status');
    console.log(out.connected ? `connected as ${out.user}` : 'not connected');
    break;
  }
  case 'doctor': {
    const db = openDb();
    const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch (e) { return (e.stdout || '').toString().trim() || 'unknown'; } };
    const svc = sh('systemctl --user is-active wa-cli.service');
    const timer = sh('systemctl --user is-active wa-cli-backup.timer');
    let st = { connected: false };
    try { st = await api('GET', '/status'); } catch {}
    const last = db.prepare('SELECT max(timestamp) t FROM messages').get().t;
    const m = db.prepare('SELECT count(*) c FROM messages').get().c;
    const ch = db.prepare('SELECT count(DISTINCT chat_jid) c FROM messages').get().c;
    const md = db.prepare('SELECT count(*) c FROM messages WHERE media_path IS NOT NULL').get().c;
    let lastBackup = 'none';
    try {
      const bf = fs.readdirSync(path.join(DATA_DIR + '-backups', 'db')).filter((f) => f.endsWith('.db')).sort();
      if (bf.length) lastBackup = bf.at(-1);
    } catch {}
    let disk = '?';
    try { disk = execFileSync('du', ['-sh', DATA_DIR], { encoding: 'utf8' }).split(/\s+/)[0]; } catch {}
    const ok = (b) => (b ? '✓' : '✗');
    console.log('wa-cli health');
    console.log(`  ${ok(svc === 'active')} service      ${svc}`);
    console.log(`  ${ok(st.connected)} connection   ${st.connected ? st.user : 'NOT CONNECTED — re-link needed'}`);
    console.log(`  ${ok(m > 0)} archive      ${m} msgs · ${ch} chats · ${md} media`);
    console.log(`  ${ok(last)} last message ${last ? new Date(last * 1000).toLocaleString() : '—'}`);
    console.log(`  ${ok(timer === 'active')} backups      timer ${timer}, latest ${lastBackup}`);
    console.log(`    data size    ${disk}`);
    if (!st.connected) console.log('\n  ⚠ re-link: cd ~/sw/utilities/whatsapp-cli && node daemon.mjs (scan QR), then systemctl --user restart wa-cli.service');
    break;
  }
  case 'search': {
    const db = openDb();
    const n = Number(rest.find((a) => /^\d+$/.test(a))) || 25;
    const term = rest.filter((a) => !/^\d+$/.test(a)).join(' ');
    if (!term) { console.error('usage: wa search <term> [n]'); process.exit(1); }
    const rows = db
      .prepare(`SELECT chat_jid, from_me, text, timestamp FROM messages WHERE text LIKE ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`)
      .all('%' + term + '%', n)
      .reverse();
    for (const r of rows)
      console.log(`${fmtTime(r.timestamp)}  ${nameForJid(db, r.chat_jid).slice(0, 20).padEnd(20)} ${r.from_me ? 'You: ' : ''}${(r.text || '').replace(/\n/g, ' ').slice(0, 70)}`);
    console.log(rows.length ? `\n(${rows.length} matches for "${term}")` : `no matches for "${term}"`);
    break;
  }
  case 'import': {
    const target = rest.find((a) => !a.startsWith('--'));
    const gv = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    if (!target) {
      console.error('usage: wa import <path-to-export> [--me "My Name"] [--jid <jid>] [--mdy]');
      process.exit(1);
    }
    const { runImport } = await import('./import.mjs');
    const res = runImport(target, { me: gv('--me'), jid: gv('--jid'), mdy: rest.includes('--mdy'), replace: rest.includes('--replace') });
    console.log(`imported "${res.otherName}" → ${res.chatJid}`);
    console.log(`  ${res.inserted} new rows (of ${res.total} parsed), ${res.mediaCopied} files copied${res.mediaMissing ? `, ${res.mediaMissing} media missing (export was "without media")` : ''}`);
    console.log(`  senders: ${res.senders.join(' | ')}`);
    break;
  }
  default:
    console.log(`wa — WhatsApp from the terminal

  wa chats [n]            list recent conversations (default 20)
  wa read <who> [n]       show last n messages of a conversation (default 30)
  wa send <who> <text>    send a message (add --key <id> for idempotent retries)
  wa search <term> [n]    find messages containing <term> across all chats
  wa media [who] [n]      list saved received-media files
  wa tail [who]           follow new messages live
  wa status               daemon connection status
  wa doctor               full health check (service, connection, archive, backups)
  wa import <path> …      ingest a WhatsApp "Export Chat" (full past history + files)

  <who> = me | phone number | part of a contact/group name | jid`);
}

#!/usr/bin/env node
// whatsapp-cli daemon — always-on Baileys connection.
//
// Responsibilities:
//   1. Hold a single linked-device WhatsApp connection (its own auth, separate from mudslide).
//   2. Archive ALL messages (sent + received) to a local SQLite DB → readable conversation history.
//   3. Download RECEIVED media (image/video/audio/document/sticker) to a local folder.
//   4. Expose a tiny localhost HTTP API so the `wa` CLI can send messages through the live socket.
//
// Strictly local: binds to 127.0.0.1, writes only under DATA_DIR, transmits nothing externally.

import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { ensureSchema } from './schema.mjs';
import { SKIP_TYPES, unwrap, extract, pickExt, splitMessage } from './messages.mjs';

// ---------- paths & config ----------
const DATA_DIR = process.env.WA_CLI_DATA || path.join(os.homedir(), '.local', 'share', 'wa-cli');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_PATH = path.join(DATA_DIR, 'messages.db');
const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; };  // reject NaN/<=0 env values
const PORT = num(process.env.WA_CLI_PORT, 3737);

for (const d of [DATA_DIR, AUTH_DIR, MEDIA_DIR]) fs.mkdirSync(d, { recursive: true });

const logger = pino({ level: process.env.WA_CLI_LOG || 'silent' });
function info(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
ensureSchema(db);
// One-time, idempotent migration: chat-scope legacy live-message ids so a re-delivered message
// dedups against its existing row (matches storeMessage's id scheme). Leaves imported (imp_*) ids alone.
db.exec("UPDATE messages SET id = chat_jid || '|' || from_me || '|' || id WHERE id NOT LIKE '%|%' AND id NOT LIKE 'imp\\_%' ESCAPE '\\'");
const setMeta = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
);

const insertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, chat_jid, sender_jid, from_me, push_name, timestamp, type, text, media_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertContact = db.prepare(`
  INSERT INTO contacts (jid, name, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
  WHERE excluded.name IS NOT NULL AND excluded.name != ''
`);
const setMediaPath = db.prepare('UPDATE messages SET media_path=? WHERE id=?');
const getMediaPath = db.prepare('SELECT media_path FROM messages WHERE id=?');
const logSend = db.prepare('INSERT INTO sent_log (ts) VALUES (?)');
const pruneSends = db.prepare('DELETE FROM sent_log WHERE ts < ?');
const countSends = db.prepare('SELECT count(*) AS c FROM sent_log WHERE ts >= ?');

let sock = null;
let reconnectTimer = null;
let connected = false;   // explicit live-connection state (sock.user can linger after a close)

function scheduleReconnect(delay = 2000) {
  if (reconnectTimer) return;   // don't stack reconnects
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // catch rejections here too — a scheduled reconnect that throws must not become a fatal unhandled rejection
    start().catch((e) => { info('reconnect failed:', e.message); scheduleReconnect(5000); });
  }, delay);
}

async function storeMessage(raw, { allowDownload }) {
  try {
    if (!raw?.message || !raw.key?.id) return;
    const key = raw.key;
    const node = unwrap(raw.message);
    const { type, text, mediaKind } = extract(node);
    if (SKIP_TYPES.has(type)) return;   // skip protocol/system noise
    const fromMe = key.fromMe ? 1 : 0;
    const chatJid = key.remoteJid || '';
    const senderJid = chatJid.endsWith('@g.us') ? key.participant || chatJid : (fromMe ? 'me' : chatJid);
    const ts = Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000);
    // WhatsApp message ids are unique within a chat, not globally → scope the id to (chat, direction).
    const id = `${chatJid}|${fromMe}|${key.id}`;

    // Archive the row FIRST so a crash mid media-download can't drop the message; media is filled in after.
    insertMsg.run(id, chatJid, senderJid, fromMe, raw.pushName || null, ts, type, text || '', null);
    try {
      if (raw.pushName && !fromMe && chatJid && !chatJid.endsWith('@g.us'))
        upsertContact.run(chatJid, raw.pushName, Math.floor(Date.now() / 1000));
    } catch (e) { info('contact upsert failed:', e.message); }

    // Download RECEIVED media (live only) whenever this message still lacks its file — so a transient
    // download failure is retried on the next (re)delivery instead of being lost forever.
    if (allowDownload && !fromMe && mediaKind && getMediaPath.get(id)?.media_path == null) {
      try {
        const buf = await downloadMediaMessage(
          { key, message: node }, 'buffer', {},
          { logger, reuploadRequest: sock.updateMediaMessage },
        );
        const fnameId = crypto.createHash('sha1').update(id).digest('hex').slice(0, 20);   // chat-scoped → no cross-chat clash
        const fname = `${ts}_${fnameId}.${pickExt(node, mediaKind)}`;
        const full = path.join(MEDIA_DIR, fname);
        fs.writeFileSync(full + '.tmp', buf);
        fs.renameSync(full + '.tmp', full);                                                // atomic publish (no partial-file reads)
        setMediaPath.run(path.join('media', fname), id);
      } catch (e) {
        info('media download failed for', key.id, '-', e.message);
      }
    }
  } catch (e) {
    info('storeMessage error:', e.message);
  }
}

function storeContacts(contacts) {
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const c of contacts || []) {
      const name = c.name || c.notify || c.verifiedName || null;
      if (c.id && name) upsertContact.run(c.id, name, now);
    }
  } catch (e) { info('storeContacts failed:', e.message); }
}

// Chats carry display names / group subjects — fold them into the same jid→name map.
function storeChats(chats) {
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const c of chats || []) {
      const name = c.name || c.subject || null;
      if (c.id && name) upsertContact.run(c.id, name, now);
    }
  } catch (e) { info('storeChats failed:', e.message); }
}

// ---------- WhatsApp connection ----------
async function start() {
  // tear down any previous socket so reconnects don't leak listeners / ws connections
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch {}
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // Use the current WhatsApp-Web protocol version, else the handshake fails with 405.
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    info('using WhatsApp web version', version?.join('.'));
  } catch (e) {
    info('version fetch failed (' + e.message + '); using library default');
  }
  sock = makeWASocket({
    version,
    auth: state,
    logger,
    syncFullHistory: true,        // pull a chunk of existing history on first link
    markOnlineOnConnect: false,   // stay passive so the phone keeps getting notifications
    browser: ['wa-cli', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', (...a) => saveCreds(...a).catch((e) => info('saveCreds failed:', e.message)));

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\nScan this QR in WhatsApp > Settings > Linked Devices > Link a Device:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'connecting') connected = false;
    if (connection === 'open') {
      connected = true;
      info('connected as', sock.user?.id);
      try { if (sock.user?.id) setMeta.run('self_jid', jidNormalizedUser(sock.user.id)); } catch (e) { info('meta write failed:', e.message); }
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        info('logged out — delete', AUTH_DIR, 'and re-run to re-link. Exiting.');
        process.exit(1);
      }
      info('connection closed (code', code + ') — reconnecting in 2s');
      scheduleReconnect();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) await storeMessage(m, { allowDownload: true });
  });
  sock.ev.on('messaging-history.set', async ({ messages, contacts, chats }) => {
    storeContacts(contacts);
    storeChats(chats);
    for (const m of messages || []) await storeMessage(m, { allowDownload: false });
  });
  sock.ev.on('contacts.upsert', storeContacts);
  sock.ev.on('contacts.update', storeContacts);
  sock.ev.on('chats.upsert', storeChats);
  sock.ev.on('chats.update', storeChats);
}

// ---------- localhost send API ----------
function resolveJid(to) {
  if (!to) throw new Error('missing recipient');
  if (to === 'me') return jidNormalizedUser(sock.user.id);
  if (to.includes('@')) return to;
  const digits = to.replace(/[^0-9]/g, '');
  if (!digits) throw new Error('recipient must be "me", a phone number, or a jid');
  return `${digits}@s.whatsapp.net`;
}

// Anti-ban send guard: pace sends + cap volume so a runaway caller can't get the number banned.
const SEND_MIN_GAP_MS = num(process.env.WA_CLI_SEND_GAP_MS, 5000);    // base minimum spacing between sends
// + a random 0..jitter on top, so the cadence isn't a fixed (bot-detectable) interval. Set to 0 to disable.
const SEND_JITTER_MS = (() => { const n = Number(process.env.WA_CLI_SEND_JITTER_MS); return Number.isFinite(n) && n >= 0 ? n : 15000; })();
const SEND_MAX_PER_HOUR = num(process.env.WA_CLI_MAX_PER_HOUR, 60);
const SEND_CHUNK_MAX = num(process.env.WA_CLI_CHUNK_MAX, 600);        // split messages longer than this into human-sized chunks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);
const idempotency = new Map();   // caller-supplied key -> { at, result }; replays prior result on retry (10-min TTL)
let lastSendAt = 0;   // inter-send pacing (in-memory); the hourly cap below is DB-persisted across restarts
// Serialize all sends through one chain so the cap + pacing hold even under concurrent callers
// (otherwise parallel requests read the same lastSendAt and burst past the guard).
let sendChain = Promise.resolve();
const enqueueSend = (fn) => {
  const r = sendChain.then(fn, fn);
  sendChain = r.then(() => {}, () => {});
  return r;
};

http
  .createServer((req, res) => {
    const send = (codeNum, obj) => {
      res.writeHead(codeNum, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { connected, user: connected ? sock?.user?.id || null : null });
    }
    if (req.method === 'POST' && req.url === '/send') {
      // CSRF / DNS-rebinding guard: browsers attach Origin/Referer on cross-origin POSTs; the CLI doesn't.
      if (req.headers.origin || req.headers.referer)
        return send(403, { ok: false, error: 'cross-origin requests are not allowed' });
      if (!String(req.headers['content-type'] || '').includes('application/json'))
        return send(415, { ok: false, error: 'Content-Type must be application/json' });
      let clientGone = false;
      res.on('close', () => { if (!res.writableEnded) clientGone = true; });   // caller hung up before we replied
      let body = '';
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return;
        body += c;
        if (body.length > 65536) { tooBig = true; send(413, { ok: false, error: 'payload too large' }); req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        // run through the send queue so the rate cap + pacing apply serially, even under concurrency
        enqueueSend(async () => {
          try {
            if (!connected || !sock?.user) return send(503, { ok: false, error: 'not connected' });
            const { to, message, key: idem } = JSON.parse(body || '{}');
            const jid = resolveJid(to);
            const now = Date.now();
            // idempotency: if the caller retries with a key we've already completed, replay it (no resend)
            if (idem) {
              for (const [k, v] of idempotency) if (now - v.at > 600000) idempotency.delete(k);
              const prior = idempotency.get(idem);
              if (prior) return send(200, prior.result);
            }
            pruneSends.run(now - 3600000);
            if (countSends.get(now - 3600000).c >= SEND_MAX_PER_HOUR)
              return send(429, { ok: false, error: `rate limit: ${SEND_MAX_PER_HOUR} sends/hour (anti-ban guard). Wait, or raise WA_CLI_MAX_PER_HOUR.` });
            // Send as several human-sized chunks (a single wall of text is a spam/ban signal).
            const chunks = splitMessage(message, SEND_CHUNK_MAX);
            let lastId;
            for (let i = 0; i < chunks.length; i++) {
              // first chunk: full randomized between-send spacing; later chunks: shorter typing-like delay
              const wait = i === 0
                ? SEND_MIN_GAP_MS + Math.floor(Math.random() * SEND_JITTER_MS) - (Date.now() - lastSendAt)
                : 1500 + Math.floor(Math.random() * 3500);
              if (wait > 0) await sleep(wait);
              if (clientGone) break;   // caller gave up → stop (avoids dupes on their retry)
              lastSendAt = Date.now();
              logSend.run(lastSendAt);  // count each chunk BEFORE dispatch so a crash can't undercount the cap
              const sent = await withTimeout(sock.sendMessage(jid, { text: chunks[i] }), 30000, 'send');
              lastId = sent?.key?.id;
            }
            const result = { ok: true, id: lastId, jid, chunks: chunks.length };
            if (idem) idempotency.set(idem, { at: Date.now(), result });
            send(200, result);
          } catch (e) {
            send(400, { ok: false, error: e.message });
          }
        });
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  })
  .listen(PORT, '127.0.0.1', () => info('send API on http://127.0.0.1:' + PORT));

start().catch((e) => {
  info('initial start failed:', e.message, '— retrying');
  scheduleReconnect(5000);
});

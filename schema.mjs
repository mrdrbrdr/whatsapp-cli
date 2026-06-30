// Single source of truth for the SQLite schema, shared by daemon.mjs and import.mjs
// (so the importer never hits "no such table" on a fresh install, and the schema can't drift).

export function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 8000;
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,   -- chat-scoped: chatJid|fromMe|whatsappId (live) or imp_<hash> (import)
      chat_jid   TEXT,
      sender_jid TEXT,
      from_me    INTEGER,
      push_name  TEXT,
      timestamp  INTEGER,
      type       TEXT,
      text       TEXT,
      media_path TEXT,
      status     INTEGER   -- delivery state for sent msgs: 1 pending · 2 server-ack (left device) · 3 delivered · 4 read
    );
    CREATE INDEX IF NOT EXISTS idx_chat_ts ON messages(chat_jid, timestamp);
    CREATE TABLE IF NOT EXISTS contacts (
      jid        TEXT PRIMARY KEY,
      name       TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS sent_log (
      ts INTEGER   -- epoch ms of each send; backs the anti-ban hourly cap across restarts
    );
  `);
  // migrate older DBs that predate the status column (CREATE IF NOT EXISTS won't add it)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'status'))
    db.exec('ALTER TABLE messages ADD COLUMN status INTEGER');
}

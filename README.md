# whatsapp-cli

Always-on WhatsApp **read + send** from the terminal, with a local archive.

A small [Baileys](https://github.com/WhiskeySockets/Baileys) daemon holds a single linked-device
connection 24/7, archives every message (sent + received) to a local SQLite DB, downloads
**received** media to disk, and exposes a localhost API. The thin `wa` CLI reads the archive and
sends through the live connection.

This is a **separate linked device** from `mudslide` — both can run at once (WhatsApp allows 4
linked devices). See `~/.claude/docs/whatsapp-cli.md` for the mudslide notes.

## What it's for

This was built to let an **AI agent run procurement autonomously** — sourcing and negotiating with
overseas (e.g. Chinese) manufacturing suppliers over WhatsApp, where messaging dozens of suppliers and
tracking every quote, spec sheet, and photo by hand takes forever. The agent reads incoming supplier
messages straight from the local archive, replies through the live connection (paced to stay under the
radar), and nothing gets lost across a long sourcing run. It works fine as a plain personal
read/send/archive tool too — the agent workflow is just what it was shaped around.

> ⚠️ It rides the **unofficial** WhatsApp API, against WhatsApp's ToS. Automated outreach is the most
> ban-prone use — see the [ban-risk caveat](#ban-risk-caveat). Pace it; don't blast.

## Why this exists

WhatsApp doesn't keep your history forever (disappearing messages, view-once, no server-side
archive on the free tier). This keeps a permanent **local** copy on your machine so correspondence
and received files aren't lost.

## Components

| File | Role |
|------|------|
| `daemon.mjs` | Always-on connection. Archives to SQLite, saves received media, serves the send API. Runs as the `wa-cli` systemd user service. |
| `wa.mjs` (`wa`) | CLI client. Reads the SQLite archive; sends via the daemon. |
| `schema.mjs` | Shared SQLite schema (`ensureSchema`) used by both the daemon and the importer (one source of truth). |
| `messages.mjs` | Pure live-message parsing helpers (`unwrap`/`extract`/`pickExt`), shared by the daemon and the tests. |
| `import.mjs` | Ingests WhatsApp "Export Chat" archives (iPhone/Android) into the store. |
| `test/` | `node --test` suite (`npm test`) — parser units + import/schema/CLI/HTTP-API integration. |
| `backup.sh` | Consistent SQLite snapshot + media mirror → `~/.local/share/wa-cli-backups/`. |
| `install.sh` | Idempotent installer: links `wa`, links the systemd units, enables services, lingering. Also the migration script. |
| `systemd/` | Unit **templates** (`__REPO__`/`__NODE__` placeholders); `install.sh` fills in this machine's paths and writes the real units to `~/.config/systemd/user/`. |

Everything is self-contained in this folder, and the repo **carries no machine-specific paths or personal
data**: `install.sh` generates the systemd units with the local paths and symlinks `~/.local/bin/wa`.
Real data lives only in `~/.local/share/wa-cli/` (separate from code, never in the repo). Re-wire anytime
with `./install.sh`.

## Data (all local, never transmitted)

Everything lives under `~/.local/share/wa-cli/`:

- `auth/` — this device's WhatsApp credentials (sensitive: these *are* the linked-device login)
- `messages.db` — SQLite archive (WAL). Tables: `messages` (one row per message; the id is
  chat-scoped `chatJid|fromMe|whatsappId`), `contacts` (jid→name), `meta` (e.g. `self_jid`),
  `sent_log` (send timestamps backing the persistent hourly cap)
- `media/` — downloaded received images / video / audio / documents / stickers

## Setup

Wire everything up (idempotent — installs deps, links `wa`, links + enables the systemd units, lingering):

```bash
cd ~/sw/utilities/whatsapp-cli
./install.sh
```

Then **log in once** interactively (the systemd service can't show a scannable QR):

```bash
node daemon.mjs          # prints a QR
```

On your phone: **WhatsApp → Settings → Linked Devices → Link a Device → scan**. When it prints
`connected as …`, press **Ctrl-C**, then:

```bash
systemctl --user restart wa-cli.service
wa doctor                # confirm: service active + connected
```

From then on it runs at login and reconnects automatically.

## Usage

```bash
wa doctor                 # health check (service, connection, archive, backups) — run this first
wa status                 # daemon connection status
wa chats                  # recent conversations
wa read <who> [n]         # last n messages of a conversation (default 30)
wa search <term> [n]      # find messages containing <term> across all chats
wa send <who> 'text…'     # send a message
wa media [who] [n]        # list saved received-media file paths
wa tail [who]             # follow new messages live
```

**Send rate limit (anti-ban):** sends are serialized and paced with a **randomized human-like spacing**
(base 5s + up to 15s random jitter — never a fixed, bot-detectable interval), and capped at 60/hour.
The cap is **persisted** (survives daemon restarts) and the pacing/cap hold even under concurrent
callers. Tune via `WA_CLI_MAX_PER_HOUR` / `WA_CLI_SEND_GAP_MS` / `WA_CLI_SEND_JITTER_MS` on the service;
a `429` means the cap was hit — back off rather than retrying in a loop.

`<who>` = `me` · a phone number (`1234567890`) · part of a saved contact/group name (`mom`) · a jid.
Name matches that are ambiguous list the candidates so you can be specific.

## Importing full past history (`wa import`)

The live daemon only captures from when it's running. To pull a **complete** conversation's history
(including old media), use WhatsApp's built-in export and ingest it:

1. On your phone, open the chat → **⋮ / contact name → Export Chat → Include media**.
2. Get that file onto this machine (email-to-self, Google Drive, etc.) and unzip it if needed.
3. Ingest it into the same archive:

```bash
wa import "/path/to/WhatsApp Chat with Acme/" --me "Your WhatsApp Name"
# or point at the _chat.txt directly; add --jid <jid> to force a conversation, --mdy for US dates
```

It parses both iPhone and Android export formats, copies attachments into `media/`, and (for unsaved
numbers) resolves the sender's phone number to the real jid so imported history **merges** with live
capture instead of fragmenting. Re-importing the same export is idempotent (duplicates skipped).

## Backups

`backup.sh` makes a consistent SQLite snapshot (`VACUUM INTO`, safe while the daemon runs) plus an
additive media mirror, under `~/.local/share/wa-cli-backups/` (keeps the last 14 dated DB snapshots).
Runs daily via the **`wa-cli-backup.timer`** systemd user timer. Run on demand:

```bash
~/sw/utilities/whatsapp-cli/backup.sh
systemctl --user list-timers wa-cli-backup.timer
```

Backups are **local** (respecting the "keep it local" requirement). That protects against corruption
and accidental deletion, but not whole-disk failure — for off-machine durability, move the daemon to
the always-on server (below) or add an encrypted off-site copy.

## Service management

```bash
systemctl --user status wa-cli.service
systemctl --user restart wa-cli.service
journalctl --user -u wa-cli.service -f      # logs (incl. media-download notes)
```

## Tests

```bash
npm test          # node --test test/*.test.mjs — no extra deps (Node's built-in runner)
```

59 tests, no network or live WhatsApp needed:
- **Unit** — `messages.mjs` parsing (unwrap/extract/pickExt) and `import.mjs` helpers (date/time across
  locales, media-ref detection, `parsePrefix`).
- **Integration** — `runImport` into isolated temp DBs (1:1 vs group JID, same-minute dedup,
  idempotent re-import, `--replace`, path-traversal safety), and `ensureSchema`.
- **CLI** — runs the real `wa` binary against a fixture DB (`chats`/`read`/`search`/`media`).
- **HTTP API** — spawns the daemon on a throwaway port and checks the guards (CSRF 403, wrong
  content-type 415, oversized 413, not-connected 503, unknown route 404).

## Notes for automation / agents

Built to be driven by an autonomous agent (e.g. a procurement session):

- **Run `wa doctor` first** to confirm the daemon is connected before relying on it.
- **Reading is free and safe** — `wa read`/`search`/`chats`/`media` are read-only SQLite queries; any
  number of callers can run concurrently. New inbound lands in the archive on its own; poll with
  `wa chats` / `wa search`, or query `messages` for `timestamp >` your last check.
- **Sending is guarded** — serialized, paced, and capped (see the rate limit above). A `429` means
  back off, don't retry in a loop. The guard protects the personal number; don't bypass it.
- **At-most-once sends** — if you might retry, pass `wa send <who> '…' --key <stable-id>`; the same key
  replays the prior result instead of resending. Sends also time out after 30s so one can't wedge the queue.
- **Multi-session safe** — one daemon owns the single WhatsApp connection; `wa` callers are thin
  clients, so several agent sessions can use it at once without conflict.
- **Future (not built):** a ~3-minute "settle" debounce before auto-replying, so the agent answers a
  supplier's *complete* thought rather than each chunk of a string-of-messages.

## Limitations & notes

- **Forward-first.** On first link WhatsApp history-syncs a *chunk* of recent conversations, but it
  can't recover everything ever sent. Reliable capture is from when the daemon is running onward.
- **Runs only while the laptop is on.** Messages arriving while it's off may not all backfill on
  reconnect. The service auto-starts at login to minimise gaps.
- **Media:** only **received** files are downloaded (per design), and only for live messages —
  historical media is usually expired server-side and is skipped. View-once / disappearing media is
  captured if the daemon is connected when it arrives.
- **Group display names** depend on what WhatsApp syncs; unknown ones show the raw jid.
- **Import vs live overlap.** If you import a chat the daemon already partly captured, the overlapping
  recent messages can appear twice in `wa read`. This is intentional — the importer does *not*
  auto-dedup against live rows, to avoid ever dropping a legitimately-repeated message.

## Migrating to an always-on server (future)

The "PC must be on to capture" limit goes away on an always-on host. This setup is portable —
Node + `node:sqlite` (no native deps) + a credentials folder. To move it:

1. Copy the project folder and **`~/.local/share/wa-cli/`** (especially `auth/`) to the server.
2. Install Node 24+, then run `./install.sh` — it generates the systemd units with the new host's paths.
3. **Only one machine may use these credentials at a time** — the same `auth/` can't run on laptop and
   server simultaneously (WhatsApp drops one as a conflict). Either move `auth/` (retire the laptop
   instance) or re-link the server as its own device (WhatsApp allows 4) and stop the laptop daemon.

Once it lives on a 24/7 host, forward-capture is effectively 100% and `wa import` becomes just a seed
for pre-existing history.

## Ban-risk caveat

This rides the **unofficial** WhatsApp API (Baileys) and violates WhatsApp's ToS. Fine for normal
personal read/send. **Cold or bulk outreach risks getting the number banned** (2–8 week timelines),
which would take down the real WhatsApp account. Keep sends warm and low-volume.

## Security

- Built on `baileys@6.7.23` (the real `WhiskeySockets/Baileys`, same as the audited mudslide).
- The send API binds to `127.0.0.1` only, requires `Content-Type: application/json`, and **rejects any
  request carrying an `Origin`/`Referer` header** — so a malicious web page can't drive it via a
  DNS-rebinding/CSRF attack. (No token: on a single-user machine, local processes already run as you.)
- The daemon writes nothing outside `~/.local/share/wa-cli/`; nothing is transmitted except to WhatsApp.
- **At rest the archive is plaintext** (SQLite rows + media files) under your home dir. WhatsApp is
  end-to-end encrypted in transit, but once archived it's readable by your user account — `auth/` most
  of all (it's this device's login). For encryption-at-rest, rely on an encrypted home/disk.

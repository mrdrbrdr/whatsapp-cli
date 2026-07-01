# whatsapp-cli

Always-on WhatsApp **read + archive** from the terminal — a permanent local copy of every message and
attachment, queryable by you or an AI agent.

A small [Baileys](https://github.com/WhiskeySockets/Baileys) daemon holds a single linked-device
connection 24/7, archives every message to a local SQLite DB, downloads **received** media to disk, and
exposes a localhost API. The thin `wa` CLI reads the archive.

> ### 🔒 Read-only by default
> This build **receives, archives, and downloads media only — it does not send.** Sending is the
> ban-prone half of the unofficial API (cold sends trip WhatsApp's [error 463 reach-out
> lock](#limitations--notes) and can get the number restricted/banned), so the send path ships
> **disabled**. `wa send` is refused and the daemon's `/send` endpoint returns `403 disabled`. Receiving
> is unaffected — it keeps capturing even while an account restriction is active. To re-enable sending
> (only worthwhile for **warm** contacts on a healthy number), set `WA_CLI_ALLOW_SEND=1` on the
> `wa-cli` service.

This is a **separate linked device** from `mudslide` — both can run at once (WhatsApp allows 4
linked devices). See `~/.claude/docs/whatsapp-cli.md` for the mudslide notes.

## What it's for

Give an **AI agent (or you) a total, permanent overview of your WhatsApp conversations** — every
incoming supplier message, quote, spec sheet, and photo captured locally and searchable, so nothing is
lost across a long sourcing run and an agent can read the full context of any thread. The agent reads
straight from the local archive; replies go out from your **primary phone** (this tool doesn't send).

> ⚠️ Even read-only, it rides the **unofficial** WhatsApp API against WhatsApp's ToS. It's a *linked
> device*, so an account restriction can pause the link — see the [ban-risk caveat](#ban-risk-caveat).

## Why this exists

WhatsApp doesn't keep your history forever (disappearing messages, view-once, no server-side
archive on the free tier). This keeps a permanent **local** copy on your machine so correspondence
and received files aren't lost.

## Components

| File | Role |
|------|------|
| `daemon.mjs` | Always-on connection. Archives to SQLite, saves received media, serves a localhost status/API. Read-only by default (`/send` disabled unless `WA_CLI_ALLOW_SEND=1`). Runs as the `wa-cli` systemd user service. |
| `wa.mjs` (`wa`) | CLI client. Reads the SQLite archive. (`wa send` is disabled in the read-only build.) |
| `schema.mjs` | Shared SQLite schema (`ensureSchema`) used by both the daemon and the importer (one source of truth). |
| `messages.mjs` | Pure live-message parsing helpers (`unwrap`/`extract`/`pickExt`), shared by the daemon and the tests. |
| `import.mjs` | Ingests WhatsApp "Export Chat" archives (iPhone/Android) into the store. |
| `test/` | `node --test` suite (`npm test`) — parser units + import/schema/CLI/HTTP-API integration. |
| `skill/` | A Claude **agent skill** (`SKILL.md`) — copy to `~/.claude/skills/whatsapp/` so an agent learns the commands + anti-ban etiquette. |
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
wa media [who] [n]        # list saved received-media file paths
wa tail [who]             # follow new messages live
wa send <who> 'text…'     # DISABLED (read-only build) — refused; reply from your primary phone
```

**Sending is disabled** in this read-only build (see the note at the top). If re-enabled with
`WA_CLI_ALLOW_SEND=1`, sends are serialized, paced with randomized human-like spacing (base 5s + up to
15s jitter), capped at 60/hour (persisted across restarts), auto-split into human-sized chunks, and
report `sent ✓` only on a real WhatsApp server-ACK. Tune via `WA_CLI_MAX_PER_HOUR` / `WA_CLI_SEND_GAP_MS`
/ `WA_CLI_SEND_JITTER_MS` / `WA_CLI_CHUNK_MAX`. Even then: **cold sends still fail with error 463** — see
[Limitations](#limitations--notes).

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

Built to be driven by an autonomous agent (e.g. a procurement session). **An agent skill is included
at [`skill/SKILL.md`](skill/SKILL.md)** — copy it to `~/.claude/skills/whatsapp/SKILL.md` so a Claude
agent auto-discovers how to use `wa` properly.

- **Run `wa doctor` first** to confirm the daemon is connected before relying on it.
- **This is read-only** — the agent's job is to *read and understand* conversations, not send. `wa send`
  is disabled; **replies go out from the human's primary phone.** Don't try to send; it won't work and
  (if re-enabled) risks the account.
- **Reading is free and safe** — `wa read`/`search`/`chats`/`media` are read-only SQLite queries; any
  number of callers can run concurrently. New inbound lands in the archive on its own; poll with
  `wa chats` / `wa search`, or query `messages` for `timestamp >` your last check.
- **Full overview via the DB** — for anything beyond the subcommands (per-contact history, date ranges,
  aggregation, unread triage), open `~/.local/share/wa-cli/messages.db` **read-only** with Node's
  `node:sqlite` and query `messages` directly. Attachments are files under `~/.local/share/wa-cli/media/`
  referenced by `messages.media_path`.
- **Multi-session safe** — one daemon owns the single WhatsApp connection; `wa` callers are thin
  clients, so several agent sessions can read at once without conflict.
- **If sending is ever re-enabled** (`WA_CLI_ALLOW_SEND=1`): it's paced/capped/auto-chunked and reports
  `sent ✓` only on a real server-ACK, but **cold sends still fail with WhatsApp error 463** (reach-out
  lock — see [Limitations](#limitations--notes)). Only message **warm** contacts (who have written to
  you); let new suppliers open the thread first. Never bulk/cold-blast — that's what gets the number banned.

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
- **Cold sends fail with WhatsApp error 463 ("reach-out time-lock").** This is a server-side anti-spam
  restriction on the *account* — pronounced on numbers with a prior ban — that blocks outbound to
  recipients who haven't messaged you (no privacy token). The Baileys 7.x upgrade adds LID addressing +
  privacy-token (tctoken) handling, which is required for these LID-migrated contacts and lets **warm**
  sends through, but [client measures can't fully bypass](https://github.com/WhiskeySockets/Baileys/issues/2441)
  the lock. **Autonomous cold outreach from a previously-banned number is not reliable** — warm up
  contacts first, or use an aged number / the official WhatsApp Business Platform API for outbound.

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

- Built on `baileys@7.0.0-rc13` (the real `WhiskeySockets/Baileys`, same project as the audited
  mudslide). 7.x is required: WhatsApp migrated accounts to **LID** addressing, which 6.x can't route —
  on 6.x, sends to LID-migrated contacts silently fail to deliver. The 6.x→7.x bump keeps the existing
  `auth/` (no re-link needed).
- The send API binds to `127.0.0.1` only, requires `Content-Type: application/json`, and **rejects any
  request carrying an `Origin`/`Referer` header** — so a malicious web page can't drive it via a
  DNS-rebinding/CSRF attack. (No token: on a single-user machine, local processes already run as you.)
- The daemon writes nothing outside `~/.local/share/wa-cli/`; nothing is transmitted except to WhatsApp.
- **At rest the archive is plaintext** (SQLite rows + media files) under your home dir. WhatsApp is
  end-to-end encrypted in transit, but once archived it's readable by your user account — `auth/` most
  of all (it's this device's login). For encryption-at-rest, rely on an encrypted home/disk.

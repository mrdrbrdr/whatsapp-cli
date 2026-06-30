---
name: whatsapp
description: Read, send, search, and archive WhatsApp from the terminal via the `wa` CLI (the always-on wa-cli daemon). Use whenever you need to send or read WhatsApp messages, look through chat history or supplier conversations, find received files/media, or import a WhatsApp "Export Chat" for full past history. Heed the unofficial-API ban-risk caveat before any bulk/cold outreach.
argument-hint: "[send|read|chats|search|import …]"
---

# WhatsApp from the terminal (whatsapp-cli)

This machine runs **[whatsapp-cli](https://github.com/mrdrbrdr/whatsapp-cli)** — an always-on daemon
linked to a WhatsApp account that archives every message to local SQLite, saves received media, and
serves a localhost send API. The `wa` command (on PATH) is the client. It was built so an agent can run
**procurement autonomously** with overseas manufacturing suppliers. Everything is local; nothing leaves
the machine except to WhatsApp.

**Always run `wa doctor` first** to confirm the daemon is up and connected before relying on it.

## Commands

```bash
wa doctor                 # health: service, connection, archive counts, last msg, backups
wa status                 # quick: is the daemon connected?
wa chats [n]              # recent conversations (default 20)
wa read <who> [n]         # last n messages of a conversation (default 30)
wa search <term> [n]      # find messages containing <term> across ALL chats
wa send <who> 'text…'     # send a message (auto-chunked + paced; see below)
wa media [who] [n]        # list saved received-media file paths
wa tail [who]             # follow new messages live
wa import <path> [--me "Name"] [--jid <jid>] [--mdy] [--replace]   # ingest a WhatsApp "Export Chat"
```

`<who>` = `me` · a phone number · part of a saved contact/group name · a jid. Ambiguous name matches
print candidates — pick a more specific term.

## Sending like a human (anti-ban — read this)

This rides the **unofficial** WhatsApp API (Baileys), against WhatsApp's ToS. Automated/cold outreach
is the most ban-prone use, and a ban takes down the real account. So:

- **Compose like a person.** Prefer a few short messages over one long block. Pasting one giant
  wall of text is a known ban trigger. (The tool also **auto-splits** anything long into several
  human-sized messages a few seconds apart, but write naturally anyway.)
- **Pacing is enforced:** randomized 5–20s spacing between sends, capped at 60/hour, both persisted
  across restarts. A `429` means the cap was hit — **back off, don't retry in a loop.**
- **`sent ✓` means a real server-ACK** — the daemon waits for WhatsApp to confirm, not just for Baileys
  to queue locally. If it can't confirm within ~12s (degraded link), `wa send` prints `⚠ QUEUED` and
  **exits 2** — don't blindly resend; retry with `--key`. `wa read` shows ✓ / ✓✓ delivery ticks.
- **At-most-once:** if you might retry a send, pass `wa send <who> '…' --key <stable-id>` — the same
  key replays the prior result instead of resending.
- **Never bulk-blast.** Pace yourself; treat the number as precious.

Tunables (env on the `wa-cli` service): `WA_CLI_MAX_PER_HOUR`, `WA_CLI_SEND_GAP_MS`,
`WA_CLI_SEND_JITTER_MS`, `WA_CLI_CHUNK_MAX`.

## Reading / "what's new"

Incoming messages land in the local archive on their own while the daemon runs. Poll with `wa chats`
(most-recent first) / `wa search`, or query the SQLite DB at `~/.local/share/wa-cli/messages.db`
read-only with Node's `node:sqlite` for date ranges / aggregation. Schema:
`messages(id, chat_jid, sender_jid, from_me, push_name, timestamp, type, text, media_path)`.

**Multi-session safe:** one daemon owns the connection; every `wa` call is a thin client, so multiple
agent sessions can read/send concurrently without conflict.

## Importing full past history

The live daemon only captures forward. To pull a complete conversation in (incl. old media): the human
exports it (**Export Chat → Include media** in the WhatsApp phone app), gets the file onto the machine,
and you `wa import` it. Parses iPhone/Android formats, copies attachments, merges by phone-number jid.

## Setup / re-link

See the repo README. In short: `./install.sh`, then link the device once with `node daemon.mjs` (scan
the QR), and `systemctl --user restart wa-cli.service`. To use this skill with your own agent, copy this
file to `~/.claude/skills/whatsapp/SKILL.md`.

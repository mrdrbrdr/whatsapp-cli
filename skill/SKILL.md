---
name: whatsapp
description: Read, search, and archive WhatsApp from the terminal via the `wa` CLI (the always-on wa-cli daemon). Read-only — receives + archives every message and downloads attachments to a local DB for a full conversation overview; it does NOT send (sending is disabled to protect the account). Use whenever you need to read WhatsApp messages, look through chat history or supplier conversations, find received files/media, or import a WhatsApp "Export Chat" for full past history.
argument-hint: "[read|chats|search|media|import …]"
---

# WhatsApp from the terminal (whatsapp-cli)

This machine runs **[whatsapp-cli](https://github.com/mrdrbrdr/whatsapp-cli)** — an always-on daemon
linked to a WhatsApp account that archives every message to local SQLite and saves received media. The
`wa` command (on PATH) is the client. It gives an agent a **complete, permanent, searchable overview of
the user's WhatsApp conversations** (supplier chats, quotes, spec sheets, photos). Everything is local;
nothing leaves the machine.

> **🔒 Read-only.** This tool **receives + archives only — it does NOT send.** `wa send` is disabled and
> the daemon refuses `/send`. Your job is to read/understand threads; **the human replies from their
> primary phone.** (Sending is the ban-prone part of the unofficial API — a prior cold-send batch got
> this number's linked devices restricted, so send ships off.)

**Always run `wa doctor` first** to confirm the daemon is up and connected before relying on it.

## Commands

```bash
wa doctor                 # health: service, connection, archive counts, last msg, backups
wa status                 # quick: is the daemon connected?
wa chats [n]              # recent conversations (default 20)
wa read <who> [n]         # last n messages of a conversation (default 30)
wa search <term> [n]      # find messages containing <term> across ALL chats
wa media [who] [n]        # list saved received-media file paths
wa tail [who]             # follow new messages live
wa import <path> [--me "Name"] [--jid <jid>] [--mdy] [--replace]   # ingest a WhatsApp "Export Chat"
```

`<who>` = `me` · a phone number · part of a saved contact/group name · a jid. Ambiguous name matches
print candidates — pick a more specific term.

## Sending is disabled (read-only)

`wa send` is turned off in this build — it refuses with a read-only notice, and the daemon returns
`403 disabled`. **Don't try to send.** If the user wants to reply to someone, tell them what to send and
have them do it **from their primary phone**; your role is to read and summarise the conversations, not
to message anyone.

*(Why: this rides the unofficial WhatsApp API. Automated/cold sending is what gets the number banned — a
prior batch already triggered a linked-device restriction. Sending can be re-enabled by the human with
`WA_CLI_ALLOW_SEND=1` on the `wa-cli` service, and even then cold contacts fail with WhatsApp error 463
and only warm contacts deliver — but default is off.)*

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

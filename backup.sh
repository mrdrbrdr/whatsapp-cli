#!/usr/bin/env bash
# Local backup of the WhatsApp archive: a consistent SQLite snapshot + an additive media mirror.
# Safe to run while the daemon is live (VACUUM INTO takes a brief read lock; media files are write-once).
set -euo pipefail

SRC="${WA_CLI_DATA:-$HOME/.local/share/wa-cli}"
DEST="$HOME/.local/share/wa-cli-backups"
KEEP=14                                  # how many dated DB snapshots to retain
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST/db" "$DEST/media"

# 1) consistent DB snapshot (VACUUM INTO writes a clean copy; coexists with WAL).
#    Paths are passed via env (not interpolated into the script) and single-quote-escaped for the SQL.
NODE_BIN="$HOME/.local/share/mise/shims/node"
WA_SRC_DB="$SRC/messages.db" WA_DEST_DB="$DEST/db/messages-$STAMP.db" "$NODE_BIN" --input-type=module -e '
import {DatabaseSync} from "node:sqlite";
const q = String.fromCharCode(39);
const dest = process.env.WA_DEST_DB.split(q).join(q + q);   // escape single quotes for the SQL string literal
const db = new DatabaseSync(process.env.WA_SRC_DB);
db.exec("PRAGMA busy_timeout = 8000;");                     // wait for the daemon writes instead of SQLITE_BUSY
db.exec("VACUUM INTO " + q + dest + q);
'

# 2) media mirror (additive — never deletes, files don't change once written)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='*.tmp' "$SRC/media/" "$DEST/media/"   # skip in-flight atomic-write temp files
else
  cp -an "$SRC/media/." "$DEST/media/" 2>/dev/null || true
fi

# 3) rotate dated DB snapshots, keep newest $KEEP
ls -1t "$DEST/db"/messages-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "wa-cli backup $STAMP — $(ls -1 "$DEST/db" | wc -l) db snapshots, $(ls -1 "$DEST/media" 2>/dev/null | wc -l) media files in mirror"

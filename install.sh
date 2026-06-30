#!/usr/bin/env bash
# Idempotent installer / re-wirer for whatsapp-cli.
# Run after cloning, after editing units, or to repair the setup. Safe to run repeatedly.
# This is also the migration path to another host (clone the repo there, adjust the absolute
# paths in systemd/*.service, then run this).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"

echo "whatsapp-cli install — repo: $REPO"

# 1) dependencies
if [ ! -d "$REPO/node_modules" ]; then
  echo "- npm install..."
  (cd "$REPO" && npm install --silent)
fi

# 2) the `wa` command on PATH
mkdir -p "$BIN"
ln -sfn "$REPO/wa.mjs" "$BIN/wa"
echo "- linked $BIN/wa -> wa.mjs"

# 3) systemd units — generated from templates (the repo carries no machine-specific paths;
#    __REPO__/__NODE__ are substituted here at install time)
NODE="$([ -x "$HOME/.local/share/mise/shims/node" ] && echo "$HOME/.local/share/mise/shims/node" || command -v node)"
mkdir -p "$UNITS"
for u in wa-cli.service wa-cli-backup.service wa-cli-backup.timer; do
  rm -f "$UNITS/$u"   # drop any prior symlink so we don't write through it back into the repo
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$REPO/systemd/$u" > "$UNITS/$u"
done
echo "- generated systemd units (REPO=$REPO, NODE=$NODE)"
systemctl --user daemon-reload
systemctl --user enable --now wa-cli.service >/dev/null 2>&1 || true
systemctl --user enable --now wa-cli-backup.timer >/dev/null 2>&1 || true
echo "- enabled wa-cli.service + wa-cli-backup.timer"

# 4) keep the daemon alive even before interactive login
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo
echo "done.  Verify with:  wa doctor"
echo "If 'wa doctor' shows NOT CONNECTED, link the device once:"
echo "  node \"$REPO/daemon.mjs\"   # scan the QR, wait for 'connected as…', Ctrl-C"
echo "  systemctl --user restart wa-cli.service"

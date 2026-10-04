#!/bin/sh
# Install dsh-computer-control into a DSH profile, without pnpm.
#
#   sh scripts/install-local.sh [profile-name]
#
# Copies the package to <profile>/plugins/computer-control, builds the native
# helper there, and appends the loader row to <profile>/cordis.patch.yml
# (backing the file up first). Idempotent: running it again only refreshes the
# files.
set -e

HERE=$(cd "$(dirname "$0")/.." && pwd)
PROFILE_NAME=${1:-${DSH_PROFILE:-desktop}}
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"

if [ ! -d "$PROFILE" ]; then
  echo "profile not found: $PROFILE" >&2
  echo "available:" >&2
  ls "$HOME/.dsh/profiles" >&2 || true
  exit 1
fi

DEST="$PROFILE/plugins/computer-control"
mkdir -p "$DEST/bin"

echo "installing to $DEST"
for entry in lib native scripts docs package.json cordis.patch.yml README.md README.en.md LICENSE; do
  [ -e "$HERE/$entry" ] || continue
  rm -rf "$DEST/$entry"
  cp -R "$HERE/$entry" "$DEST/$entry"
done

echo "building native helper"
swiftc -O -o "$DEST/bin/dsh-input" "$DEST/native/DshInput.swift"
chmod +x "$DEST/bin/dsh-input"

PATCH="$PROFILE/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf '# dsh profile patch layer\n[]\n' > "$PATCH"
fi

if grep -q '^[[:space:]]*-[[:space:]]*id:[[:space:]]*computer-control[[:space:]]*$' "$PATCH"; then
  echo "loader row already present in $PATCH"
else
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  cat >> "$PATCH" <<'YAML'

# dsh-computer-control (added by scripts/install-local.sh)
- insert:
    - id: computer-control
      name: './plugins/computer-control/lib/index.js'
YAML
  echo "added loader row to $PATCH"
fi

echo
echo "done. Restart DeepSeek Harness (or let HMR pick up the patch), then:"
echo "  - grant Privacy & Security permissions to DeepSeek Harness:"
echo "      Accessibility (mouse/keyboard) and Screen Recording (screenshots)"
echo "  - ask the agent to run computer_policy action=environment to confirm"

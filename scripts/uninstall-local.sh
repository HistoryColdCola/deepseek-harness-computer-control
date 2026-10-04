#!/bin/sh
# Remove dsh-computer-control from a DSH profile.
#
#   sh scripts/uninstall-local.sh [profile-name]
set -e

PROFILE_NAME=${1:-${DSH_PROFILE:-desktop}}
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
DEST="$PROFILE/plugins/computer-control"
PATCH="$PROFILE/cordis.patch.yml"

if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  python3 - "$PATCH" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
marker = '# dsh-computer-control (added by scripts/install-local.sh)'
if marker in text:
    head, _, tail = text.partition(marker)
    # drop the block: marker line plus the following top-level list item
    lines = tail.splitlines()
    index = 1
    while index < len(lines) and not lines[index].startswith('- '):
        index += 1
    text = head + '\n'.join(lines[index:]).lstrip('\n')
    open(path, 'w', encoding='utf-8').write(text)
    print('removed loader row')
else:
    print('no loader row found')
PY
fi

if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  echo "removed $DEST"
fi
echo "done. Restart DeepSeek Harness."

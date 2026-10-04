#!/bin/sh
# Build the native Quartz input helper (dsh-input) into ./bin.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$HERE/bin"
echo "building $HERE/bin/dsh-input"
swiftc -O -o "$HERE/bin/dsh-input" "$HERE/native/DshInput.swift"
chmod +x "$HERE/bin/dsh-input"
"$HERE/bin/dsh-input" check

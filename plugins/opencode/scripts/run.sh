#!/bin/sh
# Start the OpenCode companion with Bun (>= 1.4) when it is on PATH, else Node (>= 22).
#
#   sh run.sh <subcommand> [args...]     runs opencode-companion.mjs
#   sh run.sh <script>.mjs [args...]     runs another script in this folder (hooks)
#
# OPENCODE_COMPANION_RUNTIME=node|bun forces one runtime.

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
case "${1:-}" in
  *.mjs) script=$1; shift ;;
  *) script=opencode-companion.mjs ;;
esac

# version_at_least <version> <major> <minor>
version_at_least() {
  v=${1#v}
  major=${v%%.*}
  rest=${v#*.}
  minor=${rest%%.*}
  case "$major.$minor" in
    *[!0-9.]* | .* | *.) return 1 ;;
  esac
  [ "$major" -gt "$2" ] || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; }
}

use_bun() {
  case "${OPENCODE_COMPANION_RUNTIME:-}" in
    node) return 1 ;;
    bun) return 0 ;;
  esac
  command -v bun >/dev/null 2>&1 && version_at_least "$(bun --version 2>/dev/null)" 1 4
}

if use_bun; then
  exec bun "$dir/$script" "$@"
fi

node_version=$(node --version 2>/dev/null)
if ! version_at_least "$node_version" 22 0; then
  echo "opencode-companion: Node.js 22 or later, or Bun 1.4 or later, is required (node: ${node_version:-not found})." >&2
  exit 1
fi
exec node "$dir/$script" "$@"

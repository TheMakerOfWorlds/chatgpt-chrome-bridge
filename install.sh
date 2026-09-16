#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$(uname -s)" != Darwin ]; then
  echo 'ChatGPT Bridge currently supports macOS with Google Chrome.' >&2
  exit 1
fi
# GUI-launched Terminal scripts may not inherit Homebrew's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22 LTS from https://nodejs.org/, then run this installer again.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo 'Node.js 20 or newer is required. Install Node.js 22 LTS, then retry.' >&2
  exit 1
fi
exec node ./scripts/manage.mjs install "$@"

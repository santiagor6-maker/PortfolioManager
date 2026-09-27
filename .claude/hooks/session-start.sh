#!/bin/bash
# Claude Code SessionStart: turn on the repo's git hooks and, in a cloud session, install dependencies
# so the typecheck, unit tests and scripts/checks.ts work from the first turn.
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

git config core.hooksPath .githooks

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
# npm records what it installed in node_modules/.package-lock.json; reinstall when package-lock.json is newer.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund >&2
fi

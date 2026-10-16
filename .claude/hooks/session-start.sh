#!/bin/bash
# Cloud sessions start with dependencies installed and the Prisma client generated.
# Unit tests need no .env: apps/web/__tests__/test-env.ts sets their env values.
# Fast when nothing changed: a stamp of the lockfile and Prisma schema skips the work.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
stamp_file=node_modules/.cue-session-start
stamp="$(cat pnpm-lock.yaml apps/web/prisma/schema.prisma | sha256sum | cut -d' ' -f1)"

if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$stamp" ] &&
  [ -d apps/web/generated/prisma ]; then
  exit 0
fi

# Browsers and Electron are large and preinstalled where needed.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
pnpm install --frozen-lockfile --reporter=silent >&2
[ -d apps/web/generated/prisma ] || pnpm -F inbox-zero-ai exec prisma generate >&2
echo "$stamp" > "$stamp_file"

#!/bin/bash
# Stop hook: before Claude ends a turn, run the unit tests related to the
# apps/web files changed since the last commit. Failures go back to Claude once;
# a second stop in a row (stop_hook_active) always ends the turn. Only failing
# tests block: a run that times out (60 s cap) or can't run at all never does.
# The type check and full suite stay in CI.
set -uo pipefail

grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$root/apps/web" 2>/dev/null || exit 0
[ -x node_modules/.bin/vitest ] || exit 0

files=()
while IFS= read -r file; do
  [ -f "$file" ] && files+=("$file")
done < <({ git diff --name-only --relative HEAD; git ls-files --others --exclude-standard; } |
  grep -E '\.(ts|tsx|mts|mjs|js|jsx)$' | grep -vE '(^|/)__tests__/(playwright|e2e|eval|ai)/' | sort -u)
((${#files[@]})) || exit 0

if command -v timeout >/dev/null; then
  limit=(timeout 60)
else
  limit=(perl -e 'alarm shift; exec @ARGV' 60)
fi
output="$("${limit[@]}" "$root/scripts/agent-run.sh" pnpm exec vitest related --run \
  --reporter=dot --passWithNoTests "${files[@]}" 2>&1)"
status=$?

case $status in
  0) exit 0 ;;
  124 | 142) echo "Related unit tests didn't finish in 60 s; not blocking." >&2; exit 0 ;;
esac
# Only failing tests block. A crash, config error or OOM is reported, not held
# against the turn.
plain="$(sed 's/\x1b\[[0-9;]*m//g' <<< "$output")"
if ! grep -Eq '^ *Test Files .*failed' <<< "$plain"; then
  echo "Related unit tests didn't run cleanly (exit $status); not blocking:" >&2
  tail -5 <<< "$plain" >&2
  exit 0
fi
{
  echo "Unit tests related to your changed files fail (vitest related, apps/web):"
  echo "$plain" | grep -E '(FAIL|✗|×|AssertionError|Error:|Test Files|Tests  )' | head -25
} >&2
exit 2

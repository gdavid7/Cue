#!/bin/bash
# PostToolUse on Edit/Write: format and safe-fix the edited file with Biome.
# Silent unless lint errors remain, which go back to Claude in a few lines.
set -uo pipefail

file="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).tool_input??{};process.stdout.write(i.file_path??i.notebook_path??"")})')"
biome="${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/biome"
[ -n "$file" ] && [ -f "$file" ] && [ -x "$biome" ] || exit 0
case "$file" in
  "${CLAUDE_PROJECT_DIR:-$PWD}"/*) ;;
  *) exit 0 ;;
esac
case "$file" in
  *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

output="$(cd "${CLAUDE_PROJECT_DIR:-.}" && "$biome" check --write --no-errors-on-unmatched \
  --files-ignore-unknown=true --reporter=github --max-diagnostics=10 "$file" 2>&1)" && exit 0
echo "Biome found issues in $file:" >&2
echo "$output" | grep '^::' | head -10 >&2
exit 2

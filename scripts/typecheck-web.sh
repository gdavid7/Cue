#!/usr/bin/env bash
# The non-test type check Vercel's build enforces on apps/web.
# Prints nothing and exits 0 when clean. Fails on any error outside tests, and
# also when tsc exits non-zero without reporting a type error (a crash or OOM),
# which a plain grep pipeline would read as clean.
set -uo pipefail
cd "$(dirname "$0")/../apps/web"

output="$(pnpm exec tsc --noEmit -p tsconfig.json 2>&1)"
status=$?

errors="$(grep "error TS" <<< "$output" || true)"
product_errors="$(grep -vE '\.test\.tsx?|__tests__|__mocks__' <<< "$errors" || true)"

if [[ -n "$product_errors" ]]; then
  echo "$product_errors"
  exit 1
fi
if ((status)) && [[ -z "$errors" ]]; then
  echo "tsc exited $status without reporting a type error:" >&2
  tail -20 <<< "$output" >&2
  exit 1
fi
exit 0

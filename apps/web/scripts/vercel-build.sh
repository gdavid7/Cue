#!/usr/bin/env bash
# Vercel caps vercel.json's buildCommand at 256 characters, so the build lives here.
# One package at a time keeps the build inside the builder's memory limit.
set -euo pipefail

# The type check runs in its own Node heap beside the build and gets killed
# without output on Vercel's builder. CI's Build Check type-checks every commit
# before it can reach production, so the deploy build skips it.
export SKIP_TYPE_CHECK=true

cd ../..

if [[ "${VERCEL_ENV:-}" == "preview" ]] && [[ "${IS_OAUTH_PROXY_SERVER:-}" != "true" ]]; then
  NEXT_PUBLIC_BASE_URL="https://${VERCEL_URL}" exec turbo run build --force --concurrency=1 "--filter={apps/web}..."
fi

exec turbo run build --concurrency=1 "--filter={apps/web}..."

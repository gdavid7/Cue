#!/usr/bin/env bash
# Vercel caps vercel.json's buildCommand at 256 characters, so the build lives here.
# One package at a time keeps the build inside the builder's memory limit.
set -euo pipefail

cd ../..

if [[ "${VERCEL_ENV:-}" == "preview" ]] && [[ "${IS_OAUTH_PROXY_SERVER:-}" != "true" ]]; then
  NEXT_PUBLIC_BASE_URL="https://${VERCEL_URL}" exec turbo run build --force --concurrency=1 "--filter={apps/web}..."
fi

exec turbo run build --concurrency=1 "--filter={apps/web}..."

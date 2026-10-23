#!/usr/bin/env bash
# Usage: ensure-browser-libs.sh <install-deps command...> -- <browser binary...>
#
# The runner image already ships the shared libraries chromium and Electron
# link against. `playwright install --with-deps` also pulls fonts and package
# upgrades from an apt mirror that sometimes crawls at ~30 kB/s without ever
# going silent, so apt's own timeouts never fire. Check the binaries with ldd
# and go to apt only when a library is actually missing.
set -u

deps_command=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  deps_command+=("$1")
  shift
done
shift

binaries=("$@")
for binary in "${binaries[@]}"; do
  test -x "$binary" || { echo "::error::Browser binary not found: $binary"; exit 1; }
done

missing="$(ldd "${binaries[@]}" | grep 'not found' | sort -u || true)"
if [ -n "$missing" ]; then
  echo "Missing shared libraries:"
  echo "$missing"
  INSTALL_ATTEMPT_TIMEOUT=150 "$(dirname "$0")/install-with-retry.sh" "${deps_command[@]}"
fi

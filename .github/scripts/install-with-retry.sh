#!/usr/bin/env bash
# Runs a Playwright install command (which shells out to apt) with a per-attempt
# cap and retries. A killed attempt can leave apt holding the dpkg lock, so free
# the lock and repair dpkg before the next try.
set -u

printf 'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAcquire::Retries "3";\n' |
  sudo tee /etc/apt/apt.conf.d/99-ci-fast-fail > /dev/null

for attempt in 1 2 3; do
  if timeout -k 15 240 "$@"; then
    exit 0
  fi
  echo "Install attempt $attempt failed or timed out"
  sudo fuser -k /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock || true
  for _ in $(seq 30); do
    sudo fuser /var/lib/dpkg/lock-frontend > /dev/null 2>&1 || break
    sleep 1
  done
  sudo dpkg --configure -a || true
done
exit 1

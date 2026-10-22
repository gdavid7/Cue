#!/usr/bin/env bash
# Runs a Playwright install command (which shells out to apt) with a per-attempt
# cap and retries. Playwright runs apt through sudo, so the timeout's SIGKILL
# cannot reach it and a killed attempt leaves apt holding the dpkg lock. Kill
# any leftover holder, wait for the locks, and repair dpkg before the next try.
set -u

locks="/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock"

printf 'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAcquire::Retries "3";\n' |
  sudo tee /etc/apt/apt.conf.d/99-ci-fast-fail > /dev/null

for attempt in 1 2 3; do
  if setsid timeout -k 15 "${INSTALL_ATTEMPT_TIMEOUT:-420}" "$@"; then
    exit 0
  fi
  echo "Install attempt $attempt failed or timed out"
  sudo pkill -KILL -x "apt-get|apt|dpkg" || true
  # shellcheck disable=SC2086
  sudo fuser -k $locks || true
  # shellcheck disable=SC2086
  for _ in $(seq 60); do
    sudo fuser $locks > /dev/null 2>&1 || break
    sleep 1
  done
  sudo dpkg --configure -a || true
done
exit 1

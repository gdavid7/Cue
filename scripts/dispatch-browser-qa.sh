#!/usr/bin/env bash
# Run emulated browser QA on GitHub Actions for a branch and wait for the result.
# Usage: scripts/dispatch-browser-qa.sh [--ref BRANCH] [--provider both|google|microsoft] [SPEC...]
#   SPEC is an area (mail), a feature group (mail-triage) or a spec path under
#   apps/web/__tests__/playwright/emulated. No SPEC runs the whole suite.
# Needs an authenticated gh CLI. Without one, use the GitHub MCP tools instead:
# docs/dev-infra/ci-browser-qa.md.
set -euo pipefail

ref="$(git rev-parse --abbrev-ref HEAD)"
provider=both
specs=()
while (($#)); do
  case "$1" in
    --ref) ref="$2"; shift 2 ;;
    --provider) provider="$2"; shift 2 ;;
    -h | --help) sed -n '2,7p' "$0"; exit 0 ;;
    *) specs+=("$1"); shift ;;
  esac
done

gh auth status >/dev/null 2>&1 || {
  echo "gh is not authenticated; dispatch with the GitHub MCP tools (docs/dev-infra/ci-browser-qa.md)." >&2
  exit 2
}

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run playwright.yml --ref "$ref" \
  -f specs="${specs[*]}" -f provider="$provider"

# The dispatch API returns no run id; take the newest dispatch on this ref since we asked.
run_id=""
for _ in $(seq 1 30); do
  run_id="$(gh run list --workflow playwright.yml --branch "$ref" --event workflow_dispatch \
    --created ">=$started" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 2
done
[[ -n "$run_id" ]] || { echo "Dispatched, but no run appeared for $ref." >&2; exit 1; }

echo "Run: $(gh run view "$run_id" --json url --jq .url)"
status=0
gh run watch "$run_id" --exit-status --interval 30 >/dev/null || status=$?

gh run view "$run_id" --json conclusion,jobs --jq \
  '"Conclusion: \(.conclusion)", (.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  \(.conclusion): \(.name)")'
if ((status)); then
  echo "Failed spec logs: gh run view $run_id --log-failed"
  echo "Merged HTML report: gh run download $run_id --pattern 'playwright-artifacts-*'"
fi
exit "$status"

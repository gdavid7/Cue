# Performance measurement

`emulated/mail/perf-budgets.spec.ts` asserts budgets for the flows people repeat
all day (opening Cue, opening a conversation, triage, switching views, search,
compose) and runs with the rest of the emulated mail suite in CI. This folder
reruns the same spec against a mailbox of a few thousand messages behind
provider latency, repeats each flow and writes the medians, so a change can be
compared before and after.

```sh
# A production build, as CI uses: pnpm -F inbox-zero-ai build:ci
PLAYWRIGHT_PRODUCTION=1 PERF_RUNS=5 PERF_PROFILE=laptop \
  PERF_REPORT_FILE=.tmp/perf/report \
  pnpm -F inbox-zero-ai exec playwright test \
  -c __tests__/playwright/perf/playwright.config.mjs --project=perf
```

`PERF_PROFILE=phone` emulates a phone screen with 4x CPU throttling. Cold
loads also run on a Fast 4G connection. `PERF_THREADS` sizes the mailbox
(default 1500 conversations, about 3000 messages) and
`PERF_PROVIDER_LATENCY_MS` the provider's latency (default 120 ms).
`PERF_SYNC_WAIT_MS` bounds how long a run waits for the first sync to settle
before measuring.

Timings run in the page, from the input event to the animation frame that
shows the result, so they include rendering but not Playwright's own polling.
Contexts use a persistent browser profile: an incognito context keeps the local
mailbox in memory behind a browser round trip for every disk access, which
makes local writes many times slower than on a real profile. Set
`PERF_INCOGNITO=1` to measure the incognito path.

Tracing and video are off here: trace snapshots run on the page's main thread
around every action and land inside input timings.

Flows beyond the CI budgets run only on this large mailbox: an inbox opened
right after sign-in with the service worker installed, the first compose
while the signature was never read from Gmail, mail delivered while Cue was
closed (with its layout shift), and moving through and archiving in the
list.

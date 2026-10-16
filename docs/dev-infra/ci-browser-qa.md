# Browser QA on GitHub Actions

`.github/workflows/playwright.yml` runs the emulated Playwright suite on GitHub's
runners instead of the shared dev machine. One job builds the app once; each
feature group then runs in its own job, once per mail provider.

It needs **no repository secrets**. Google, Microsoft, the LLM, Stripe, Redis
and Postgres are all emulated or run as service containers, and every env value
in the workflow is a fixed test value. It runs the same way on a fork, where
pull requests get no secrets.

## When it runs

- **On demand, for any branch** (`workflow_dispatch`). Inputs:
  - `specs`: space- or comma-separated areas (`mail`), feature groups
    (`mail-triage`, from `apps/web/utils/playwright/emulated-suite-targets.mjs`)
    or spec paths under `apps/web/__tests__/playwright/emulated`
    (`mail/today.spec.ts`). Empty runs the whole suite.
  - `provider`: `both` (default), `google` or `microsoft`. A group that only
    runs on Google drops out when you pick `microsoft`.
- Nightly at 06:00 UTC on the default branch, full suite.
- Push and pull request to `main`, scoped to the changed specs. This repository
  has no `main`, so these only matter upstream.

Each dispatch gets its own concurrency group, so a second dispatch on the same
branch does not cancel the first.

## Dispatching as an agent

Push the branch first; the workflow runs the pushed commit.

With an authenticated `gh` CLI, background this one command. It exits when the
run finishes, prints the run URL and lists any failed jobs:

```bash
scripts/dispatch-browser-qa.sh --ref my-branch mail/today.spec.ts mail-triage
scripts/dispatch-browser-qa.sh --ref my-branch --provider google   # full suite, Gmail only
```

Without `gh` (cloud sessions), use the GitHub MCP tools:

1. `actions_run_trigger` with `method: run_workflow`, `workflow_id: playwright.yml`,
   `ref: <branch>`, `inputs: {"specs": "mail/today.spec.ts mail/triage-actions.spec.ts", "provider": "both"}`.
2. `actions_list` with `method: list_workflow_runs`, `resource_id: playwright.yml`
   and `workflow_runs_filter: {branch, event: "workflow_dispatch"}` to get the run id.
3. Wait for it to finish without polling in the foreground (subscribe to the PR,
   or schedule one check-in about 10 minutes out for a small set, 25 for the full suite).
4. `actions_list` with `method: list_workflow_jobs` lists each job's conclusion.
   The full-suite job list is large; save it and filter with `jq`.
5. `get_job_logs` with `run_id` and `failed_only: true` (or one `job_id`) gives
   the Playwright output. Search it for `✘`, `##[error]` and `passed (`.

## Reading results

- **Web E2E** is the single required result: it fails if any selected job fails.
- Each job's step summary has a table of specs, seconds and exit status.
- Artifacts, kept 7 days:
  - `playwright-artifacts-<run>-<attempt>`: the merged HTML report and test
    results (traces, screenshots). Open `playwright-report/index.html`.
  - `playwright-spec-<run>-<attempt>-<group>-<provider>`: one job's blob report
    and screenshots.
- A failure is a real failure until a rerun of that job alone passes
  (`rerun_failed_jobs`). Rerun once at most, then root-cause it.

## Timings

Measured on 2026-10-16:

- Select and build: about 3 minutes (install 35 s, build 2 min).
- Each group job: about 1.5 minutes of setup, then its specs (1 to 4 minutes).
- Two `mail` specs on both providers: 4 jobs, about 6 minutes of work. That run
  took 16 minutes end to end because it waited 7 minutes for runners behind a
  full-suite run.
- Full suite: 32 jobs, 18.5 minutes end to end.

GitHub runs about 20 jobs at once for this account. Dispatch a small set
before, not alongside, a full-suite run when you need its answer fast.

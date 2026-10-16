# Dev infra plan: phases 2 and 3

Phase 1 (this branch) moved browser QA to GitHub Actions, made cloud sessions
start ready, turned AGENTS.md rules into hooks and fixed doc drift. This file
checks the claims behind the next two phases against the repository and lists
the decision each one needs from the founder.

Every item has: **verdict** on the claim, **evidence** (file:line, at the
branch point of this plan), **proposal**, and the **decision** with a
recommendation.

## Found while verifying (not in the original list)

### A. Unit tests, lint and the build check never run in CI on this fork

- **Verdict:** new finding.
- **Evidence:** `.github/workflows/test.yml:6-17` and
  `.github/workflows/build-check.yml` trigger only on push and pull request to
  `main`. This repository has no `main`; its default branch is the integration
  branch. The run history has no "Run Tests" or "Build Check" run at all.
  The same was true of `playwright.yml` (it ran only from its nightly
  schedule, twice, both red; see C).
- **Proposal:** add `workflow_dispatch` plus `push` on the integration branch
  and `pull_request` on any branch to `test.yml` and `build-check.yml`.
  The repository is public, so Actions minutes are free; nothing needs a
  secret (`test.yml` uses fixed test values only).
- **Decision:** turn them on? **Recommend yes.** Expect the first runs to be
  red where local-only checks drifted; that is the point. (Done; see the
  status table.)

### B. Two dispatches compete for runners

- **Evidence:** a full-suite dispatch takes 32 jobs; GitHub runs about 20 at
  once per account, so a small dispatch started at the same time waits for
  free runners.
- **Proposal:** none needed now; agents dispatch small sets first, or one at a
  time. Revisit if QA queues become a bottleneck (larger runners cost money).

### C. The nightly browser suite was already red before this work

- **Evidence:** Playwright run 2 (nightly, 2026-10-15) built and ran every
  group; 20 of 30 group jobs failed in `Run Playwright tests`, for example
  `mail/triage-actions.spec.ts:315` waiting for "1 selected" and `:157`
  waiting for the next conversation after delete. Those are spec or product
  assertions, not infrastructure.
- **Current head:** the first full-suite dispatch
  ([run 38867300934](https://github.com/gdavid7/Cue/actions/runs/38867300934),
  18.5 minutes) passed 26 of 32 jobs. These failed:
  - Google: `automation`, `connected-apps`, `mail`, `mail-desktop`,
    `mail-reader`.
  - Microsoft: `mail-triage`.

  The build, database and report steps passed in every job.
- **Proposal:** a QA engineer triages the six failing groups (product bug vs
  stale spec), group by group, using CI dispatch.
- **Decision:** none; this is ordinary engineering work for the coordinator to
  staff.

## Phase 2

### 1. Run an AI eval subset on changes to prompts or tools

- **Verdict:** verified that nothing runs evals automatically.
- **Evidence:**
  - `.github/workflows/ai-evals.yml:8-19` is `workflow_dispatch` only, with a
    free-text `test_filter`.
  - It needs the `OPENROUTER_API_KEY` repository secret
    (`ai-evals.yml:60-61`) and defaults to Claude Sonnet 4.5 through
    OpenRouter.
  - `apps/web/__tests__/eval/` has 56 eval test files with about 188 test
    declarations (many are `test.each` over scenarios); 36 files use an LLM
    judge.
  - Prompts and tools live in `apps/web/utils/ai/**` and
    `apps/web/utils/llms/**`. Eval files are named after the area they cover
    (`assistant-chat-*`, `analyze-document`, ...), which makes a path-to-eval
    map practical.
- **Cost per run (estimate, to be measured on the first run):** an assistant
  chat scenario sends a large system prompt with tool definitions, often over
  several turns, plus a judge call. At Sonnet-class prices that is roughly
  $0.05 to $0.20 per scenario. A focused subset of 20 to 40 scenarios is
  about **$2 to $8**; the whole eval directory is about **$20 to $60**, and
  `EVAL_MODELS=all` multiplies that by the number of models.
- **Proposal:**
  - A small map from prompt and tool paths to eval files, checked in next to
    the evals.
  - A workflow on `push`/`pull_request` (paths `utils/ai/**`,
    `utils/llms/**`) that runs only the mapped evals, with the default model
    only, a hard timeout, and a job summary of pass rates.
  - Skips cleanly when the secret is absent, so forks stay green.
  - Never runs on `pull_request` from forks (secrets are not passed there
    anyway).
- **Decision (2026-10-16):** OpenRouter declined. Built with direct Anthropic
  and Google keys instead; see "Eval subset" below. Full cross-model runs
  stay manual (`ai-evals.yml`).

### 2. `e2e-flows.yml` and the production robots

- **Verdict:** half right.
  - `e2e-flows.yml` does point at upstream: it runs the upstream maintainer's
    image `ghcr.io/elie222/inbox-zero:latest` (`e2e-flows.yml:4,33`) against
    real accounts and needs about 50 secrets (`e2e-flows.yml:94-156`). It is
    gated off by the `E2E_FLOWS_ENABLED` repository variable
    (`e2e-flows.yml:43-52`), so its scheduled runs finish in seconds and test
    nothing.
  - The **production robots are already this fork's**:
    `prod-health.yml:37` and `prod-journeys.yml:47` target this fork's own
    production URL, are restricted to this repository
    (`prod-health.yml:30`), and print counts only.
  - `build_and_publish_docker.yml` would publish an image under the upstream
    name pattern on push to `main` (`build_and_publish_docker.yml:5-8,44`); it
    never runs here.
- **Proposal:** retire `e2e-flows.yml` (and the upstream image path) rather
  than port it. The fork already has (a) emulated browser QA on every
  dispatch, with no secrets, and (b) production robots against the real
  deployment. Real-account flows against a third environment would need a
  second set of OAuth apps and mailboxes and add little coverage.
  Also disable or delete the other upstream-only workflows (`api-release`,
  `cli-release`, `desktop-release`, `mail-packages-release`,
  `deploy-image-proxy`, `build_and_publish_docker`, `build-changelog`,
  `publish-playwright-report`) so the Actions tab shows only what this fork
  uses.
- **Decision:** delete upstream-only workflows? **Recommend yes**, after a
  one-line confirmation that the fork will not publish packages, desktop
  builds or Docker images of its own.

### 3. `claude.yml` and `claude-code-review.yml`

- **Verdict:** verified stale.
  - Both pin `anthropics/claude-code-action` at a commit labelled `beta`
    (`claude.yml:35`, `claude-code-review.yml:34`).
  - Both grant read-only permissions: `contents: read`,
    `pull-requests: read`, `issues: read` (`claude.yml:21-26`,
    `claude-code-review.yml:20-24`), so `@claude` cannot push a fix or even
    comment.
  - Neither checks out with dependencies installed or sets allowed tools,
    so it cannot run tests (`claude.yml:28-37`).
  - They need an `ANTHROPIC_API_KEY` repository secret
    (`claude.yml:37`, `claude-code-review.yml:36`).
  - `claude.yml:8-9,19` also fires on any newly opened issue that mentions
    `@claude`. On a public repository that lets anyone start a paid run
    unless the action's own actor-permission check holds; the review
    workflow already limits itself to owners, members and collaborators
    (`claude-code-review.yml:16`).
- **Proposal:**
  - Update to the current stable `claude-code-action` major version, pinned
    by commit.
  - `contents: write`, `pull-requests: write`, `issues: write`.
  - Install with `pnpm install --frozen-lockfile` and allow the repository's
    own test, lint and `typecheck:web` commands.
  - Gate every trigger on `author_association` in OWNER, MEMBER,
    COLLABORATOR.
  - Have it read AGENTS.md (it does by default through CLAUDE.md).
  - Never give it deploy rights: no push to `production`; use branch
    protection on `production` to enforce that.
- **Decision:** add the `ANTHROPIC_API_KEY` repository secret and grant write
  permissions? **Recommend yes**, together with branch protection on
  `production` and the author-association gate, and a spend limit on the key.

## Phase 3

### 4. Issue forms with acceptance criteria

- **Verdict:** verified missing: `.github/` has only `workflows/` and
  `screenshots/`; there is no `ISSUE_TEMPLATE/`.
- **Proposal:** two forms, `bug.yml` (steps, expected, actual, affected
  provider, severity) and `feature.yml` (problem, user, acceptance criteria as
  a checklist, out of scope), plus `config.yml` turning off blank issues and
  pointing security reports to private vulnerability reporting.
  The forms must warn reporters not to paste email content or addresses,
  since issues are public.
- **Decision:** none needed beyond review of the wording; low risk.

### 5. Triage and plan stages

- **Verdict:** the stages exist in `.claude/skills/agent-team/SKILL.md`
  (engineering-manager plan, reviewer GO/NO-GO, QA, deploy) but have no
  tracker state: nothing marks an issue as triaged, planned or ready.
- **Proposal:** labels as states (`needs-triage` → `planned` → `in-progress`
  → `in-qa` → `shipped`), applied by the coordinator. The EM's plan is
  posted as an issue comment (public-safe) with acceptance tests copied
  from the issue form. A status report reads labels instead of
  reconstructing state from branches.
- **Decision:** use GitHub issues as the public backlog for product work?
  **Recommend yes for product work only** (see 7 for errors).

### 6. CODEOWNERS and an auto-merge policy

- **Verdict:** verified missing: no `CODEOWNERS` anywhere in the repository.
- **Proposal:**
  - `CODEOWNERS` with the founder on the founder-gated areas from
    `agent-team/SKILL.md`: `apps/web/utils/ai/**` (prompts and tools),
    `apps/web/env.ts`, `.github/workflows/**`, `.claude/settings.json`,
    `apps/web/prisma/**`, pricing and landing copy.
  - Auto-merge allowed for everything else when CI (tests, browser QA on
    the affected groups, Agent tooling) is green and an independent
    reviewer agent says GO.
  - `production` stays a manual, tested-sha push.
- **Decision:** which paths always need the founder, and may agents
  auto-merge the rest? **Recommend the list above, and yes to auto-merge
  outside it**, but only once item A (tests in CI) is on.

### 7. Production errors become private tickets

- **Verdict:** agreed by the founder; verified that nothing turns errors into
  public issues today.
  - The only workflow with `issues: write` is the upstream report publisher
    (`publish-playwright-report.yml:11`), which never runs here.
  - The robots already digest Axiom logs and Sentry issues and print counts
    only (`prod-health.yml:3-9`, `apps/web/__tests__/playwright/prod/README.md:4-5`).
- **Proposal:** use **Sentry issues** as the private ticket queue. They are
  already grouped, deduplicated, and access-controlled, and the robots already
  read them. Add a Sentry alert rule (new issue or regression) that notifies
  the coordinator. Have the coordinator's loop file a public GitHub issue only
  after rewriting the error into a scrubbed description (no addresses,
  subjects, message bodies or tokens), linking back to the Sentry issue by ID.
  If a dedicated tracker is wanted later, Sentry's built-in Linear integration
  keeps the ticket private.
- **Decision:** Sentry as the private queue, or a separate private tracker?
  **Recommend Sentry**: no new service, no new data flow.

### 8. Smaller PRs: a middle path

- **Verdict:** verified that work is batched: engineers' branches merge into
  one integration branch, which is pushed to the default branch and QA'd as a
  release candidate (`agent-team/SKILL.md`, "Release pipeline" steps 3-6).
  The batching existed because browser QA needed the shared machine, one run
  at a time.
- **Proposal:** keep the integration branch as the release train, but give
  each workstream its own PR into it.
  - Each PR gets CI unit tests (item A) and CI browser QA on the groups it
    touches (`playwright.yml` already selects changed specs for pull
    requests).
  - The reviewer agent's GO goes on the PR.
  - Merging is a PR merge, not a local merge, so history shows what shipped
    together and why.
  - Releases stay batched: the coordinator QA's the integration head once
    (full suite in CI, about 20 minutes) and pushes that sha to `production`.
  - The one cost: a PR's `pull_request` trigger must also accept the
    integration branch as a base. That is a one-line change to
    `playwright.yml`, `test.yml` and `build-check.yml` (today they accept
    only `main`).
- **Decision:** move from local merges to PRs into the integration branch?
  **Recommend yes**, starting with the next workstream, once item A is on.

## Founder decisions and status

Decided 2026-10-16.

| # | Decision | Status |
|---|---|---|
| A | Run unit tests, lint and build check in CI | **Done and green** (existing failures fixed, below). `test.yml` and `build-check.yml` run on pushes and pull requests to the integration branch, `production` and `claude/**`, and on dispatch |
| 1 | Eval subset on prompt, tool or eval changes | **Built, waiting on keys.** OpenRouter declined; Claude under test with `ANTHROPIC_API_KEY`, Gemini as judge with `GOOGLE_API_KEY`. See "Eval subset" below |
| 2 | Delete upstream-only workflows | **Done.** Removed `e2e-flows`, `api-release`, `cli-release`, `desktop-release`, `mail-packages-release`, `deploy-image-proxy`, `build_and_publish_docker`, `publish-playwright-report` (and its script). `build-changelog` stays: it validates, it doesn't publish |
| 3 | `@claude` pushing fixes (key and write permissions) | **Deferred.** Only the trigger restriction is done: every `claude.yml` trigger requires an OWNER, MEMBER or COLLABORATOR author |
| 5 | GitHub issues for product work only | **Yes**, conventions below |
| 6 | CODEOWNERS; auto-merge outside founder-owned paths | **CODEOWNERS added** (`.github/CODEOWNERS`). Auto-merge is **not enabled**; steps below |
| 7 | Production errors stay in Sentry | **Yes**, conventions below |
| 8 | Small PRs into the integration branch | **Yes**, conventions below |

## First CI results (2026-10-16)

The first runs on this fork were red on failures that already existed on the
integration branch. All are fixed on this branch; Run Tests and Build Check
are green on `2917795a`:
[Run Tests](https://github.com/gdavid7/Cue/actions/runs/38923831576),
[Build Check](https://github.com/gdavid7/Cue/actions/runs/38923830642).

- **Integration tests (16 failing in 6 files): test setup, no product bug.**
  - Mail-engine slices: the Gmail harness pointed only the client at the
    emulator, so batch reads (`GOOGLE_BASE_URL`, fixed at import) hit real
    Gmail with the emulator token (401). The sync budget also fails closed
    without Redis, which these tests don't run. The harness now redirects
    batch fetches to its emulator; the slices run the budget as a
    pass-through.
  - Todoist: the Prisma mock lacked `mcpConnection.findMany`, now used by
    `findConnectionAccountId`.
  - Stats: pagination now hydrates a page in one batch request; the test
    expected none and now expects exactly that one.
  - Slack: assertions hardcoded "Inbox Zero"; they use `BRAND_NAME` (Cue).
  - Custom MCP: the test's fake Prisma didn't understand the
    `ownedBySameUser` filter the queries moved to.
- **Unit shard 2:** `use-combined-mail-threads.test.tsx` never unmounted its
  hooks (Vitest globals are off, so Testing Library's auto-cleanup never
  registers), and a render ran after teardown. It now cleans up and asserts
  no subscription outlives a test.
- **Bundle budget:** `/login` first-load JS had grown from 554 KB gzip (when
  the budget was set) to 607 KB, against 585. Turbopack's bundle analysis
  put 45.6 KB of that in `tldts` (the public suffix list), pulled in by
  `ConnectorLogo`'s favicon fallback on the new landing sections. Connector
  domains no longer go through the apex lookup: `/login` is 562 KB, and
  mail, Today and Settings dropped about 45 KB each.

## Eval subset (decision 1)

`.github/workflows/eval-subset.yml` runs a small AI eval subset with one model.

**When it runs:**
- On pushes and pull requests that touch `apps/web/utils/ai/**`,
  `apps/web/utils/llms/**` (non-test files) or `apps/web/__tests__/eval/**`.
- Only for this repository's collaborators. A push needs write access; a pull
  request must come from a branch in this repository (never a fork) by an
  OWNER, MEMBER or COLLABORATOR. It never uses `pull_request_target`.
- Also by dispatch, with an optional list of extra eval files.

**What it runs:**
- Three default evals: `choose-rule`, `prompt-security-core-paths` and
  `assistant-chat-core-tools`, 62 cases in all.
- Plus any eval file the change adds or edits, capped at 6 files per run.
- The model under test is `anthropic:claude-sonnet-5-5`; the judge is Gemini
  (`gemini-3-flash`). The report is uploaded as an artifact.

**Cost:** an estimate of **about $2 to $6 per run**, from the repository's
pricing table (Sonnet 5.5 at $2 / $10 per million input / output tokens,
Gemini 3 Flash judge at $0.50 / $3). Multi-turn assistant cases cost the
most. Measure it on the first run.

**Without keys** the first step fails with the names of the missing secrets
and nothing else. This matters because the evals skip silently, and read as
green, when no key is set.

**For the founder:**
1. Add two repository secrets under **Settings → Secrets and variables →
   Actions → New repository secret**: `ANTHROPIC_API_KEY` and
   `GOOGLE_API_KEY`.
2. Set a monthly spend limit for that key's workspace in the Anthropic
   console, and a budget alert for the Google key in Google Cloud.
3. Dispatch "Eval Subset" once on the integration branch to measure the cost
   and pass rate before relying on it.

## Conventions (also in AGENTS.md)

**Issues (5).** GitHub issues track product work only: features, bugs found
in development, chores. The repository is public, so an issue never contains
user data: no email addresses, names, subjects, message bodies, tokens, log
lines or screenshots of real inboxes. Reproduce with fixture data instead.

**Production errors (7).** Production errors stay in Sentry, which is private,
grouped and already read by the production robots. When an error needs code
work, the issue describes the failure in general terms and cites the Sentry
issue ID, never the event payload.

**PRs and releases (8).** Each workstream opens a small PR into the
integration branch (`claude/upbeat-sagan-6c5ed8`).
- CI runs on every PR: unit tests, lint, package type checks and the
  production build.
- Browser QA is dispatched for the groups the PR touches.
- An independent reviewer's GO goes on the PR.
- Merge with a merge commit, so the integration history records what landed
  together.

Releases stay batched: the coordinator runs browser QA on the integration
head and pushes that exact sha to `production`. Nothing merges into
`production` through a PR.

## Turning on auto-merge (not done; for the founder)

These are repository settings; nothing in this branch changes them.

1. **Settings → General → Pull Requests:** enable "Allow auto-merge" and
   "Always suggest updating pull request branches".
2. **Settings → Branches → Add branch ruleset** for the integration branch:
   - require a pull request before merging, with 1 approval;
   - require review from Code Owners (this makes `.github/CODEOWNERS`
     binding);
   - require status checks to pass, with these checks: `Tests 1/2`,
     `Tests 2/2`, `Electron mail runtime` (Run Tests) and `build` (Build
     Check);
   - block force pushes.
3. **A second ruleset for `production`:** restrict pushes to the founder and
   the coordinator's identity and block force pushes. Releases remain a
   direct push of a tested sha.
4. **Per PR:** an agent enables auto-merge (`gh pr merge --auto --merge`)
   only after the reviewer's GO. GitHub then merges once checks pass, and
   waits for the founder when the PR touches a founder-owned path.

## Stop hook (built)

`.claude/hooks/stop-related-tests.sh` runs `vitest related --run` on the
`apps/web` files changed since the last commit when an agent ends a turn.
- Failures go back to the agent once; the next stop always ends the turn.
- It skips Playwright, E2E, eval and AI test files.
- Capped at 60 seconds, and a timeout never blocks.

Measured: about 20 seconds for a small change (Vitest start-up dominates). A
change to a widely imported module, such as provider retry, hits the cap, so
that case falls back to CI. The type check (about 2.5 minutes) stays in CI and
in `pnpm typecheck:web`.

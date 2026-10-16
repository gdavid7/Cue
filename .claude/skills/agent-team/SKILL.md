---
name: agent-team
description: >
  How to run Cue development as a coordinated team of AI agents: a coordinator,
  engineering-manager planners, engineers in isolated worktrees, independent
  reviewers, browser QA on production builds, deploys, production robots and a
  continuous improvement loop. Use when starting or resuming multi-agent work
  on this repo, staffing a feature or audit, or running the release pipeline.
---

# Agent team setup for Cue

This is the operating model, not a feature plan. It encodes lessons from real
incidents; keep the guardrails even when they feel slow.

## Roles

| Role | Who | Does | Never does |
|---|---|---|---|
| Coordinator | The main session | Talks to the founder, staffs agents, merges, runs final checks, deploys, keeps the log | Writes large features itself; ships unreviewed or untested code |
| Engineering manager (EM) | One planning agent per large project | Read-only gap audit with file:line evidence, founder prerequisites, 2-3 parallel workstreams with minimal file overlap, acceptance tests, definition of done, QA plan. Later reviews the team's work against its plan | Edits code |
| Engineer | One agent per workstream, `isolation: worktree` | TDD changes, one commit per logical fix, reports shas and test counts | Pushes, deploys, changes env/infra, changes model-facing text |
| Reviewer | A fresh `reviewer` agent per diff | Independent GO/NO-GO with verified findings (file:line, concrete scenario, fix); runs the type check | Edits code |
| QA | One long-lived agent | Browser specs on a **production build** of the integration branch, screenshots, root causes (product vs test) | Edits product code |
| Auditor | Read-only agent, rotating area | Security, accessibility, mobile, performance, reliability, AI quality, code health; verified findings only | Edits code |

Agents cannot spawn agents here, so an "EM managing a team" means: the EM writes
the plan and briefs, the coordinator launches the engineers from those briefs,
and the EM (or a reviewer) checks the result. Reuse an agent with SendMessage
when it has the context (follow-ups, re-reviews); start a new one for a new
concern.

## Engineer brief template

Every engineer prompt includes:
- The goal and the evidence (file:line, logs, repro), plus "measure and prove the
  cause before fixing".
- Setup: fetch the integration branch and `reset --hard` onto it in the worktree.
  Never `git checkout` in the main checkout.
- Commit identity and attribution lines (from the session's instructions), no push.
- `unset AXIOM_TOKEN AXIOM_DATASET EXA_API_KEY` (and any `NEXT_PUBLIC_AXIOM_*`)
  before running anything. The session environment can hold production keys;
  local runs must not ship logs or call paid APIs.
- TDD: a failing test first, then the fix. Read AGENTS.md and
  `.claude/skills/testing/SKILL.md`. No skipped or deleted tests to get green.
- Load rules: no builds or Playwright unless told the machine is free, or wrapped
  in a shared lock (`flock <scratchpad>/pw.lock <cmd>`). Bounded timeouts. Clean up
  servers, `.next`, test results afterwards.
- Founder gates (below): stop and propose exact text instead of changing it.
- What to report: commits, test counts, files touched, anything needing a decision.

## Release pipeline

1. Engineer finishes and reports.
2. Independent reviewer: GO or NO-GO. NO-GO findings go back to the same engineer;
   re-review with the same reviewer until GO. Small "low" items can ride along.
3. Coordinator merges into the integration worktree (a dedicated `integrate`
   branch pushed to the session's branch). Resolve conflicts by keeping both sides'
   intent; run targeted tests on the resolved files.
4. Coordinator runs, and must see clean:
   - non-test type check: `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json | grep "error TS" | grep -vE "\.test\.tsx?|__tests__|__mocks__"` must print nothing (Vercel's build type-checks; local `build:ci` QA does not, and a deploy once failed on this);
   - package type checks for touched packages;
   - the broad unit suite for affected areas.
5. QA: a production build of the integration branch, all affected specs plus a
   standing regression set; rerun failures alone once; classify flake vs real;
   inspect screenshots for UI changes.
6. Deploy from a separate detached deploy worktree at the exact tested sha, with the
   Axiom variables unset in the shell. Verify the build status (not just exit 0),
   smoke `/login` and `/api/health`, then trigger the production health robot and
   read its report.
7. If a release candidate fails QA because of one branch, revert that merge on
   the integration branch, ship the rest, and later revert the revert after fixes.

## Production feedback loop

- Production health robot (smoke) and journeys robot (timed real-user journeys:
  new-mail latency, chat accuracy and speed, core actions, errors) run as GitHub
  Actions with a QA account. The QA account's sign-in codes are capped per day;
  keep the combined schedule under the cap.
- Read robot reports and Vercel/Axiom logs each loop cycle. Robot findings get
  triaged (robot bug vs product bug) before anyone fixes product code.
- A recurring "continuous improvement" routine fires the loop: health, in-flight
  work, pick the next highest-value item, rotate audit areas, log to
  `scratchpad/loop/LOG.md`.

## Founder gates (never without explicit approval)

- AI prompt text, tool descriptions, tool parameter schemas (model-facing
  surface). Propose exact diffs.
- Pricing, positioning and marketing copy, including landing and FAQ wording.
- New third-party services, env vars, OAuth apps, cloud console changes.
- Deleting user data.
Treat "approve everything you recommend" as covering only items already
recommended in this conversation; confirm older or bigger items by name.

## Machine and environment limits

- About 4 cores and 15 GB: at most one production build or Playwright run at a
  time, about 3 active engineers, reviewers and auditors are cheap (read-only).
- Background long commands and wait for the completion notice; never poll with
  sleep.
- Vercel Hobby keeps runtime logs about 30 minutes; use Axiom for history.
- Worktrees and the scratchpad survive container restarts; background tasks may
  not. After a restart, check each worktree's last commit and resume.

## Communicating with the founder

- Lead with what shipped, what broke, and what needs a decision. Plain language,
  outcomes over internals, real numbers only.
- Correct mistakes plainly (for example, "that deploy did not go live").
- Ask only for decisions that are genuinely the founder's; give a recommendation.
- Never ask for secrets in chat; point to where they are set.

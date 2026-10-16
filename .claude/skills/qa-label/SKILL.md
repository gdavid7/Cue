---
name: qa-label
description: Label a PR ready-for-qa so a QA server runs browser tests on it. Use only where that QA server exists; for this fork, dispatch CI browser QA instead (docs/dev-infra/ci-browser-qa.md).
---

To mark a PR ready for QA, run: `gh pr edit <PR_NUMBER> --add-label "ready-for-qa"`

An automated QA process on the QA server will pick it up within ~60s and run browser tests against the PR branch. New pushes retrigger automatically while the label is present.

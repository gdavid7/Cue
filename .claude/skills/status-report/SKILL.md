---
name: status-report
description: >
  Answer "what's the status?" for Cue in three fixed sections: what most
  recently shipped to production, what is being worked on right now, and what
  is queued. Use whenever the founder asks for the status, an update, "where
  are we", or what is shipped, in progress or queued.
---

# Status report

The founder wants the same three sections every time, in plain language,
built from evidence rather than memory.

## Gather first (do not answer from memory)

1. **Production.** List recent production deployments and their commits:
   - `vercel ls --prod` for the deployments, and `vercel inspect <url>` for
     status and alias.
   - Check each deployment's source and commit (Vercel API `meta.githubCommitSha`, or the deployment's git source). The production branch is `production`, so what's live is that branch's head unless a CLI redeploy happened since.
   - Map each deployed commit to what it contained with `git log` on the
     integration branch.
   - Note anything deployed without code changes, such as a redeploy for an
     environment variable.
2. **In progress.**
   - Running and recently finished agents: background task notifications and
     agent hand-backs in this session, and `ListAgents` if available.
   - The integration worktree's unmerged branches.
   - Anything in browser QA or review, with its stage (building, review,
     fixing review findings, QA, ready to merge).
3. **Queue.**
   - The coordinator's running log, for example `scratchpad/loop/LOG.md` in
     the session that has it. Use `QUEUED` and `FOUNDER` entries.
   - Plan documents the session created, such as a multi-account plan or an
     Outlook plan.
   - Approved but unstarted work.
4. **Health, briefly.** One line from production logs (Axiom or Vercel) if
   something is currently broken. Skip it when everything is clean.

If a source is unavailable, for example in a new session without the old
scratchpad, say what you could not check instead of guessing.

## Answer format

Use exactly these headings, in this order:

### ✅ Shipped to production (most recent first)
A table: when (UTC, plus the founder's local time if known) | what shipped,
in user-facing terms. Only include what is actually live. A merged branch
that has not been deployed does not belong here.

### 🔨 Being worked on now
A table: workstream | what it does for the user | stage. Group finished but
undeployed work under a short "Done, waiting to ship" line, naming the
release it will ride in.

### 📋 Queued
A numbered list in the order it will start, each with one line on what it
is, and what it waits on if it is blocked.

Then, only if non-empty:

### ⏳ Waiting on you
Founder decisions or actions, each with a recommendation, marked urgent or
not.

## Style

- Outcomes over internals: "new mail shows within 2 s", not "SSE hint
  publish". Real numbers only.
- Don't repeat full histories. One line per item, details only if asked.
- Correct mistakes plainly, for example "that deploy did not go live".
- Never include secrets, tokens or private user data.

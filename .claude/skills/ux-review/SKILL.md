---
name: ux-review
description: >
  UI/UX review panel with 10 design experts (Rams, Ive, Norman, Nielsen,
  Wroblewski, Krug, Au, Garrett, Hall, Levey). Spawns parallel sub-agents,
  synthesizes and deduplicates findings.
  Use when asked to "review UX", "UX audit", "design review", "polish the UI",
  or "streamline the interface".
argument-hint: "[optional: page, component, or scope to review]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Task, Bash, Edit, Write
---

# UX Review — 10-Expert Panel

Perform a comprehensive UI/UX review by spawning 10 parallel sub-agents, each embodying a world-class design expert. Each expert independently reviews the codebase through their unique lens, then findings are synthesized into a prioritized action plan.

## Constraints

- DO NOT change the color palette, font choices, or overall visual identity
- DO NOT introduce new CSS frameworks or design systems
- DO NOT add animations or motion unless explicitly requested
- Focus on streamlining: remove clutter, improve hierarchy, fix inconsistencies
- All suggestions must work in both light and dark mode
- Changes must be responsive (mobile, tablet, laptop)

## Workflow

Read `references/workflow.md` for the full detailed workflow. Below is a summary of each step.

### Step 1: Determine Scope

**Scope-first architecture** — minimize token cost by reviewing only what matters.

1. If the user specified a scope (e.g., "review the blog page"), use only those files
2. If `$ARGUMENTS` provides a scope, use that
3. Otherwise, check for recently changed files: run `git diff --name-only HEAD~5` to find UI files modified recently
4. If no changes found, ask the user which pages or components to review
5. Never scan the entire codebase by default

### Step 2: Identify UI Files

Identify the project's UI framework and file conventions by reading the project structure. Use simple file globbing to find relevant files:

- Look for common patterns: `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.erb`, `*.html`, `*.css`
- Read the project's package.json, Gemfile, or equivalent to understand the tech stack
- Read all UI source files within the determined scope
- Store the full content — this will be passed to each expert agent

### Step 3: Launch Expert Sub-Agents

Read `references/workflow.md` for the complete agent prompts and spawn instructions.

**Round 1** — Spawn 7 agents in parallel using the Task tool:
1. Dieter Rams (references/dieter-rams.md)
2. Jony Ive (references/jony-ive.md)
3. Don Norman (references/don-norman.md)
4. Jakob Nielsen (references/jakob-nielsen.md)
5. Luke Wroblewski (references/luke-wroblewski.md)
6. Steve Krug (references/steve-krug.md)
7. Irene Au (references/irene-au.md)

**Round 2** — After Round 1 completes, spawn 3 more agents in parallel:
8. Jesse James Garrett (references/jesse-james-garrett.md)
9. Erika Hall (references/erika-hall.md)
10. Yael Levey (references/yael-levey.md)

**Partial failure handling:** Proceed with synthesis if at least 5 of 10 experts complete successfully. Note any failed experts in the final report.

### Step 4: Synthesize Findings

After all expert agents complete:

1. Collect all findings from every expert
2. Deduplicate — findings raised by multiple experts carry more weight
3. For each finding, note which experts flagged it (e.g., "Rams, Ive, Krug")
4. Categorize by impact:
   - **High** — Hurts usability or readability (flagged by 3+ experts, or any Norman/Nielsen/Krug core violation)
   - **Medium** — Inconsistency that feels unpolished (flagged by 2+ experts, or Rams/Au/Ive precision issues)
   - **Low** — Minor refinement (single expert, edge case, or nice-to-have)
5. Sort within each category by effort (quick wins first)

### Step 5: Present Report

```markdown
## UX Review — Expert Panel Findings

### High Impact
| # | Issue | Expert(s) | Location | Fix |
|---|-------|-----------|----------|-----|

### Medium Impact
| # | Issue | Expert(s) | Location | Fix |
|---|-------|-----------|----------|-----|

### Low Impact
| # | Issue | Expert(s) | Location | Fix |
|---|-------|-----------|----------|-----|

### Expert Consensus
[Note any themes that 5+ experts independently raised — these are the most important findings]

### Experts Completed
[List which experts completed successfully and which failed, if any]
```

### Step 6: Ask What to Fix

If running interactively (no `$ARGUMENTS` specifying fix scope):
- Ask the user: "Which findings should I fix?"
- Options: "All high impact", "All high + medium", "Everything", "Let me pick specific ones"

If `$ARGUMENTS` specifies a fix scope (e.g., "fix all high impact"), proceed automatically.

### Step 7: Apply Fixes

For selected findings:
1. Make changes following existing code patterns and the project's framework conventions
2. Verify the project builds after each batch of fixes
3. Test in dev server if available
4. Commit changes when complete

## Success Criteria

- All fixes work in both light and dark mode
- Responsive at 360px, 768px, 1024px+
- No visual theme or color palette changes
- Project builds successfully
- Linting passes

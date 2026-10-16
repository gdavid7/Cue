#!/usr/bin/env node
// PreToolUse guard for Bash: blocks commands AGENTS.md rules out.
import { readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
// Quoted text (commit messages, echo, grep patterns) is data, not a command to judge.
const command = (input.tool_input?.command ?? "").replace(
  /'[^']*'|"(?:[^"\\]|\\.)*"/g,
  "''",
);
const reason = getDenyReason(command, input.cwd ?? "");

if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

function getDenyReason(command, cwd) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? "";
  const atRoot =
    projectDir && path.resolve(cwd) === path.resolve(projectDir);
  const typeChecksRoot = command
    .split(/&&|\|\||;|\|/)
    .some(
      (segment) =>
        /\btsc\b/.test(segment) &&
        /--noEmit\b/.test(segment) &&
        // A project flag is fine unless it names the root config itself.
        (!/(^|\s)(-p|--project)(\s|=)/.test(segment) ||
          /(^|\s)(-p|--project)(\s+|=)(\.\/?|(\.\/)?tsconfig\.json)(\s|$)/.test(
            segment,
          )),
    );
  if (atRoot && typeChecksRoot && !/\bcd\s/.test(command)) {
    return 'Root `tsc --noEmit` is not a supported check here (AGENTS.md). Use `pnpm typecheck:web` for the non-test type check Vercel enforces, or `pnpm --filter inbox-zero-ai build:ci` only when asked.';
  }
  if (
    /\b(grep|rg)\b[^|\n]*__tests__\/playwright[^|\n]*\|\s*head\b/.test(command)
  ) {
    return "Don't pipe a grep of __tests__/playwright through head: a truncated list read as complete misses call sites (AGENTS.md). Run the grep without head, or use -l / -c to keep it short.";
  }
  return undefined;
}

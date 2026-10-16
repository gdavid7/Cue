#!/usr/bin/env node
// Fails when a Markdown link inside .claude/skills points at a file that doesn't exist.
// Relative links resolve from the linking file; `mdc:` links (Cursor style) from the repo root.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillsDir = path.join(repoRoot, ".claude/skills");
const broken = [];

for (const file of listMarkdown(skillsDir)) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const [, target] of line.matchAll(/\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
      const resolved = resolveLink(target, file);
      if (resolved && !existsSync(resolved)) {
        broken.push(
          `${path.relative(repoRoot, file)}:${index + 1}: ${target}`,
        );
      }
    }
  });
}

if (broken.length) {
  console.error(`Broken links in .claude/skills:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("All .claude/skills links resolve.");

function resolveLink(target, fromFile) {
  if (/^(https?:|mailto:|#)/.test(target)) return ;
  const filePart = decodeURIComponent(target.split("#")[0]);
  if (!filePart) return ;
  if (filePart.startsWith("mdc:")) {
    return path.join(repoRoot, filePart.slice("mdc:".length));
  }
  if (path.isAbsolute(filePart)) return ;
  return path.resolve(path.dirname(fromFile), filePart);
}

function listMarkdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name);
    // Skills are real directories; skip anything vendored under node_modules.
    if (name === "node_modules") return [];
    if (statSync(entry).isDirectory()) return listMarkdown(entry);
    return /\.mdx?$/.test(name) ? [entry] : [];
  });
}

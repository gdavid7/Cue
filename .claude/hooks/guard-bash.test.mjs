import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const specs = "apps/web/__tests__/playwright";

test("denies a root tsc --noEmit but allows a project type check", () => {
  assert.equal(isDenied("pnpm exec tsc --noEmit"), true);
  assert.equal(isDenied("npx tsc --noEmit"), true);
  assert.equal(isDenied("pnpm exec tsc --noEmit -p ."), true);
  assert.equal(isDenied("npx tsc --noEmit --project=tsconfig.json"), true);
  assert.equal(
    isDenied("pnpm exec tsc --noEmit -p apps/web/tsconfig.json"),
    false,
  );
  assert.equal(
    isDenied("cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json"),
    false,
  );
  assert.equal(
    isDenied("pnpm exec tsc --noEmit", path.join(root, "apps/web")),
    false,
  );
});

test("denies a Playwright grep cut short by head, nothing else", () => {
  assert.equal(isDenied(`grep -rn Archive ${specs} | head -20`), true);
  assert.equal(isDenied(`rg "Archive all" ${specs} | head`), true);
  assert.equal(isDenied(`grep -rn Archive ${specs}`), false);
  assert.equal(isDenied(`grep -rln Archive ${specs} | wc -l`), false);
  assert.equal(isDenied("grep -rn Archive apps/web | head"), false);
});

test("ignores the rules' words inside quoted text and other lines", () => {
  assert.equal(
    isDenied(`git commit -m "Deny tsc --noEmit and grep ${specs} | head"`),
    false,
  );
  assert.equal(isDenied(`cat <<'X'\ngrep ${specs}\nX\ngit diff | head`), false);
});

function isDenied(command, cwd = root) {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "guard-bash.mjs")],
    {
      input: JSON.stringify({ tool_input: { command }, cwd }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.includes('"permissionDecision":"deny"');
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(import.meta.dirname, "..");

// Vercel rejects the whole deployment when vercel.json breaks its schema, and
// no other check sees that before production does.
describe("vercel.json", () => {
  const config = JSON.parse(
    readFileSync(path.join(webRoot, "vercel.json"), "utf8"),
  ) as {
    buildCommand?: string;
    installCommand?: string;
    ignoreCommand?: string;
  };

  it("keeps commands within Vercel's 256-character limit", () => {
    for (const command of [
      config.buildCommand,
      config.installCommand,
      config.ignoreCommand,
    ]) {
      if (command) expect(command.length).toBeLessThanOrEqual(256);
    }
  });

  it("points script commands at files that exist", () => {
    for (const command of [config.buildCommand, config.ignoreCommand]) {
      const script = command?.match(/^bash (\S+)$/)?.[1];
      if (script) expect(existsSync(path.join(webRoot, script))).toBe(true);
    }
  });

  it("leaves the type check to CI", () => {
    const script = readFileSync(
      path.join(webRoot, "scripts/vercel-build.sh"),
      "utf8",
    );
    expect(script).toMatch(/^export SKIP_TYPE_CHECK=true$/m);
  });

  it("builds one package at a time", () => {
    const script = readFileSync(
      path.join(webRoot, "scripts/vercel-build.sh"),
      "utf8",
    );
    const builds = script.match(/turbo run build[^\n]*/g) ?? [];
    expect(builds.length).toBeGreaterThan(0);
    for (const build of builds) expect(build).toContain("--concurrency=1");
  });
});

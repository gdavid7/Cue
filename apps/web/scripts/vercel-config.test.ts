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
    crons?: { path: string; schedule: string }[];
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

  it("points every cron at a route that exists", () => {
    for (const cron of config.crons ?? []) {
      expect(
        existsSync(path.join(webRoot, "app", cron.path, "route.ts")),
        cron.path,
      ).toBe(true);
    }
  });

  // Send later, snooze wake-ups, server-held undo sends and scheduled
  // check-ins have no other scheduler when QStash is off, so they are only as
  // punctual as these crons. The interval is a cost choice; a daily schedule
  // here is the regression.
  it("runs the crons behind user-timed actions at least every 10 minutes", () => {
    for (const timedPath of [
      "/api/cron/scheduled-actions",
      "/api/cron/automation-jobs",
    ]) {
      const schedule = config.crons?.find(
        (cron) => cron.path === timedPath,
      )?.schedule;
      const [minute, ...rest] = schedule?.split(" ") ?? [];
      expect(rest, timedPath).toEqual(["*", "*", "*", "*"]);
      const everyMinutes =
        minute === "*" ? 1 : Number(minute.match(/^\*\/(\d+)$/)?.[1]);
      expect(everyMinutes, timedPath).toBeLessThanOrEqual(10);
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

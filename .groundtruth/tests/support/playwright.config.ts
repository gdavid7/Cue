// Groundtruth's Playwright settings. Synced into .groundtruth/tests/support/ by Groundtruth; edits there are
// overwritten. The app's own .groundtruth/playwright.config.ts re-exports this, and may extend it.
// The app must already be running (Groundtruth starts it from app.yml); tests never start it.
// GROUNDTRUTH_VIDEO picks the video mode: "on" (default: every test filmed, each proof held on screen),
// "failures" (only failing tests keep a video; passing ones skip the hold, ~10x faster), or "off".
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const app = JSON.parse(fs.readFileSync(path.join(__dirname, "app.json"), "utf8"));
const VIDEO = { on: "on", failures: "retain-on-failure", off: "off" } as const;
const mode = VIDEO[(process.env.GROUNDTRUTH_VIDEO ?? "on") as keyof typeof VIDEO] ?? "on";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./results",
  globalSetup: "./tests/support/app-running.ts",
  workers: 1, // one app with one set of data: tests can't share it in parallel
  use: {
    baseURL: `http://localhost:${app.port}`,
    viewport: { width: 1280, height: 720 },
    video: {
      mode,
      size: { width: 1280, height: 720 },
      // Click marks only: check() shows the claim, so Playwright's own test-title banner stays off. When every
      // test is filmed, the helper draws a cursor that glides to each click, so Playwright's own cursor (which
      // jumps) is off; in regression runs (no glide) it stays on, so a failure's clip still shows the clicks.
      show: { actions: { cursor: mode === "on" ? "none" : "pointer", duration: 500 } },
    },
  },
});

import { defineConfig, devices } from "@playwright/test";

// The journeys robot against production (or CUE_QA_BASE_URL) as the QA
// account. The same spec runs on the local emulated stack with
// `playwright.emulated.config.mjs` next to this file.
const baseURL = process.env.CUE_QA_BASE_URL || "https://cue-inbox.vercel.app";

export default defineConfig({
  testDir: ".",
  testMatch: "*.journey.ts",
  outputDir:
    process.env.CUE_JOURNEYS_OUTPUT_DIR || "../../../../.tmp/journeys/output",
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  // Each journey retries itself once inside the run; a Playwright retry would
  // sign in again, and code sign-ins are capped per day.
  retries: 0,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ...(process.env.CI ? [["github"] as const] : []),
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder:
          process.env.CUE_JOURNEYS_REPORT_DIR ||
          "../../../../.tmp/journeys/report",
      },
    ],
  ],
  projects: [
    {
      name: "journeys-production",
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        actionTimeout: 30_000,
        navigationTimeout: 60_000,
        // Playwright cannot see requests a service worker makes, and the
        // compose journey's recipient guard must see every write.
        serviceWorkers: "block",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
      },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

// The production robot: no web server, no emulators, one signed-in QA account.
// Point CUE_QA_BASE_URL at another deployment (a preview, or a local server
// whose QA account can receive sign-in codes over IMAP) to run it elsewhere.
const baseURL = process.env.CUE_QA_BASE_URL || "https://cue-inbox.vercel.app";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: process.env.CUE_QA_OUTPUT_DIR || "../../../.tmp/qa-robot/output",
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  // A retry would sign in again and send another probe; the next hourly run
  // is the retry.
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ...(process.env.CI ? [["github"] as const] : []),
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder:
          process.env.CUE_QA_REPORT_DIR || "../../../.tmp/qa-robot/report",
      },
    ],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // Playwright cannot see requests a service worker makes, and the reply
    // step's recipient guard must see every write.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});

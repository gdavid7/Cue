import path from "node:path";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../../../playwright.config.mjs";

// The journeys robot against the local emulated stack (Gmail and LLM
// emulators, a local Next server), to check the journeys' logic without
// production. Run from apps/web:
//   pnpm exec playwright test -c __tests__/playwright/prod/journeys/playwright.emulated.config.mjs
export default defineConfig({
  ...baseConfig,
  outputDir:
    process.env.CUE_JOURNEYS_OUTPUT_DIR ?? ".tmp/journeys/emulated-output",
  testDir: path.resolve("__tests__/playwright"),
  projects: [
    baseConfig.projects[0],
    {
      name: "journeys-emulated",
      dependencies: ["emulated-setup"],
      testDir: path.resolve("__tests__/playwright/prod/journeys"),
      testMatch: "*.journey.ts",
      use: { storageState: process.env.PLAYWRIGHT_AUTH_FILE },
    },
  ],
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder:
          process.env.CUE_JOURNEYS_REPORT_DIR ??
          ".tmp/journeys/emulated-report",
      },
    ],
  ],
});

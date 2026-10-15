import path from "node:path";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../../playwright.config.mjs";

// Opt-in: runs the emulated performance budgets against a mailbox of a few
// thousand messages behind provider latency, repeating each flow and writing
// medians to PERF_REPORT_FILE. See README.md in this folder.
const providerUrl = process.env.GOOGLE_BASE_URL;
const providerAddress = new URL(providerUrl);
if (
  providerAddress.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(providerAddress.hostname) ||
  !providerAddress.port
) {
  throw new Error(
    "Perf measurement requires a local HTTP GOOGLE_BASE_URL with an explicit port",
  );
}
process.env.PERF_MAILBOX = "large";

export default defineConfig({
  ...baseConfig,
  outputDir:
    process.env.PLAYWRIGHT_OUTPUT_DIR ?? path.resolve(".tmp/perf/test-results"),
  testDir: path.resolve("__tests__/playwright"),
  projects: [
    baseConfig.projects[0],
    {
      name: "perf",
      dependencies: ["emulated-setup"],
      testDir: path.resolve("__tests__/playwright/emulated"),
      testMatch: "mail/perf-budgets.spec.ts",
      use: { storageState: process.env.PLAYWRIGHT_AUTH_FILE },
    },
  ],
  reporter: [["list"]],
  webServer: baseConfig.webServer.map((server) => ({
    ...server,
    reuseExistingServer: false,
    ...(server.url === `${providerUrl}/.well-known/openid-configuration`
      ? {
          command: `node __tests__/playwright/perf/server.mjs ${providerAddress.port}`,
        }
      : {}),
  })),
});

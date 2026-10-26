// Groundtruth's settings live in tests/support/playwright.config.ts, kept up to date by Groundtruth.
// Extend them here if this app needs something different.
import { defineConfig } from "@playwright/test";
import base from "./tests/support/playwright.config";

export default defineConfig({
  ...base,
  // Cue's starting state alone (reset: database, Redis, emulators and a Next.js restart; then a sign-in and the
  // scenario's data) takes 30-60 s, and the mailbox fills in progressively after sign-in.
  timeout: 240_000,
  expect: { timeout: 30_000 },
});

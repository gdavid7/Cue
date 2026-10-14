import { expect, it, vi } from "vitest";
import config from "./serwist.config.mjs";

vi.mock("@serwist/next/config", () => ({
  serwist: async () => ({
    globPatterns: [
      "custom-output/static/**/*.{js,css,png,svg,json}",
      "public/**/*",
    ],
  }),
}));

it("precaches only the offline mail scripts, styles and WASM from the custom output path", () => {
  expect(config.globPatterns).toEqual([
    "custom-output/static/**/*.{js,css,wasm}",
  ]);
});

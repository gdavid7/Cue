// @ts-check
import { serwist } from "@serwist/next/config";

// Built by `serwist build` after `next build` (see the build scripts).
// Static assets are precached; app/sw.ts also keeps an offline mailbox shell.
const config = await serwist({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3MB
  // The webpack plugin this replaces never precached prerendered HTML.
  precachePrerendered: false,
});

// Reopening mail offline needs the hashed JS/CSS the first visit loaded before
// the worker controlled the page, plus the search worker's WASM (absent from
// the default extensions). Public and imported images (marketing, blog,
// splash screens) made up most of the precache and aren't needed offline.
config.globPatterns = config.globPatterns
  ?.filter((pattern) => !pattern.startsWith("public/"))
  .map((pattern) => pattern.replace(/\.\{[^}]+\}$/u, ".{js,css,wasm}"));
export default config;

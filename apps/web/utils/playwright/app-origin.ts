import type { Page } from "@playwright/test";

// The robots are configured with one host but sign-in can land on another (a
// moved domain redirects pages, while /api stays on the old host). Session
// cookies belong to the host the browser landed on, so every later request has
// to go there, not to the configured base URL.

const originByPage = new WeakMap<Page, string>();

/** Remembers where the browser is, so later calls survive a navigation to about:blank. */
export function rememberAppOrigin(page: Page) {
  const origin = httpOrigin(page.url());
  if (origin) originByPage.set(page, origin);
}

/** `path` on the host the browser signed in on; relative when none is known yet. */
export function appUrl(page: Page, path: string) {
  const origin = originByPage.get(page) ?? httpOrigin(page.url());
  return origin ? new URL(path, origin).href : path;
}

function httpOrigin(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

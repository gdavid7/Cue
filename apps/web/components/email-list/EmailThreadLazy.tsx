"use client";

import { lazy } from "react";

// The thread view brings an HTML parser, link detection and the message
// renderers. The mail screen and the app-wide email sheet paint without a
// thread open, so it loads beside them instead of before them.
export function preloadEmailThread() {
  return import("@/components/email-list/EmailThread");
}

export const EmailThreadLazy = lazy(() =>
  preloadEmailThread().then((mod) => ({ default: mod.EmailThread })),
);

"use client";

import { lazy } from "react";
import { loadChunk } from "@/utils/load-chunk";

const importEmailThread = () => import("@/components/email-list/EmailThread");

// The thread view brings an HTML parser, link detection and the message
// renderers. The mail screen and the app-wide email sheet paint without a
// thread open, so it loads beside them instead of before them.
export function preloadEmailThread() {
  // Separate from the lazy component's own load, so a failed preload can't
  // leave it holding the rejection. A background load never reloads the page.
  loadChunk(importEmailThread, { reloadOnFailure: false }).catch(
    () => undefined,
  );
}

export const EmailThreadLazy = lazy(() =>
  loadChunk(importEmailThread).then((mod) => ({ default: mod.EmailThread })),
);

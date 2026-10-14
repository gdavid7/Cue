"use client";

import { useEffect } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { captureException } from "@/utils/error";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";

// biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
export default function GlobalError({ error }: any) {
  useEffect(() => {
    captureException(error);
  }, [error]);

  // This replaces the root layout, so the providers never signal. The page
  // offers its own reload, so the desktop shell shouldn't replace it.
  useEffect(() => {
    getInboxZeroDesktopApp()?.signalReady?.();
  }, []);

  return (
    <html lang="en">
      <body className="p-4">
        <ErrorDisplay
          error={{ error: error?.message }}
          onRetry={() => window.location.reload()}
        />
      </body>
    </html>
  );
}

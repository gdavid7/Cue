"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { logOut } from "@/utils/user";

export function LandingErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-2 p-4">
      <ErrorDisplay error={{ error: error?.message }} onRetry={reset} />
      {/* A stale session is a common cause, so signing in again is the next step. */}
      <Button variant="ghost" size="sm" onClick={() => logOut()}>
        Sign out and sign in again
      </Button>
    </div>
  );
}

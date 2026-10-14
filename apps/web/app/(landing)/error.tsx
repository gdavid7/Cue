"use client";

import { LandingErrorBoundary } from "@/components/LandingErrorBoundary";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <LandingErrorBoundary error={error} reset={reset} />;
}

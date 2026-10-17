import type React from "react";
import { Loading } from "./Loading";
import { ErrorDisplay } from "./ErrorDisplay";

interface LoadingContentProps {
  children: React.ReactNode;
  error?: {
    info?: { error?: string; isKnownError?: boolean };
    error?: string;
    status?: number;
  };
  errorComponent?: React.ReactNode;
  /**
   * Data from an earlier load is on screen. A failed refresh then keeps it
   * rather than swapping it for the error; SWR retries in the background.
   */
  hasData?: boolean;
  loading: boolean;
  loadingComponent?: React.ReactNode;
  /** Defaults to revalidating the data on screen. */
  onRetry?: () => void;
}

export function LoadingContent(props: LoadingContentProps) {
  const ignoreError = shouldIgnoreError(props.error);

  if (props.error && props.hasData) return <>{props.children}</>;

  if (props.error && !ignoreError) {
    return props.errorComponent ? (
      props.errorComponent
    ) : (
      <div className="mt-4">
        <ErrorDisplay error={props.error} onRetry={props.onRetry} />
      </div>
    );
  }

  // In dev mode with ignored error, show loading while retrying
  if (props.loading || ignoreError)
    return <>{props.loadingComponent || <Loading />}</>;

  return <>{props.children}</>;
}

// In development, ignore 404 errors (likely transient HMR errors), unless the
// API sent one on purpose and the user is meant to read it.
function shouldIgnoreError(error: LoadingContentProps["error"]): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (error?.info?.isKnownError) return false;
  return error?.status === 404;
}

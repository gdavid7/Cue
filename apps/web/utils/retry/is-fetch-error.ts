export function isFetchError(errorInfo: { errorMessage: string }): boolean {
  return (
    errorInfo.errorMessage === "fetch failed" ||
    // AbortSignal.timeout() on a hung request
    errorInfo.errorMessage.includes("aborted due to timeout") ||
    errorInfo.errorMessage.includes("Unexpected end of JSON input")
  );
}

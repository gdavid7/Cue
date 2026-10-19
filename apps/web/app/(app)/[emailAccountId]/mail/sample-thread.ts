const SAMPLE_THREAD_THRESHOLD = 3;

export function getSampleThreadHintId(emailAccountId: string) {
  return `sample-thread:${emailAccountId}`;
}

/** Real mail takes over once the inbox holds this many threads. */
export function shouldShowSampleThread({
  isPlainInbox,
  isFirstSync,
  isLoading,
  hasError,
  threadCount,
  dismissed,
}: {
  isPlainInbox: boolean;
  isFirstSync: boolean;
  isLoading: boolean;
  hasError: boolean;
  threadCount: number;
  dismissed: boolean;
}) {
  return (
    isPlainInbox &&
    !isFirstSync &&
    !isLoading &&
    !hasError &&
    !dismissed &&
    threadCount < SAMPLE_THREAD_THRESHOLD
  );
}

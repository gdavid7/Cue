const SAMPLE_THREAD_THRESHOLD = 3;

export function getSampleThreadHintId(emailAccountId: string) {
  return `sample-thread:${emailAccountId}`;
}

/** Real mail takes over once the inbox holds this many threads. */
export function shouldShowSampleThread({
  isPlainInbox,
  isFirstSync,
  isLoading,
  threadCount,
  userLoaded,
  dismissed,
}: {
  isPlainInbox: boolean;
  isFirstSync: boolean;
  isLoading: boolean;
  threadCount: number;
  userLoaded: boolean;
  dismissed: boolean;
}) {
  return (
    isPlainInbox &&
    !isFirstSync &&
    !isLoading &&
    userLoaded &&
    !dismissed &&
    threadCount < SAMPLE_THREAD_THRESHOLD
  );
}

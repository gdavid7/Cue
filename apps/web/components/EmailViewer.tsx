"use client";

import { Suspense, useCallback, useEffect } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import {
  EmailThreadLazy,
  preloadEmailThread,
} from "@/components/email-list/EmailThreadLazy";
import { useThread } from "@/hooks/useThread";
import { Loading } from "@/components/Loading";
import { LoadingContent } from "@/components/LoadingContent";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  EmailAccountScopeProvider,
  useAccount,
} from "@/providers/EmailAccountProvider";
import { useAccounts } from "@/hooks/useAccounts";
import { isGoogleProvider } from "@/utils/email/provider-types";

export function EmailViewer() {
  const { emailAccountId, provider: currentProvider } = useAccount();
  const { data: accountsData } = useAccounts();

  const {
    threadId,
    accountId,
    showEmail,
    showReplyButton,
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
  } = useDisplayedEmail();

  const hideEmail = useCallback(() => showEmail(null), [showEmail]);
  const panelAccount =
    accountId && accountId !== emailAccountId
      ? accountsData?.emailAccounts.find((account) => account.id === accountId)
      : undefined;
  // The thread is never shown or acted on through the page's account.
  const panelAccountMissing =
    Boolean(accountId) && accountId !== emailAccountId && !panelAccount;
  const provider = panelAccount?.account.provider ?? currentProvider;
  const supportsViewerReplies = isGoogleProvider(provider);

  return (
    <Sheet open={!!threadId} onOpenChange={hideEmail}>
      <SheetContent
        side="right"
        size="5xl"
        className="overflow-y-auto bg-background p-6"
        overlay="transparent"
      >
        {threadId && !panelAccountMissing && (
          <EmailAccountScopeProvider emailAccount={panelAccount}>
            <ThreadContent
              threadId={threadId}
              showReplyButton={supportsViewerReplies && showReplyButton}
              autoOpenReplyForMessageId={
                supportsViewerReplies
                  ? (autoOpenReplyForMessageId ?? undefined)
                  : undefined
              }
              autoOpenForwardForMessageId={
                supportsViewerReplies
                  ? (autoOpenForwardForMessageId ?? undefined)
                  : undefined
              }
            />
          </EmailAccountScopeProvider>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ThreadContent({
  threadId,
  showReplyButton,
  autoOpenReplyForMessageId,
  autoOpenForwardForMessageId,
  topRightComponent,
  onSendSuccess,
}: {
  threadId: string;
  showReplyButton: boolean;
  autoOpenReplyForMessageId?: string;
  autoOpenForwardForMessageId?: string;
  topRightComponent?: React.ReactNode;
  onSendSuccess?: (messageId: string, threadId: string) => void;
}) {
  const { data, isLoading, error, mutate } = useThread({ id: threadId });
  // Loads the thread view alongside the thread rather than after it.
  useEffect(() => {
    preloadEmailThread();
  }, []);

  return (
    <ErrorBoundary extra={{ component: "ThreadContent", threadId }}>
      <LoadingContent hasData={Boolean(data)} loading={isLoading} error={error}>
        {data && (
          <Suspense fallback={<Loading />}>
            <EmailThreadLazy
              key={data.thread.id}
              messages={data.thread.messages}
              refetch={mutate}
              showReplyButton={showReplyButton}
              autoOpenReplyForMessageId={autoOpenReplyForMessageId}
              autoOpenForwardForMessageId={autoOpenForwardForMessageId}
              topRightComponent={topRightComponent}
              onSendSuccess={onSendSuccess}
              withHeader
            />
          </Suspense>
        )}
      </LoadingContent>
    </ErrorBoundary>
  );
}

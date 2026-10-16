import { useCallback, useState } from "react";
import { useQueryState } from "nuqs";
import { useAccount } from "@/providers/EmailAccountProvider";

export const useDisplayedEmail = () => {
  const { emailAccountId: currentEmailAccountId } = useAccount();
  const [threadId, setThreadId] = useQueryState("side-panel-thread-id");
  const [messageId, setMessageId] = useQueryState("side-panel-message-id");
  // The panel can outlive an account switch, so it keeps the thread's own
  // account rather than reading whichever account the page is on.
  const [accountIdParam, setAccountId] = useQueryState("side-panel-account-id");
  const [autoOpenReplyForMessageId, setAutoOpenReplyForMessageId] =
    useQueryState("auto-open-reply-for-message-id");
  const [autoOpenForwardForMessageId, setAutoOpenForwardForMessageId] =
    useQueryState("auto-open-forward-for-message-id");
  const [showReplyButton, setShowReplyButton] = useState(false);

  const showEmail = useCallback(
    (
      options: {
        threadId: string;
        /** Defaults to the account of the component opening the panel. */
        accountId?: string;
        messageId?: string;
        showReplyButton?: boolean;
        autoOpenReplyForMessageId?: string;
        autoOpenForwardForMessageId?: string;
      } | null,
    ) => {
      setAutoOpenReplyForMessageId(options?.autoOpenReplyForMessageId || "");
      setAutoOpenForwardForMessageId(
        options?.autoOpenForwardForMessageId || "",
      );
      setThreadId(options?.threadId ?? null);
      setAccountId(
        options ? options.accountId || currentEmailAccountId || null : null,
      );
      setMessageId(options?.messageId ?? null);
      setShowReplyButton(options?.showReplyButton ?? true);
    },
    [
      currentEmailAccountId,
      setAccountId,
      setAutoOpenForwardForMessageId,
      setAutoOpenReplyForMessageId,
      setMessageId,
      setThreadId,
    ],
  );

  return {
    threadId,
    /** The account the side-panel thread belongs to. */
    accountId: threadId ? accountIdParam || currentEmailAccountId : null,
    messageId,
    showEmail,
    showReplyButton,
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
  };
};

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuerySnapshot } from "@inboxzero/mail-react/use-query-snapshot";
import type { QuerySnapshot } from "@inboxzero/mail-core/queries";
import type { ConversationView } from "@inboxzero/mail-core/ports/mail-store";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { ThreadResponse } from "@/app/api/threads/[id]/route";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  CONVERSATION_PAGE_SIZE,
  conversationOutgoingMessages,
  conversationSendOperationIds,
  conversationViewToThreadResponse,
  missingConversationBodyIds,
  requestMissingMessageContent,
} from "@/utils/mail-engine/conversation-thread";

const EMPTY_SNAPSHOT: QuerySnapshot<ConversationView> = {
  status: "loading",
  revision: null,
  data: null,
  refreshing: false,
  error: null,
};

export function useThread(
  {
    id,
    emailAccountId: explicitEmailAccountId,
  }: { id: string | null; emailAccountId?: string },
  options?: {
    includeDrafts?: boolean;
    /**
     * Fetches the conversation's older messages if sync hasn't reached them.
     * Costs a provider read per conversation, so only the reader sets it.
     */
    fillConversation?: boolean;
    localMail?: boolean;
    parseReplies?: boolean;
  },
) {
  const { emailAccountId: currentEmailAccountId } = useAccount();
  const emailAccountId = explicitEmailAccountId ?? currentEmailAccountId;
  const client = useOptionalMailClient();
  const includeDrafts = options?.includeDrafts;
  const fillConversation = options?.fillConversation === true;
  const [pagination, setPagination] = useState({
    accountId: emailAccountId,
    id,
    pageSize: CONVERSATION_PAGE_SIZE,
  });
  const pageSize =
    pagination.accountId === emailAccountId && pagination.id === id
      ? pagination.pageSize
      : CONVERSATION_PAGE_SIZE;
  const createHandle = useCallback(() => {
    if (!client || !emailAccountId || !id) {
      return {
        getSnapshot: () => EMPTY_SNAPSHOT,
        subscribe: () => () => undefined,
        close: () => undefined,
      };
    }
    return client.observeConversation(
      { accountId: emailAccountId, conversationId: id },
      { after: null, pageSize },
    );
  }, [client, emailAccountId, id, pageSize]);
  const snapshot = useQuerySnapshot(createHandle);
  const view = useStableConversationView(snapshot.data);
  const requestedContent = useRef({ createHandle, ids: new Set<string>() });

  useEffect(() => {
    if (!client || !view) return;
    // The view can republish several times before bodies arrive; one request
    // per message for each observation is enough.
    if (requestedContent.current.createHandle !== createHandle) {
      requestedContent.current = { createHandle, ids: new Set() };
    }
    requestMissingMessageContent(client, view, requestedContent.current.ids);
  }, [client, createHandle, view]);

  // Until sync covers the whole mailbox, older messages of an opened
  // conversation may not be local yet; the engine fetches them once.
  const [completedConversations, setCompletedConversations] = useState(
    () => new Set<string>(),
  );
  useEffect(() => {
    if (!fillConversation || !client || !emailAccountId || !id) return;
    const key = conversationKey(emailAccountId, id);
    const conversation = { accountId: emailAccountId, conversationId: id };
    let current = true;
    let settled = false;
    client
      .ensureConversationMessages(conversation)
      .catch(() => undefined)
      .finally(() => {
        settled = true;
        if (!current) return;
        setCompletedConversations((completed) =>
          completed.has(key) ? completed : new Set(completed).add(key),
        );
      });
    return () => {
      current = false;
      // Moving on through threads must not leave the one opened next queued
      // behind fills nobody will read.
      if (!settled) {
        client.releaseConversationMessages(conversation).catch(() => undefined);
      }
    };
  }, [client, emailAccountId, fillConversation, id]);
  const openKey =
    fillConversation && emailAccountId && id
      ? conversationKey(emailAccountId, id)
      : null;
  const completing = Boolean(
    openKey &&
      !completedConversations.has(openKey) &&
      view?.coverage.some(
        (coverage) =>
          coverage.metadata !== "complete" ||
          coverage.windowStartMs !== undefined,
      ),
  );
  // Before a first sync has listed every scope (a folder such as Sent still
  // unread), any of the conversation's messages may be missing, and a fill
  // often finds some; they load into the row held for them. A sync that only
  // stopped at a window misses mail older than it, which a fill rarely
  // finds, so no row is held that would go away again after painting.
  const fillMayFindMessages =
    completing &&
    Boolean(
      view?.coverage.some((coverage) => coverage.metadata !== "complete"),
    );

  const data = useMemo<ThreadResponse | undefined>(() => {
    if (!id || !view) return;
    return conversationViewToThreadResponse(view, { includeDrafts });
  }, [id, includeDrafts, view]);

  const mutate = useCallback(async () => {
    if (!client || !emailAccountId) return data;
    await client.requestSync([emailAccountId]);
    if (view) {
      await Promise.all(
        view.messages.map((message) =>
          client.ensureMessageContent(message.key),
        ),
      );
    }
    return data;
  }, [client, data, emailAccountId, view]);

  const isLoading =
    Boolean(id) && (!client || !data) && snapshot.status !== "error";
  const errorCode = snapshot.error?.code;
  // Kept referentially stable so a memoized reader only re-renders when the
  // conversation actually changes.
  const error = useMemo(() => conversationQueryError(errorCode), [errorCode]);
  const loadingMore = snapshot.refreshing && pageSize > CONVERSATION_PAGE_SIZE;
  const localAvailability = useMemo(() => {
    if (!data || !view) return;
    return {
      missingBodyIds: missingConversationBodyIds(view),
      outgoing: conversationOutgoingMessages(view),
      sendOperationIds: conversationSendOperationIds(view),
      hasMore: Boolean(view.nextPage) || fillMayFindMessages,
      loadingMore: loadingMore || fillMayFindMessages,
      filling: completing,
      loadMore: () =>
        setPagination({
          accountId: emailAccountId,
          id,
          pageSize: pageSize + CONVERSATION_PAGE_SIZE,
        }),
    };
  }, [
    completing,
    data,
    emailAccountId,
    fillMayFindMessages,
    id,
    loadingMore,
    pageSize,
    view,
  ]);

  return {
    data,
    error,
    isLoading,
    isValidating: snapshot.refreshing,
    mutate,
    localAvailability,
  };
}

function conversationKey(emailAccountId: string, id: string) {
  return `${emailAccountId}\u0000${id}`;
}

function conversationQueryError(
  code: string | undefined,
): { error: string; info: { error: string } } | undefined {
  if (!code) return;
  const message =
    code === "not_found"
      ? "This conversation isn't available yet."
      : "Couldn't open this conversation.";
  return { error: message, info: { error: message } };
}

// Writes elsewhere, such as saving a new draft, can republish this view with
// the same messages. Keeping the previous view spares the open reader a full
// re-render for them.
function useStableConversationView(view: ConversationView | null) {
  const previous = useRef<{ key: string; view: ConversationView } | null>(null);
  return useMemo(() => {
    if (!view) return view;
    const key = JSON.stringify([
      view.key,
      view.messages,
      view.outgoing,
      view.nextPage,
    ]);
    if (previous.current?.key === key) return previous.current.view;
    previous.current = { key, view };
    return view;
  }, [view]);
}

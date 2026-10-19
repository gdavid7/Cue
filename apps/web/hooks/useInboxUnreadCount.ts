import { useEffect, useMemo, useState } from "react";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";

/** Unread inbox conversations, summed across the given accounts and kept live. */
export function useInboxUnreadCount(accountIds: readonly string[]) {
  const client = useOptionalMailClient();
  const accountKey = accountIds.join("\0");
  const stableAccountIds = useMemo(
    () => (accountKey ? accountKey.split("\0") : []),
    [accountKey],
  );
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!client || stableAccountIds.length === 0) {
      setCount(0);
      return;
    }
    const handle = client.observeMailboxCounts({
      accountIds: stableAccountIds,
      targets: [{ id: "INBOX", predicate: { kind: "role", role: "inbox" } }],
    });
    const apply = () =>
      setCount(handle.getSnapshot().data?.counts[0]?.unreadConversations ?? 0);
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
    };
  }, [client, stableAccountIds]);

  return count;
}

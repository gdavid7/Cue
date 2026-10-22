"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { SenderHistoryQuery } from "@inboxzero/mail-core/queries";
import {
  findSenderNotice,
  needsSenderHistory,
  type SenderNotice as SenderNoticeData,
  senderAllowKey,
} from "@inboxzero/mail-core/sender-check";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import {
  PersonCardTrigger,
  usePersonCardScope,
} from "@/components/person-card/PersonCard";
import { useOwnEmailAddresses } from "@/hooks/useOwnEmailAddresses";
import { createBrowserCache } from "@/utils/browser-cache";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";

// "It's fine" is remembered on this device only, per account, and cleared
// with every other browser cache on sign-out. It never reaches the server.
const allowedSenders = createBrowserCache<true>({
  name: "sender-notice-allowed",
  ttlMs: 365 * 24 * 3_600_000,
  maxEntries: 500,
});

const INDEX_POLL_MS = 5000;

/**
 * The reader's quiet "New address, familiar name" line for a received
 * message. It compares the From name and address with the user's own mail
 * on this device (see sender-check); nothing is asked of a server or model.
 */
export function SenderNotice({
  from,
  emailAccountId,
}: {
  from: string;
  emailAccountId: string;
}) {
  const scope = usePersonCardScope();
  const ownAddresses = useOwnEmailAddresses();
  const client = useOptionalMailClient() ?? getActiveMailClient();
  const [allowedNow, setAllowedNow] = useState<string | null>(null);
  const name = extractNameFromEmail(from);
  const address = extractEmailAddress(from).toLowerCase();
  const isAllowed = (key: string) =>
    key === allowedNow || Boolean(allowedSenders.get(emailAccountId, key));

  const query = useMemo<SenderHistoryQuery>(
    () => ({
      accountIds: scope?.accountIds ?? [emailAccountId],
      email: address,
      name,
      ownAddresses,
    }),
    [scope?.accountIds, emailAccountId, address, name, ownAddresses],
  );
  const readHistory = client?.querySenderHistory?.bind(client);
  const lookUp =
    readHistory &&
    needsSenderHistory(name, address, ownAddresses) &&
    !isAllowed(senderAllowKey(name, address));
  const { data: history } = useSWR(
    lookUp ? ["sender-history", JSON.stringify(query)] : null,
    () => (readHistory as NonNullable<typeof readHistory>)(query),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      // On a first sync the contact index is still being built; ask again
      // until it is, then never.
      refreshInterval: (current) =>
        current && !current.ready ? INDEX_POLL_MS : 0,
    },
  );

  const notice = findSenderNotice({
    name,
    address,
    ownAddresses,
    history,
    isAllowed,
  });
  if (!notice) return null;

  const allow = () => {
    const key = senderAllowKey(notice.name, notice.address);
    allowedSenders.set(emailAccountId, key, true);
    setAllowedNow(key);
  };

  return (
    <p
      className="mb-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-muted-foreground text-xs"
      data-testid="sender-notice"
    >
      <span className="min-w-0 break-words">{noticeText(notice)}</span>
      <span className="flex items-baseline gap-1.5">
        {/* Outside a reader there is no card to open. */}
        {scope && (
          <>
            <PersonCardTrigger
              className="text-primary hover:underline"
              email={
                notice.kind === "familiar-name"
                  ? notice.knownAddress
                  : notice.address
              }
              name={notice.kind === "familiar-name" ? notice.name : ""}
            >
              Show contact
            </PersonCardTrigger>
            <span aria-hidden>·</span>
          </>
        )}
        <button
          className="text-primary hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            allow();
          }}
          type="button"
        >
          It's fine
        </button>
      </span>
    </p>
  );
}

function noticeText(notice: SenderNoticeData) {
  if (notice.kind === "familiar-name")
    return `${notice.name} usually writes from ${notice.knownAddress}. This message is from ${notice.address}.`;
  return `The name on this message is ${notice.name}, but it is from ${notice.address}.`;
}

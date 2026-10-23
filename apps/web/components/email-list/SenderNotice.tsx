"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { SenderHistoryQuery } from "@inboxzero/mail-core/queries";
import {
  findSenderNotice,
  needsSenderHistory,
  normalizeAddress,
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

// While the contact index is still being built on a first sync, the line
// asks again: often at first, then rarely, then not at all.
const INDEX_POLL_MS = 5000;
const INDEX_POLL_SLOW_AFTER_MS = 60_000;
const INDEX_POLL_SLOW_MS = 30_000;
const INDEX_POLL_STOP_AFTER_MS = 10 * 60_000;

/**
 * The reader's quiet "New address, familiar name" line for a received
 * message. It compares the From name and address with the user's own mail
 * on this device (see sender-check); nothing is asked of a server or model.
 */
export function SenderNotice({
  from,
  receivedAtMs,
  emailAccountId,
}: {
  from: string;
  /** When the message arrived; only earlier mail from the sender counts. */
  receivedAtMs: number;
  emailAccountId: string;
}) {
  const scope = usePersonCardScope();
  const ownAddresses = useOwnEmailAddresses();
  const client = useOptionalMailClient() ?? getActiveMailClient();
  const [allowedNow, setAllowedNow] = useState<string | null>(null);
  const [mountedAtMs] = useState(Date.now);
  const name = extractNameFromEmail(from);
  const address = normalizeAddress(extractEmailAddress(from));
  const allowKey = senderAllowKey(name, address);
  // Read from storage once per sender, not on every render.
  const storedAllowed = useMemo(
    () => Boolean(allowedSenders.get(emailAccountId, allowKey)),
    [emailAccountId, allowKey],
  );
  const allowed = storedAllowed || allowedNow === allowKey;

  const query = useMemo<SenderHistoryQuery>(
    () => ({
      accountIds: scope?.accountIds ?? [emailAccountId],
      email: address,
      name,
      receivedAtMs,
      ownAddresses,
    }),
    [
      scope?.accountIds,
      emailAccountId,
      address,
      name,
      receivedAtMs,
      ownAddresses,
    ],
  );
  const readHistory = client?.querySenderHistory?.bind(client);
  const lookUp = !allowed && needsSenderHistory(name, address, ownAddresses);
  const { data: history } = useSWR(
    readHistory && lookUp ? ["sender-history", JSON.stringify(query)] : null,
    () => readHistory?.(query),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: (current) =>
        current && !current.ready
          ? readinessPollMs(Date.now() - mountedAtMs)
          : 0,
    },
  );

  const notice = findSenderNotice({
    name,
    address,
    ownAddresses,
    history,
    isAllowed: () => allowed,
  });
  if (!notice) return null;

  const allow = () => {
    allowedSenders.set(emailAccountId, allowKey, true);
    setAllowedNow(allowKey);
  };

  return (
    <p
      className="mb-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-muted-foreground text-xs"
      data-testid="sender-notice"
      role="note"
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
          aria-label={`It's fine: ${notice.name} from ${notice.address}`}
          className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            // The line goes away with this button; keep keyboard focus on
            // the message rather than dropping it to the page.
            event.currentTarget
              .closest<HTMLElement>("li[data-thread-message-id]")
              ?.focus({ preventScroll: true });
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

function readinessPollMs(elapsedMs: number) {
  if (elapsedMs >= INDEX_POLL_STOP_AFTER_MS) return 0;
  return elapsedMs >= INDEX_POLL_SLOW_AFTER_MS
    ? INDEX_POLL_SLOW_MS
    : INDEX_POLL_MS;
}

function noticeText(notice: SenderNoticeData) {
  if (notice.kind === "familiar-name")
    return `${notice.name} usually writes from ${notice.knownAddress}. This message is from ${notice.address}.`;
  return `The name on this message is ${notice.name}, but it is from ${notice.address}.`;
}

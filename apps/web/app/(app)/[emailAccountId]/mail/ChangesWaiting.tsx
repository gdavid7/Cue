"use client";

import { memo, useState, useSyncExternalStore } from "react";
import { CloudUploadIcon } from "lucide-react";
import useSWR from "swr";
import type { MailClient, MailDiagnostics } from "@inboxzero/mail-core/engine";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { RailTooltip } from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import {
  hasDeliverableChanges,
  hasPendingChanges,
  summarizeWaitingChanges,
  type WaitingAccount,
  type WaitingAccountState,
} from "@/utils/mail-engine/changes-waiting";
import { getConnectedEngineAccounts } from "@/utils/mail-engine/engine-accounts";
import { reconnectMailAccount } from "@/utils/mail-engine/reconnect-account";

// The engine has no diagnostics subscription, so this reads them: often
// enough to follow changes already waiting, rarely while nothing is.
const WATCHING_REFRESH_MS = 10_000;
const IDLE_REFRESH_MS = 30_000;
// A follower tab's read can hang once its channel closes.
const READ_TIMEOUT_MS = 5000;

const STATE_LABELS: Record<WaitingAccountState, string> = {
  waiting: "Waiting",
  retrying: "Retrying",
  reconnect: "Needs reconnect",
};

type EmailAccount = GetEmailAccountsResponse["emailAccounts"][number];

/**
 * A quiet line in the mail sidebar for changes the mail engine is holding
 * because the provider hasn't taken them yet, or an account that needs
 * signing in again. Hidden whenever there is nothing to say, including on an
 * engine that can't report it.
 */
export const ChangesWaiting = memo(function ChangesWaiting({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const client = useOptionalMailClient();
  const { emailAccountId, provider } = useAccount();
  const { data: accountsData } = useAccounts();
  const online = useSyncExternalStore(
    subscribeToOnline,
    () => navigator.onLine,
    () => true,
  );
  const [trying, setTrying] = useState(false);
  const emailAccounts = accountsData?.emailAccounts ?? [];
  const accountIds = [
    ...new Set([
      ...(emailAccountId ? [emailAccountId] : []),
      ...getConnectedEngineAccounts(emailAccounts).map(
        (account) => account.accountId,
      ),
    ]),
  ];
  const { data, mutate } = useSWR(
    client && accountIds.length > 0
      ? ["mail-changes-waiting", accountIds.join(",")]
      : null,
    () => (client ? readWaitingChanges(client, accountIds) : null),
    {
      refreshInterval: (latest) =>
        latest?.watching ? WATCHING_REFRESH_MS : IDLE_REFRESH_MS,
      refreshWhenOffline: true,
      shouldRetryOnError: false,
      dedupingInterval: WATCHING_REFRESH_MS / 2,
    },
  );

  const waiting = data?.accounts ?? [];
  if (waiting.length === 0) return null;

  const accountById = new Map(
    emailAccounts.map((account) => [account.id, account]),
  );
  const providerOf = (accountId: string) =>
    accountById.get(accountId)?.account.provider ??
    (accountId === emailAccountId ? provider : undefined);
  const headline = waitingHeadline(waiting, providerOf);
  const needsReconnect = waiting.some(
    (account) => account.state === "reconnect",
  );
  const canTry = hasDeliverableChanges(waiting);
  const hasChanges = waiting.some((account) => account.count > 0);

  const icon = (
    <CloudUploadIcon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        needsReconnect
          ? "text-amber-600 dark:text-amber-500"
          : "text-sidebar-muted-foreground",
      )}
    />
  );

  return (
    <div
      className="mt-2 shrink-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
      aria-live="polite"
    >
      <Popover>
        <RailTooltip label={collapsed ? headline : null}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={collapsed ? headline : undefined}
              className={cn(
                "flex items-center rounded-lg text-sidebar-muted-foreground text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-sidebar-accent/80",
                collapsed
                  ? "relative mx-auto size-10 justify-center"
                  : "w-full gap-2.5 px-2.5 py-1.5 text-left",
              )}
            >
              {icon}
              {collapsed ? null : (
                <span className="line-clamp-2">{headline}</span>
              )}
            </button>
          </PopoverTrigger>
        </RailTooltip>
        <PopoverContent
          side={collapsed ? "right" : "top"}
          align={collapsed ? "end" : "start"}
          className="w-80 p-0"
        >
          <div className="space-y-1 px-4 pt-3.5 pb-3">
            <p className="font-medium text-sm">
              {hasChanges ? "Changes waiting" : "Reconnect needed"}
            </p>
            <p className="text-muted-foreground text-xs">
              {popoverDescription(hasChanges, online)}
            </p>
          </div>
          <ul className="divide-y divide-border border-border border-t">
            {waiting.map((account) => (
              <WaitingAccountRow
                key={account.accountId}
                account={account}
                emailAccount={accountById.get(account.accountId)}
                provider={providerOf(account.accountId)}
              />
            ))}
          </ul>
          {canTry ? (
            <div className="flex justify-end border-border border-t px-3 py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!online || trying}
                onClick={() => {
                  setTrying(true);
                  client
                    ?.requestSync(
                      waiting
                        .filter((account) => account.state !== "reconnect")
                        .map((account) => account.accountId),
                    )
                    .catch(() => undefined)
                    .then(() => mutate())
                    .finally(() => setTrying(false));
                }}
              >
                {trying ? "Trying…" : "Try now"}
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
});

function WaitingAccountRow({
  account,
  emailAccount,
  provider,
}: {
  account: WaitingAccount;
  emailAccount: EmailAccount | undefined;
  provider: string | undefined;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const detail = [
    STATE_LABELS[account.state],
    account.count > 0 ? changesCount(account.count) : null,
    account.kinds
      .map(({ label, count }) => (count > 1 ? `${label} ×${count}` : label))
      .join(", ") || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {emailAccount?.email ?? providerName(provider)}
        </p>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </div>
      {account.state === "reconnect" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={reconnecting}
          onClick={() => {
            setReconnecting(true);
            reconnectMailAccount({
              emailAccountId: account.accountId,
              provider,
            }).finally(() => setReconnecting(false));
          }}
        >
          Reconnect
        </Button>
      ) : null}
    </li>
  );
}

async function readWaitingChanges(client: MailClient, accountIds: string[]) {
  const diagnostics = (
    await Promise.all(
      accountIds.map((accountId) => readDiagnostics(client, accountId)),
    )
  ).filter((value): value is MailDiagnostics => value !== null);
  return {
    accounts: summarizeWaitingChanges(diagnostics, Date.now()),
    watching: hasPendingChanges(diagnostics),
  };
}

// An engine that can't report diagnostics (an older desktop app) shows
// nothing rather than an error.
async function readDiagnostics(client: MailClient, accountId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.getDiagnostics(accountId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function waitingHeadline(
  accounts: WaitingAccount[],
  providerOf: (accountId: string) => string | undefined,
) {
  const providers = new Set(
    accounts.map((account) => providerName(providerOf(account.accountId))),
  );
  const [onlyProvider] = providers;
  const count = accounts.reduce((total, account) => total + account.count, 0);
  if (count > 0) {
    return `${changesCount(count)} waiting to reach ${
      providers.size === 1 ? onlyProvider : "your mailboxes"
    }`;
  }
  return providers.size === 1
    ? `${onlyProvider} needs reconnecting`
    : "Accounts need reconnecting";
}

function popoverDescription(hasChanges: boolean, online: boolean) {
  if (!hasChanges) return "Sign in again so your mail keeps syncing.";
  if (!online) {
    return "You're offline. Saved changes go through when you're back online.";
  }
  return "Saved on this device. They go through as soon as your mailbox responds.";
}

function changesCount(count: number) {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function providerName(provider: string | undefined) {
  return isMicrosoftProvider(provider) ? "Outlook" : "Gmail";
}

function subscribeToOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

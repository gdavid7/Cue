"use client";

import { useState } from "react";
import type { ProviderSearchNotice } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import { toastError } from "@/components/Toast";
import { cn } from "@/utils";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * Why a committed search may be missing mail the provider would have found.
 * A warning while the provider hasn't answered at all; a quieter note once it
 * has answered part of it.
 */
export function SearchProviderNotice({
  notice,
  provider,
}: {
  notice: ProviderSearchNotice;
  /** The provider of the account the notice is about, when known. */
  provider: string | null | undefined;
}) {
  const name = providerName(provider);
  return (
    <p
      role={notice.partial ? undefined : "status"}
      className={cn(
        "px-5 pt-3 text-xs",
        notice.partial ? "text-muted-foreground/70" : "text-muted-foreground",
      )}
    >
      {notice.kind === "reconnect" ? (
        <>
          <ReconnectButton
            accountId={notice.accountId}
            label={`Reconnect ${name ?? "your account"}`}
            provider={provider}
          />{" "}
          to search all your mail.
        </>
      ) : (
        providerSearchNoticeText(notice.kind, name)
      )}
    </p>
  );
}

/** What to say while a typed search reads only the mail on this device. */
export function searchOnEnterHint(provider: string | null | undefined) {
  const name = providerName(provider);
  return name
    ? `Press Enter to search all of ${name}.`
    : "Press Enter to search all your mail.";
}

function providerSearchNoticeText(
  kind: Exclude<ProviderSearchNotice["kind"], "reconnect">,
  name: string | null,
) {
  if (kind === "busy")
    return `${name ?? "Your mail provider"} is busy; showing mail on this device for now.`;
  if (kind === "unavailable")
    return `Can't reach ${name ?? "your mail provider"}; showing mail on this device.`;
  return `${name ?? "Your mail provider"} can't run this search; showing mail on this device.`;
}

function ReconnectButton({
  accountId,
  label,
  provider,
}: {
  accountId: string;
  label: string;
  provider: string | null | undefined;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  return (
    <button
      type="button"
      className="font-medium underline underline-offset-2 disabled:opacity-50"
      disabled={reconnecting}
      onClick={() => {
        setReconnecting(true);
        getAccountLinkingUrl(
          isMicrosoftProvider(provider) ? "microsoft" : "google",
          { reconnectEmailAccountId: accountId },
        )
          .then((url) => redirectToSafeUrl(url, { allowExternal: true }))
          .catch((error: unknown) => {
            toastError({
              title: "Couldn't start reconnecting",
              description:
                error instanceof Error
                  ? error.message
                  : "Check your connection and try again.",
            });
            setReconnecting(false);
          });
      }}
    >
      {label}
    </button>
  );
}

function providerName(provider: string | null | undefined) {
  if (isGoogleProvider(provider)) return "Gmail";
  if (isMicrosoftProvider(provider)) return "Outlook";
  return null;
}

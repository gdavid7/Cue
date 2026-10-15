"use client";

import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { AppAlertBanner } from "@/app/(app)/AppAlertBanner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { mailEngineConnectionCopy } from "@/utils/mail-engine/connection-notice";
import { redirectToSafeUrl } from "@/utils/redirect";

export const MailEngineConnectionBanner = memo(
  function MailEngineConnectionBanner() {
    const { emailAccountId, provider } = useAccount();
    const client = useOptionalMailClient();
    const [engineConnection, setConnection] = useState<
      "ready" | "offline" | "blocked_auth" | undefined
    >();
    // Sync waits for the network instead of failing while the browser is
    // offline, so the engine has nothing to report; say so here instead.
    const isBrowserOnline = useSyncExternalStore(
      subscribeToOnline,
      () => navigator.onLine,
      () => true,
    );
    const connection =
      !isBrowserOnline && engineConnection !== "blocked_auth"
        ? "offline"
        : engineConnection;
    const [reconnecting, setReconnecting] = useState(false);
    const copy = mailEngineConnectionCopy(connection, provider);

    useEffect(() => {
      if (!client || !emailAccountId) {
        setConnection(undefined);
        return;
      }
      const handle = client.observeMailbox({
        accountIds: [emailAccountId],
        predicate: { kind: "role", role: "inbox" },
        order: "newest_first",
        pageSize: 1,
        after: null,
      });
      const apply = () => {
        setConnection(handle.getSnapshot().data?.connection);
      };
      const unsubscribe = handle.subscribe(apply);
      apply();
      return () => {
        unsubscribe();
        handle.close();
      };
    }, [client, emailAccountId]);

    if (!copy) return null;

    if (connection === "offline") {
      return (
        <p
          className="border-border border-b px-4 py-2 text-muted-foreground text-sm"
          role="status"
        >
          {copy.title} {copy.description}
        </p>
      );
    }

    return (
      <AppAlertBanner
        action={
          copy.action ? (
            <Button
              disabled={reconnecting || !emailAccountId}
              onClick={() => {
                setReconnecting(true);
                getAccountLinkingUrl(
                  isMicrosoftProvider(provider) ? "microsoft" : "google",
                  { reconnectEmailAccountId: emailAccountId },
                )
                  .then((url) =>
                    redirectToSafeUrl(url, { allowExternal: true }),
                  )
                  .catch((error: unknown) => {
                    toastError({
                      title: "Couldn't start reconnecting",
                      description:
                        error instanceof Error
                          ? error.message
                          : "Check your connection and try again.",
                    });
                  })
                  .finally(() => setReconnecting(false));
              }}
              size="sm"
            >
              {copy.action}
            </Button>
          ) : null
        }
        description={copy.description}
        title={copy.title}
      />
    );
  },
);

function subscribeToOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useModal } from "@/hooks/useModal";
import { useAccounts } from "@/hooks/useAccounts";
import { ComposeEmailFormLazy } from "@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy";
import type { ReplyingToEmail } from "@/app/(app)/[emailAccountId]/compose/ComposeEmailForm";
import {
  EmailAccountScopeProvider,
  useAccount,
} from "@/providers/EmailAccountProvider";
import { deleteDraftAction } from "@/utils/actions/mail";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import type { ReplyDraftMode } from "@/utils/mail-engine/reply-drafts";
import { getActionErrorMessage } from "@/utils/error";
import { toastError } from "@/components/Toast";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";

export type PoppedOutReply = {
  emailAccountId: string;
  draftSessionId: string;
  draftKeyMessageId: string;
  draftMode: ReplyDraftMode;
  providerDraftMessageId?: string;
  replyingToEmail: ReplyingToEmail;
  /** Puts the reply back in its thread when the window is dismissed unsent. */
  onReturn?: () => void;
};

type Context = {
  onOpen: () => void;
  popOutReply: (reply: PoppedOutReply) => void;
  poppedOutDraftSessionId?: string;
};

const ComposeModalContext = createContext<Context>({
  onOpen: async () => {},
  popOutReply: () => {},
});

export const useComposeModal = () => useContext(ComposeModalContext);

const PHONE_QUERY = "(max-width: 639px)";

export function ComposeModalProvider(props: { children: React.ReactNode }) {
  const isPhone = useSyncExternalStore(
    subscribeToPhoneQuery,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { emailAccountId } = useAccount();
  const { isModalOpen, openModal, closeModal } = useModal();
  const [isExpanded, setIsExpanded] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [poppedOutReply, setPoppedOutReply] = useState<PoppedOutReply>();
  const isAllAccountsMailView =
    pathname.endsWith("/mail") && searchParams.get("accountScope") === "all";
  const { data: accountsData } = useAccounts(
    isAllAccountsMailView || isModalOpen,
  );
  // A popped-out reply belongs to the account it was written from, which the
  // combined inbox shows alongside the account in the URL.
  const otherReplyAccount =
    poppedOutReply && poppedOutReply.emailAccountId !== emailAccountId
      ? accountsData?.emailAccounts.find(
          (account) => account.id === poppedOutReply.emailAccountId,
        )
      : undefined;
  const reply =
    poppedOutReply?.emailAccountId === emailAccountId ||
    (isAllAccountsMailView && otherReplyAccount)
      ? poppedOutReply
      : undefined;
  const fromAccounts =
    accountsData && accountsData.emailAccounts.length > 1
      ? accountsData.emailAccounts
      : undefined;
  const isOpen = isModalOpen && (!poppedOutReply || Boolean(reply));
  const returnOpenReply = useCallback(() => {
    if (isOpen) reply?.onReturn?.();
  }, [isOpen, reply]);
  const openCompose = useCallback(() => {
    returnOpenReply();
    setIsExpanded(false);
    setPoppedOutReply(undefined);
    openModal();
  }, [openModal, returnOpenReply]);
  const popOutReply = useCallback(
    (nextReply: PoppedOutReply) => {
      returnOpenReply();
      setIsExpanded(false);
      setPoppedOutReply(nextReply);
      openModal();
    },
    [openModal, returnOpenReply],
  );
  // Keeps the popped-out reply so undo send can reopen it.
  const closeCompose = useCallback(() => {
    setIsExpanded(false);
    closeModal();
  }, [closeModal]);
  const restoreCompose = useCallback(() => {
    setComposerKey((key) => key + 1);
    openModal();
  }, [openModal]);
  const discardReply = useCallback(
    async (draftId?: string) => {
      if (reply?.providerDraftMessageId) {
        const result = await deleteDraftAction(reply.emailAccountId, {
          draftMessageId: reply.providerDraftMessageId,
          draftId,
        }).catch(() => undefined);
        if (
          !result ||
          result.serverError !== undefined ||
          result.validationErrors !== undefined
        ) {
          toastError({
            description: getActionErrorMessage(result ?? {}, {
              prefix: "Failed to discard draft",
            }),
          });
          return false;
        }
        getActiveMailClient()
          ?.requestSync([reply.emailAccountId])
          .catch(() => {});
      }
      closeCompose();
      return true;
    },
    [reply, closeCompose],
  );
  const contextValue = useMemo(
    () => ({
      onOpen: openCompose,
      popOutReply,
      poppedOutDraftSessionId: isOpen ? reply?.draftSessionId : undefined,
    }),
    [openCompose, popOutReply, isOpen, reply?.draftSessionId],
  );

  return (
    <ComposeModalContext.Provider value={contextValue}>
      {props.children}
      <Dialog
        // A phone shows compose full screen, so the inbox behind it must not
        // take taps or focus. Wider screens keep it beside the mail.
        modal={isPhone}
        open={isOpen}
        onOpenChange={(open) => {
          if (open) return;
          returnOpenReply();
          closeCompose();
        }}
      >
        <DialogContent
          className={cn(
            "fixed z-50 flex max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden bg-background p-0",
            isExpanded
              ? "inset-0 h-dvh w-screen rounded-none border-0 shadow-none"
              : "inset-0 h-dvh w-screen sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(42rem,calc(100dvh-1.5rem))] sm:w-[38rem] sm:rounded-xl sm:border sm:border-border sm:shadow-2xl",
          )}
          data-compose-expanded={isExpanded}
          hideCloseButton
          hideOverlay
          onEscapeKeyDown={(event) => {
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest("[data-email-editor-link-dialog]")
            ) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => event.preventDefault()}
          unstyled
        >
          <header
            className={cn(
              "flex h-12 shrink-0 items-center justify-between px-3",
              isExpanded ? "mx-auto h-20 w-full max-w-6xl px-6" : "border-b",
              "max-sm:h-14",
            )}
          >
            <DialogTitle
              className={cn(
                "text-sm font-semibold",
                isExpanded && "text-2xl font-medium",
              )}
            >
              {reply ? reply.replyingToEmail.subject || "Reply" : "New Message"}
            </DialogTitle>
            <div className="flex items-center gap-0.5">
              <Button
                aria-label={isExpanded ? "Restore compose" : "Expand compose"}
                // Already full screen on a phone.
                className="max-sm:hidden"
                onClick={() => setIsExpanded((expanded) => !expanded)}
                size="iconSm"
                title={isExpanded ? "Restore compose" : "Expand compose"}
                variant="ghost"
              >
                {isExpanded ? (
                  <Minimize2Icon className="size-4" />
                ) : (
                  <Maximize2Icon className="size-4" />
                )}
              </Button>
              <DialogClose asChild>
                <Button
                  aria-label="Close compose"
                  className="max-sm:size-10"
                  size="iconSm"
                  title="Close compose"
                  variant="ghost"
                >
                  <XIcon className="size-4" />
                </Button>
              </DialogClose>
            </div>
          </header>
          <div
            className={cn(
              "min-h-0 flex-1",
              isExpanded && "mx-auto w-full max-w-6xl px-6 pb-6",
            )}
          >
            <div
              className={cn(
                "h-full overflow-hidden bg-background",
                isExpanded && "rounded-xl border shadow-lg",
              )}
            >
              {reply ? (
                <EmailAccountScopeProvider emailAccount={otherReplyAccount}>
                  <ComposeEmailFormLazy
                    key={`${reply.draftSessionId}:${composerKey}`}
                    draftKeyMessageId={reply.draftKeyMessageId}
                    draftMode={reply.draftMode}
                    draftSessionId={reply.draftSessionId}
                    layout="window"
                    onClose={closeCompose}
                    onDiscard={discardReply}
                    onRestore={restoreCompose}
                    onSuccess={closeCompose}
                    providerDraftMessageId={reply.providerDraftMessageId}
                    replyingToEmail={reply.replyingToEmail}
                  />
                </EmailAccountScopeProvider>
              ) : (
                <ComposeEmailFormLazy
                  key={composerKey}
                  draftSessionId="compose:new-message"
                  fromAccounts={fromAccounts}
                  layout="window"
                  onClose={closeCompose}
                  onDiscard={() => {
                    closeCompose();
                    return true;
                  }}
                  onRestore={() => {
                    setComposerKey((key) => key + 1);
                    openCompose();
                  }}
                  onSuccess={closeCompose}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </ComposeModalContext.Provider>
  );
}

function subscribeToPhoneQuery(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

"use client";

import { useSenderCommands } from "@/app/(app)/[emailAccountId]/mail/use-sender-commands";
import { UnsubscribeConfirmDialog } from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";
import type { ParsedMessage } from "@/utils/types";

export function ListSenderCommands({
  message,
}: {
  message: Pick<ParsedMessage, "headers" | "threadId"> | null;
}) {
  const { PremiumModal, unsubscribeConfirm } = useSenderCommands(message);
  return (
    <>
      <PremiumModal />
      <UnsubscribeConfirmDialog {...unsubscribeConfirm} />
    </>
  );
}

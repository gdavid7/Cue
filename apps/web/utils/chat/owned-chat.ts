import type { Prisma } from "@/generated/prisma/client";

/**
 * Matches a chat only when it belongs to the signed-in user. A chat covers
 * all of the user's accounts, so it is theirs from any account they open it
 * in, not only from the account it was started in.
 */
export function ownedChatWhere({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  return {
    id: chatId,
    emailAccount: { userId },
  } satisfies Prisma.ChatWhereInput;
}

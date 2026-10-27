"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  deleteChatBody,
  renameChatBody,
} from "@/utils/actions/chat.validation";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { softDeleteChat } from "@/utils/chat/soft-delete";
import { ownedChatWhere } from "@/utils/chat/owned-chat";

export const deleteChatAction = actionClient
  .metadata({ name: "deleteChat" })
  .inputSchema(deleteChatBody)
  .action(async ({ ctx: { userId }, parsedInput: { chatId } }) => {
    const deleted = await softDeleteChat({ chatId, userId });
    if (!deleted) throw new SafeError("Chat not found.");
  });

export const renameChatAction = actionClient
  .metadata({ name: "renameChat" })
  .inputSchema(renameChatBody)
  .action(async ({ ctx: { userId }, parsedInput: { chatId, name } }) => {
    const result = await prisma.chat.updateMany({
      where: { ...ownedChatWhere({ chatId, userId }), deletedAt: null },
      data: { name },
    });

    if (result.count === 0) throw new SafeError("Chat not found.");
  });

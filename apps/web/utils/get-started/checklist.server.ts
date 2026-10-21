import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import type { GetStartedFacts } from "@/utils/get-started/checklist";
import prisma from "@/utils/prisma";

/**
 * The checklist steps the database already records, for these accounts:
 * a connected calendar, a chat with Cue, and a reply Cue drafted that was
 * sent. One grouped query each, so it serves one person or the whole beta.
 */
export async function getGetStartedFacts(
  emailAccountIds: string[],
): Promise<GetStartedFacts> {
  if (!emailAccountIds.length) {
    return {
      calendarAccountIds: new Set(),
      chatAccountIds: new Set(),
      sentSuggestionAccountIds: new Set(),
    };
  }
  const inAccounts = { emailAccountId: { in: emailAccountIds } };
  const [calendars, chats, sent] = await Promise.all([
    prisma.calendarConnection.groupBy({
      by: ["emailAccountId"],
      where: { ...inAccounts, isConnected: true },
    }),
    prisma.chat.groupBy({ by: ["emailAccountId"], where: inAccounts }),
    prisma.executedRule.groupBy({
      by: ["emailAccountId"],
      where: {
        ...inAccounts,
        actionItems: {
          some: {
            type: ActionType.DRAFT_EMAIL,
            draftStatus: DraftEmailStatus.LIKELY_SENT,
          },
        },
      },
    }),
  ]);
  const ids = (rows: { emailAccountId: string }[]) =>
    new Set(rows.map((row) => row.emailAccountId));
  return {
    calendarAccountIds: ids(calendars),
    chatAccountIds: ids(chats),
    sentSuggestionAccountIds: ids(sent),
  };
}

import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import {
  getConnectionsLostOnRemoval,
  remainingEmailAccountQuery,
} from "@/utils/user/move-shared-connections";

export type GetEmailAccountRemovalImpactResponse = Awaited<
  ReturnType<typeof getData>
>;

export const GET = withEmailAccount(
  "user/email-account/removal-impact",
  async (request) => {
    const result = await getData({
      emailAccountId: request.auth.emailAccountId,
      userId: request.auth.userId,
    });
    return NextResponse.json(result);
  },
);

async function getData({
  emailAccountId,
  userId,
}: {
  emailAccountId: string;
  userId: string;
}) {
  const remaining = await prisma.emailAccount.findFirst({
    ...remainingEmailAccountQuery({
      userId,
      removedEmailAccountId: emailAccountId,
    }),
    select: { id: true },
  });
  // Removing the only mailbox is refused, so nothing would be lost to it.
  if (!remaining) return { lostConnections: [] };
  return {
    lostConnections: await getConnectionsLostOnRemoval({
      userId,
      fromEmailAccountId: emailAccountId,
      toEmailAccountId: remaining.id,
    }),
  };
}

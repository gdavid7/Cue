import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import {
  onePerExternalAccount,
  ownedBySameUser,
} from "@/utils/user/owned-by-same-user";
import { withEmailAccount } from "@/utils/middleware";

export type GetDriveConnectionsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount(
  "user/drive/connections",
  async (request) => {
    const { emailAccountId } = request.auth;

    const result = await getData({ emailAccountId });
    return NextResponse.json(result);
  },
);

async function getData({ emailAccountId }: { emailAccountId: string }) {
  // Drives belong to the person: one connected from any of their mailboxes
  // shows, and works, in all of them.
  const connections = await prisma.driveConnection.findMany({
    where: ownedBySameUser(emailAccountId),
    select: {
      id: true,
      email: true,
      provider: true,
      isConnected: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return { connections: onePerExternalAccount(connections) };
}

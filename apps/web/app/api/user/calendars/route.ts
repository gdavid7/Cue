import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import { onePerExternalAccount } from "@/utils/user/owned-by-same-user";

export type GetCalendarsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("user/calendars", async (request) => {
  const { emailAccountId } = request.auth;

  const result = await getData({ emailAccountId });
  return NextResponse.json(result);
});

async function getData({ emailAccountId }: { emailAccountId: string }) {
  const [emailAccount, connections] = await Promise.all([
    prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { timezone: true, calendarBookingLink: true },
    }),
    prisma.calendarConnection.findMany({
      where: calendarConnectionsWhere(emailAccountId),
      select: {
        id: true,
        email: true,
        provider: true,
        isConnected: true,
        calendars: {
          select: {
            id: true,
            name: true,
            isEnabled: true,
            primary: true,
            description: true,
            timezone: true,
          },
          orderBy: {
            name: "asc",
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    connections: onePerExternalAccount(connections),
    timezone: emailAccount?.timezone || null,
    calendarBookingLink: emailAccount?.calendarBookingLink || null,
  };
}

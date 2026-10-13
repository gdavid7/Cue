import { NextResponse } from "next/server";
import { getConnectedDriveApps } from "@/utils/attachments/save-to-drive";
import { hasUsableCalendarConnection } from "@/utils/calendar/event-provider";
import { withEmailAccount } from "@/utils/middleware";

export type GetSaveDestinationsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount(
  "user/save-destinations",
  async (request) => {
    const { emailAccountId } = request.auth;
    return NextResponse.json(await getData(emailAccountId));
  },
);

// Where the reader can send things from an email: the same checks that decide
// whether chat gets its calendar and drive tools.
async function getData(emailAccountId: string) {
  const [calendar, drives] = await Promise.all([
    hasUsableCalendarConnection(emailAccountId),
    getConnectedDriveApps(emailAccountId),
  ]);
  return { calendar, drives };
}

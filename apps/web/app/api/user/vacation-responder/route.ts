import { NextResponse } from "next/server";
import type { EmailProvider } from "@/utils/email/types";
import { withEmailProvider } from "@/utils/middleware";

export type VacationResponderResponse = Awaited<
  ReturnType<typeof getVacationResponder>
>;

export const GET = withEmailProvider(
  "user/vacation-responder",
  async (request) =>
    NextResponse.json(await getVacationResponder(request.emailProvider)),
);

async function getVacationResponder(provider: EmailProvider) {
  const settings = await provider.getVacationResponder();
  return {
    ...settings,
    startTime: settings.startTime?.toISOString() ?? null,
    endTime: settings.endTime?.toISOString() ?? null,
  };
}

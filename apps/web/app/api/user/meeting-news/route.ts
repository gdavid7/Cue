import { NextResponse } from "next/server";
import { getMeetingNews } from "@/utils/home/meeting-news";
import { withEmailAccount } from "@/utils/middleware";

export type GetMeetingNewsResponse = {
  meetings: Awaited<ReturnType<typeof getMeetingNews>>;
};

export const maxDuration = 30;

export const GET = withEmailAccount("user/meeting-news", async (request) =>
  NextResponse.json({
    meetings: await getMeetingNews({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      logger: request.logger,
    }),
  } satisfies GetMeetingNewsResponse),
);

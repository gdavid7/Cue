import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { answerSearch } from "@/utils/thread-context/search-answer";

const searchAnswerQuery = z.object({
  q: z.string().trim().min(1).max(300),
});

export type GetSearchAnswerResponse = Awaited<ReturnType<typeof answerSearch>>;

export const maxDuration = 30;

export const GET = withEmailProvider("user/search-answer", async (request) => {
  const { q } = searchAnswerQuery.parse({
    q: new URL(request.url).searchParams.get("q"),
  });

  return NextResponse.json(
    (await answerSearch({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      query: q,
      emailProvider: request.emailProvider,
      logger: request.logger,
    })) satisfies GetSearchAnswerResponse,
  );
});

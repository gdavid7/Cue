import { NextResponse } from "next/server";
import { z } from "zod";
import { hasCueReadMail } from "@/utils/home/get-home";
import { HOME_CUE_MAX_ACCOUNTS } from "@/utils/home/today-constants";
import type { Logger } from "@/utils/logger";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

const querySchema = z.object({
  ids: z
    .array(z.string())
    .transform((values) => [
      ...new Set(values.flatMap((value) => value.split(",")).filter(Boolean)),
    ])
    .pipe(z.array(z.string()).min(1).max(HOME_CUE_MAX_ACCOUNTS)),
});

export type GetHomeCueResponse = Awaited<ReturnType<typeof getHomeCue>>;

// Whether Cue has read each mailbox Today shows. Today's own answer says so
// too, but waits on Gmail for seconds; this is two database reads a mailbox,
// so a new one can show what's waiting on the user from local mail first.
export const GET = withAuth("user/home/cue", async (request) => {
  const query = querySchema.safeParse({
    ids: new URL(request.url).searchParams.getAll("ids"),
  });
  if (!query.success)
    return NextResponse.json({ error: "Invalid account ids" }, { status: 400 });
  const result = await getHomeCue(
    request.auth.userId,
    query.data.ids,
    request.logger,
  );
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

/**
 * Only the user's own accounts answer. One whose reads failed is left out,
 * as unknown, so Today waits for its answer rather than guess it is new.
 */
async function getHomeCue(userId: string, ids: string[], logger: Logger) {
  const accounts = await prisma.emailAccount.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  const answers = await Promise.allSettled(
    accounts.map(async ({ id }) => ({
      id,
      hasReadMail: await hasCueReadMail(id),
    })),
  );
  return {
    accounts: answers.flatMap((answer, index) => {
      if (answer.status === "fulfilled") return [answer.value];
      logger.warn("Could not tell whether Cue has read a mailbox", {
        emailAccountId: accounts[index]?.id,
        error: answer.reason,
      });
      return [];
    }),
  };
}

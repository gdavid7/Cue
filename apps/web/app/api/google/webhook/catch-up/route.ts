import { NextResponse } from "next/server";
import { z } from "zod";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { withQstashOrInternal } from "@/utils/qstash";
import {
  getGmailHistoryCatchUp,
  getGmailHistoryCatchUpTarget,
} from "@/utils/redis/gmail-history-catch-up";
import { processHistoryForUser } from "@/utils/webhook/google/process-history";

export const maxDuration = 300;

const bodySchema = z.object({
  emailAccountId: z.string().min(1),
  historyId: z.string().regex(/^\d+$/),
});

// Delivered a minute or two after the Gmail quota gate deferred webhook
// history, so the account catches up without waiting for its next push.
export const POST = withError(
  "google/webhook/catch-up",
  withQstashOrInternal(async (request) => {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const { emailAccountId, historyId } = parsed.data;
    const logger = request.logger.with({ emailAccountId });

    // Any push since the deferral that got through cleared the mark.
    if (!(await getGmailHistoryCatchUp(emailAccountId, logger))) {
      logger.info("Gmail history already caught up");
      return NextResponse.json({ ok: true });
    }

    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { email: true, lastSyncedHistoryId: true },
    });
    if (!emailAccount) return NextResponse.json({ ok: true });

    // Deliveries in one window share a body, and a run's cursor can pass the
    // history a delivery names, so it aims for the furthest history asked for.
    const storedTarget = await getGmailHistoryCatchUpTarget(
      emailAccountId,
      logger,
    );
    const target =
      storedTarget && BigInt(storedTarget) > BigInt(historyId)
        ? storedTarget
        : historyId;

    // A push or another catch-up already processed this far.
    const { lastSyncedHistoryId } = emailAccount;
    if (
      lastSyncedHistoryId &&
      /^\d+$/.test(lastSyncedHistoryId) &&
      BigInt(lastSyncedHistoryId) >= BigInt(target)
    ) {
      logger.info("Gmail history already caught up", {
        lastSyncedHistoryId,
        target,
      });
      return NextResponse.json({ ok: true });
    }

    await processHistoryForUser(
      { emailAddress: emailAccount.email, historyId: target },
      {},
      logger,
    );
    return NextResponse.json({ ok: true });
  }),
);

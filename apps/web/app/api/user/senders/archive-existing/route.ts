import { NextResponse } from "next/server";
import { z } from "zod";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { createEmailProvider } from "@/utils/email/provider";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { withQstashOrInternal } from "@/utils/qstash";
import { runQueuedSenderArchive } from "@/utils/senders/archive-existing";

export const maxDuration = 300;

const bodySchema = z.object({
  emailAccountId: z.string().min(1),
  provider: z.string().min(1),
  senderEmail: z.string().min(1),
  ownerEmail: z.string().min(1),
  deferrals: z.number().int().nonnegative(),
});

// Delivered once the Gmail quota gate's deferral of a queued sender archive
// has passed, so the archive resumes instead of being lost.
export const POST = withError(
  "user/senders/archive-existing",
  withQstashOrInternal(async (request) => {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const { emailAccountId, provider, senderEmail, ownerEmail, deferrals } =
      parsed.data;
    const logger = request.logger.with({ emailAccountId });

    // The person may have stopped auto-archiving this sender while the
    // archive waited.
    const sender = await prisma.newsletter.findFirst({
      where: {
        emailAccountId,
        email: { equals: senderEmail, mode: "insensitive" },
      },
      select: { status: true },
    });
    if (sender?.status !== NewsletterStatus.AUTO_ARCHIVED) {
      logger.info("Sender no longer auto-archived; skipping queued archive");
      return NextResponse.json({ ok: true });
    }

    const emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    await runQueuedSenderArchive({
      emailAccountId,
      emailProvider,
      senderEmail,
      ownerEmail,
      logger,
      deferrals,
    });
    return NextResponse.json({ ok: true });
  }),
);

import { NextResponse } from "next/server";
import { z } from "zod";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { createEmailProvider } from "@/utils/email/provider";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { withQstashOrInternal } from "@/utils/qstash";
import { runQueuedSenderArchive } from "@/utils/senders/archive-existing";

export const maxDuration = 300;

// The sender is named by its row and the owner by the account, so the queue
// never holds an address (founder rule R-1).
const bodySchema = z.object({
  emailAccountId: z.string().min(1),
  provider: z.string().min(1),
  newsletterId: z.string().min(1).optional(),
  // TODO(RD-3b): remove after one deploy. Resumes queued before ids replaced
  // addresses still carry them.
  senderEmail: z.string().min(1).optional(),
  startedAt: z.number().int().positive(),
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
    const {
      emailAccountId,
      provider,
      newsletterId,
      senderEmail,
      startedAt,
      deferrals,
    } = parsed.data;
    const logger = request.logger.with({ emailAccountId });

    if (!newsletterId && !senderEmail) {
      return new Response("Invalid payload structure", { status: 400 });
    }

    // The person may have stopped auto-archiving this sender while the
    // archive waited.
    const [sender, emailAccount] = await Promise.all([
      prisma.newsletter.findFirst({
        where: newsletterId
          ? { id: newsletterId, emailAccountId }
          : {
              emailAccountId,
              email: { equals: senderEmail, mode: "insensitive" },
            },
        select: { email: true, status: true },
      }),
      prisma.emailAccount.findUnique({
        where: { id: emailAccountId },
        select: { email: true },
      }),
    ]);
    if (!sender || sender.status !== NewsletterStatus.AUTO_ARCHIVED) {
      logger.info("Sender no longer auto-archived; skipping queued archive");
      return NextResponse.json({ ok: true });
    }
    if (!emailAccount) {
      logger.info("Email account no longer exists; skipping queued archive");
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
      senderEmail: sender.email,
      ownerEmail: emailAccount.email,
      logger,
      startedAt,
      deferrals,
    });
    return NextResponse.json({ ok: true });
  }),
);

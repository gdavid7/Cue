import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureEmailAccountsWatched } from "@/utils/email/watch-manager";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 60;

const bodySchema = z.object({
  emailAccountId: z.string().min(1),
  deferrals: z.number().int().nonnegative(),
});

// Delivered once the Gmail quota gate's deferral of a mailbox's watch has
// passed, so push starts within seconds instead of at the next renewal.
export const POST = withError(
  "watch/resume",
  withQstashOrInternal(async (request) => {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const { emailAccountId, deferrals } = parsed.data;

    await ensureEmailAccountsWatched({
      userIds: null,
      emailAccountId,
      deferrals,
      logger: request.logger.with({ emailAccountId }),
    });
    return NextResponse.json({ ok: true });
  }),
);

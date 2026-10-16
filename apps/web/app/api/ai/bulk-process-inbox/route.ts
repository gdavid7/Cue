import { NextResponse } from "next/server";
import { z } from "zod";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

export const maxDuration = 300;

const bodySchema = z.object({
  emailAccountId: z.string().min(1),
  provider: z.string().min(1),
  maxEmails: z.number().int().positive(),
  skipArchive: z.boolean(),
  ruleIds: z.array(z.string().min(1)).optional(),
  startedAt: z.number().int().positive(),
  processedTotal: z.number().int().nonnegative(),
  deferrals: z.number().int().nonnegative(),
});

// Delivered once the Gmail quota gate's deferral of a bulk inbox sort has
// passed, so the sort resumes instead of being lost.
export const POST = withError(
  "ai/bulk-process-inbox",
  withQstashOrInternal(async (request) => {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const { emailAccountId, ...job } = parsed.data;
    const logger = request.logger.with({ emailAccountId });

    const emailAccount = await getEmailAccountForRuleExecution({
      emailAccountId,
    });
    if (!emailAccount) return NextResponse.json({ ok: true });

    await bulkProcessInboxEmails({ ...job, emailAccount, logger });
    return NextResponse.json({ ok: true });
  }),
);

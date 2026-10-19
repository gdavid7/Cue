import { NextResponse } from "next/server";
import { matchingBulkJobSchema } from "@/utils/actions/mail-bulk-matching.validation";
import { withEmailAccount } from "@/utils/middleware";
import { mailBulkJobStore } from "@/utils/redis/mail-bulk-job";

export type GetMailBulkJobResponse = NonNullable<
  Awaited<ReturnType<typeof getData>>
>;

// Polled by the progress toast of a bulk action on every matching conversation.
export const GET = withEmailAccount(
  "user/mail/bulk-jobs",
  async (request, context) => {
    const { jobId } = matchingBulkJobSchema.parse(await context.params);
    const data = await getData({
      jobId,
      emailAccountId: request.auth.emailAccountId,
    });
    if (!data)
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(data);
  },
);

async function getData({
  jobId,
  emailAccountId,
}: {
  jobId: string;
  emailAccountId: string;
}) {
  const job = await mailBulkJobStore.get(jobId);
  if (!job || job.emailAccountId !== emailAccountId) return null;
  return {
    action: job.action,
    status: job.status,
    total: job.total,
    conversations: job.conversations,
    applied: job.applied,
    failed: job.failed,
    capped: job.capped,
  };
}

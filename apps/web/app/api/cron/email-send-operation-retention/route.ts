import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret, runCronJob } from "@/utils/cron";
import { deleteExpiredEmailSendOperations } from "@/utils/email-send-operation-retention";
import { captureException } from "@/utils/error";
import { type RequestWithLogger, withError } from "@/utils/middleware";

export const maxDuration = 300;

export const GET = withError(
  "cron/email-send-operation-retention",
  async (request) => {
    if (!hasCronSecret(request)) {
      captureException(
        new Error(
          "Unauthorized request: api/cron/email-send-operation-retention",
        ),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    return runRetention(request);
  },
);

export const POST = withError(
  "cron/email-send-operation-retention",
  async (request) => {
    if (!(await hasPostCronSecret(request))) {
      captureException(
        new Error(
          "Unauthorized cron request: api/cron/email-send-operation-retention",
        ),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    return runRetention(request);
  },
);

async function runRetention(request: RequestWithLogger) {
  const result = await runCronJob({
    cron: "cron/email-send-operation-retention",
    logger: request.logger,
    run: async () => ({ deleted: await deleteExpiredEmailSendOperations() }),
  });
  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret, runCronJob } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { type RequestWithLogger, withError } from "@/utils/middleware";
import { cleanupConfiguredAIDrafts } from "@/utils/ai/draft-cleanup";

export const maxDuration = 300;

const CRON_NAME = "cron/draft-cleanup";

export const GET = withError(
  CRON_NAME,
  async (request) => {
    if (!hasCronSecret(request)) {
      captureException(
        new Error("Unauthorized request: api/cron/draft-cleanup"),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    return runDraftCleanup(request);
  },
  { maxDuration },
);

export const POST = withError(
  CRON_NAME,
  async (request) => {
    if (!(await hasPostCronSecret(request))) {
      captureException(
        new Error("Unauthorized cron request: api/cron/draft-cleanup"),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    return runDraftCleanup(request);
  },
  { maxDuration },
);

async function runDraftCleanup(request: RequestWithLogger) {
  const result = await runCronJob({
    cron: CRON_NAME,
    logger: request.logger,
    run: () => cleanupConfiguredAIDrafts({ logger: request.logger }),
  });

  return NextResponse.json(result);
}

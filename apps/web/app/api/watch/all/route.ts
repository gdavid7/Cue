import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret, runCronJob } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import {
  ensureEmailAccountsWatched,
  type WatchEmailAccountResult,
} from "@/utils/email/watch-manager";
import { notifyLapsedWatches } from "@/utils/email/notify-lapsed-watches";

export const maxDuration = 300;

const CRON_NAME = "watch/all";

export const GET = withError(
  CRON_NAME,
  async (request) => {
    if (!hasCronSecret(request)) {
      captureException(new Error("Unauthorized cron request: api/watch/all"));
      return new Response("Unauthorized", { status: 401 });
    }

    return watchAllEmails(request.logger);
  },
  { maxDuration },
);

export const POST = withError(
  CRON_NAME,
  async (request) => {
    if (!(await hasPostCronSecret(request))) {
      captureException(new Error("Unauthorized cron request: api/watch/all"));
      return new Response("Unauthorized", { status: 401 });
    }

    return watchAllEmails(request.logger);
  },
  { maxDuration },
);

async function watchAllEmails(logger: Logger) {
  try {
    // The per-account results go in the response; the log line keeps counts.
    let results: WatchEmailAccountResult[] = [];
    await runCronJob({
      cron: CRON_NAME,
      logger,
      run: async () => {
        results = await ensureEmailAccountsWatched({ userIds: null, logger });

        // Runs after the renewal pass so only watches still failing renewal
        // count as lapsed.
        try {
          await notifyLapsedWatches({ logger });
        } catch (error) {
          logger.error("Failed to notify lapsed watches", { error });
          captureException(error);
        }

        return {
          watched: results.filter((result) => result.status === "success")
            .length,
          failed: results.filter((result) => result.status === "error").length,
        };
      },
    });

    return NextResponse.json({ success: true, results });
  } catch (error) {
    logger.error("Failed to watch all emails", { error });
    throw error;
  }
}

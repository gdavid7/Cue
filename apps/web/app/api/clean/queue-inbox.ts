import { z } from "zod";
import {
  type CleanThreadBody,
  cleanThreadBody,
} from "@/app/api/clean/controller";
import { getUnhandledCount } from "@/utils/assess";
import type { EmailProvider } from "@/utils/email/types";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import { GmailLabel } from "@/utils/gmail/label";
import { getInboxZeroLabelNames } from "@/utils/label";
import type { Logger } from "@/utils/logger";
import { isDefined } from "@/utils/types";
import { bulkPublishToQstash } from "@/utils/upstash";

export const CLEAN_INBOX_RESUME_PATH = "/api/clean/resume";

export const cleanInboxQueueBody = cleanThreadBody
  .omit({ threadId: true })
  .extend({
    maxEmails: z.number().optional(),
    /** Only threads before this time (ms), fixed when the job started. */
    before: z.number().optional(),
    /** Which inbox threads the job cleans, decided when it started. */
    labelType: z.enum(["inbox", "unread"]).optional(),
    /** The page the job reads next. */
    pageToken: z.string().optional(),
    queuedCount: z.number().int().nonnegative(),
    deferrals: z.number().int().nonnegative(),
  });
export type CleanInboxQueueBody = z.infer<typeof cleanInboxQueueBody>;

/**
 * Pages through the inbox and queues each thread for cleaning. When the Gmail
 * quota gate defers a read, the job resumes later from the page it stopped
 * at, with the filters it started with.
 */
export async function queueCleanInboxThreads({
  emailProvider,
  logger,
  ...job
}: CleanInboxQueueBody & { emailProvider: EmailProvider; logger: Logger }) {
  const {
    emailAccountId,
    jobId,
    action,
    instructions,
    skips,
    markedDoneLabelId,
    processedLabelId,
    maxEmails,
    before,
  } = job;
  let { labelType, pageToken, queuedCount } = job;

  try {
    labelType ??= (await getUnhandledCount(emailProvider)).type;

    do {
      const { threads, nextPageToken } =
        await emailProvider.getThreadsWithQuery({
          query: {
            ...(before !== undefined && { before: new Date(before) }),
            labelIds:
              labelType === "inbox"
                ? [GmailLabel.INBOX]
                : [GmailLabel.INBOX, GmailLabel.UNREAD],
            excludeLabelNames: getInboxZeroLabelNames("processed"),
          },
          maxResults: Math.min(maxEmails || 100, 100),
          pageToken,
        });

      logger.info("Fetched threads", {
        threadCount: threads.length,
        nextPageToken,
      });

      if (threads.length === 0) break;

      const items = threads
        .map((thread) => {
          if (!thread.id) return;
          return {
            path: "/api/clean",
            body: {
              emailAccountId,
              threadId: thread.id,
              markedDoneLabelId,
              processedLabelId,
              jobId,
              action,
              instructions,
              skips,
            } satisfies CleanThreadBody,
            // give every user their own queue for ai processing. if we get too many parallel users we may need more
            // api keys or a global queue
            // problem with a global queue is that if there's a backlog users will have to wait for others to finish first
            flowControl: {
              key: `ai-clean-${emailAccountId}`,
              parallelism: 3,
            },
            // A resumed job can read a page again if the inbox shifted under
            // its page token.
            deduplicationId: `clean-${jobId}-${thread.id}`,
          };
        })
        .filter(isDefined);

      logger.info("Pushing to Qstash", { threadCount: items.length });
      await bulkPublishToQstash({ items });

      queuedCount += items.length;
      pageToken = nextPageToken;
    } while (pageToken && !isMaxEmailsReached(queuedCount, maxEmails));
  } catch (error) {
    const resumed = await resumeAfterGmailDeferral({
      error,
      path: CLEAN_INBOX_RESUME_PATH,
      body: { ...job, labelType, pageToken, queuedCount },
      deferrals: job.deferrals,
      jobKey: `clean-inbox-${jobId}`,
      job: "queueing inbox threads to clean",
      logger,
    });
    if (!resumed)
      logger.error("Failed to queue inbox threads to clean", { error });
  }
}

function isMaxEmailsReached(queuedCount: number, maxEmails?: number) {
  if (!maxEmails) return false;
  return queuedCount >= maxEmails;
}

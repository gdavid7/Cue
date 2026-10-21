import {
  type MatchingScope,
  matchingScopeSchema,
} from "@/utils/actions/mail-bulk-matching.validation";
import prisma from "@/utils/prisma";

// A job writes its listing after every page and lives a day at most, so one
// untouched that long was left behind. The account's next job and the daily
// retention sweep drop it.
const ABANDONED_LISTING_MS = 24 * 60 * 60 * 1000;

/**
 * The view a bulk job lists and the page it reads next, kept in Postgres so
 * neither the user's search text nor a page link repeating it travels in a
 * queue payload or sits in Redis. Every read and write is scoped to the
 * account that owns the job.
 */
export const mailBulkJobListings = {
  async create({
    jobId,
    emailAccountId,
    scope,
    pageToken,
  }: {
    jobId: string;
    emailAccountId: string;
    scope: MatchingScope;
    pageToken?: string;
  }) {
    await prisma.mailBulkJobListing.deleteMany({
      where: {
        emailAccountId,
        updatedAt: { lt: abandonedBefore() },
      },
    });
    await prisma.mailBulkJobListing.create({
      data: { jobId, emailAccountId, scope, pageToken },
    });
  },

  async get(
    jobId: string,
    emailAccountId: string,
  ): Promise<{ scope: MatchingScope; pageToken?: string } | null> {
    const row = await prisma.mailBulkJobListing.findFirst({
      where: { jobId, emailAccountId },
      select: { scope: true, pageToken: true },
    });
    if (!row) return null;
    const scope = matchingScopeSchema.safeParse(row.scope);
    if (!scope.success) return null;
    return { scope: scope.data, pageToken: row.pageToken ?? undefined };
  },

  async setPageToken(
    jobId: string,
    emailAccountId: string,
    pageToken: string | undefined,
  ) {
    await prisma.mailBulkJobListing.updateMany({
      where: { jobId, emailAccountId },
      data: { pageToken: pageToken ?? null },
    });
  },

  async remove(jobId: string, emailAccountId: string) {
    await prisma.mailBulkJobListing.deleteMany({
      where: { jobId, emailAccountId },
    });
  },

  /** Every account's listings left behind; resolves how many were dropped. */
  async deleteAbandoned() {
    const { count } = await prisma.mailBulkJobListing.deleteMany({
      where: { updatedAt: { lt: abandonedBefore() } },
    });
    return count;
  },
};

function abandonedBefore() {
  return new Date(Date.now() - ABANDONED_LISTING_MS);
}

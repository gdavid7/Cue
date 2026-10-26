import { NextResponse } from "next/server";
import { z } from "zod";
import {
  canonicalizeEmailAddress,
  getNewsletterSenderDisplayName,
} from "@/utils/email";
import type { EmailProvider } from "@/utils/email/types";
import {
  OPEN_THREAD_GMAIL_WAIT_MS,
  runWithGmailWaitBudget,
} from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import { timeRequestPhase } from "@/utils/request-metrics";
import {
  getSenderEmailStats,
  senderStatsOrderBySchema,
} from "@/utils/sender-stats";
import {
  filterNewsletters,
  findAutoArchiveFilters,
  findNewsletterStatus,
  findSenderLabelFilters,
  getEmailFilters,
  getNewsletterStatuses,
} from "@/utils/senders/filters";

// The provider filters only mark which senders are auto-archived, and the
// list answers without them (`filtersAvailable: false`). A busy gate can hold
// the read for 15 s behind a sync, so it gets a short wait instead of holding
// up a list someone is looking at.
const FILTERS_GMAIL_WAIT_MS = 3000;

const newsletterStatsQuery = z.object({
  limit: z.coerce.number().int().positive().nullish(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  fromDate: z.coerce.number().nullish(),
  toDate: z.coerce.number().nullish(),
  orderBy: senderStatsOrderBySchema.optional(),
  orderDirection: z.enum(["asc", "desc"]).optional(),
  types: z
    .array(z.enum(["read", "unread", "archived", "unarchived", ""]))
    .transform((arr) => arr?.filter(Boolean)),
  filters: z
    .array(
      z.enum(["unhandled", "autoArchived", "unsubscribed", "approved", ""]),
    )
    .optional()
    .transform((arr) => arr?.filter(Boolean)),
  includeMissingUnsubscribe: z.boolean().optional(),
  search: z.string().optional(),
  // Set when a person is waiting on this read: the reader acting on one
  // sender, or the Bulk unsubscribe list loading a view they opened. Refreshes
  // leave it off, so only those reads jump ahead of background work.
  interactive: z.boolean().optional(),
});

export type NewsletterStatsQuery = z.infer<typeof newsletterStatsQuery>;
export type NewsletterStatsResponse = Awaited<
  ReturnType<typeof getEmailMessages>
>;

async function getEmailMessages(
  options: {
    emailAccountId: string;
    emailProvider: EmailProvider;
    logger: Logger;
  } & NewsletterStatsQuery,
) {
  const { emailAccountId, emailProvider } = options;
  const types = getTypeFilters(options.types);

  const [senderStats, filtersResult, newsletterStatuses] = await Promise.all([
    timeRequestPhase("senderStats", () =>
      getSenderEmailStats({
        emailAccountId,
        fromDate: options.fromDate,
        toDate: options.toDate,
        read: types.read,
        unread: types.unread,
        archived: types.archived,
        unarchived: types.unarchived,
        search: options.search,
        orderBy: options.orderBy,
        orderDirection: options.orderDirection,
        limit: options.limit,
        cursor: options.cursor,
      }),
    ),
    timeRequestPhase("filters", () => readEmailFilters(options)),
    timeRequestPhase("statuses", () =>
      getNewsletterStatuses({ emailAccountId }),
    ),
  ]);

  const { filters: emailFilters, available: filtersAvailable } = filtersResult;

  const newsletters = senderStats.senders.map((email) => {
    const from = canonicalizeEmailAddress(email.from);
    return {
      name: from,
      fromName: getNewsletterSenderDisplayName({
        email: from,
        fromName: email.fromName,
        minFromName: email.minFromName,
        maxFromName: email.fromName,
      }),
      value: email.count,
      inboxEmails: email.inboxEmails,
      readEmails: email.readEmails,
      lastEmailAt: email.lastEmailAt,
      unsubscribeLink: email.unsubscribeLink,
      autoArchived: findAutoArchiveFilters(
        emailFilters,
        from,
        emailProvider,
      )[0],
      labelFilters: findSenderLabelFilters(emailFilters, from),
      status: findNewsletterStatus(newsletterStatuses, from),
    };
  });
  const searchedSenderStatus = options.search
    ? findNewsletterStatus(newsletterStatuses, options.search)
    : undefined;

  // Cursor pages the aggregated sender list. Status filters run after that,
  // so a filtered page can be shorter than `limit` while `nextCursor` continues
  // from the last aggregated sender.
  return {
    newsletters: options.filters?.length
      ? filterNewsletters(newsletters, options.filters, { filtersAvailable })
      : newsletters,
    nextCursor: senderStats.nextCursor,
    searchedSenderStatus,
    // False when the provider filters could not be read, so a missing
    // autoArchived means unknown rather than off.
    filtersAvailable,
    // Why they could not be read, so a client knows whether asking again can
    // help: a refused grant needs the person, a refusal for now needs time.
    filtersFailure: filtersResult.available
      ? undefined
      : getFiltersFailure(filtersResult),
  };
}

export const GET = withEmailProvider(
  "user/stats/newsletters",
  async (request) => {
    const { emailProvider } = request;
    const { emailAccountId } = request.auth;

    const { searchParams } = new URL(request.url);
    const params = newsletterStatsQuery.parse({
      limit: searchParams.get("limit"),
      fromDate: searchParams.get("fromDate"),
      toDate: searchParams.get("toDate"),
      orderBy: searchParams.get("orderBy") || undefined,
      orderDirection: searchParams.get("orderDirection") || undefined,
      cursor: searchParams.get("cursor") || undefined,
      types: searchParams.get("types")?.split(",") || [],
      filters: searchParams.get("filters")?.split(",") || [],
      includeMissingUnsubscribe:
        searchParams.get("includeMissingUnsubscribe") === "true",
      search: searchParams.get("search") || undefined,
      interactive: searchParams.get("interactive") === "true",
    });

    const result = await getEmailMessages({
      ...params,
      emailAccountId,
      emailProvider,
      logger: request.logger,
    });

    return NextResponse.json(result);
  },
);

function readEmailFilters({
  emailProvider,
  logger,
  search,
  interactive,
}: {
  emailProvider: EmailProvider;
  logger: Logger;
  search?: string;
  interactive?: boolean;
}) {
  const read = () => getEmailFilters(emailProvider, logger);
  // A person is waiting, so the read goes ahead of background work. At
  // background it also queues for the account's few background in-flight
  // slots, which the wait budget does not bound: lists waited 7-13 s there.
  if (interactive)
    return runWithGmailWaitBudget(
      search ? OPEN_THREAD_GMAIL_WAIT_MS : FILTERS_GMAIL_WAIT_MS,
      read,
      { priority: "interactive" },
    );
  // A searched list waits for the filters in full.
  if (search) return read();
  return runWithGmailWaitBudget(FILTERS_GMAIL_WAIT_MS, read);
}

function getFiltersFailure(result: { permanent: boolean; throttled: boolean }) {
  if (result.permanent) return "permanent" as const;
  if (result.throttled) return "throttled" as const;
  return "error" as const;
}

function getTypeFilters(types: NewsletterStatsQuery["types"]) {
  const typeMap = Object.fromEntries(types.map((type) => [type, true]));

  // only use the read flag if unread is unmarked
  // if read and unread are both set or both unset, we don't need to filter by read/unread at all
  const read = Boolean(typeMap.read && !typeMap.unread);
  const unread = Boolean(!typeMap.read && typeMap.unread);

  // similar logic to read/unread
  const archived = Boolean(typeMap.archived && !typeMap.unarchived);
  const unarchived = Boolean(!typeMap.archived && typeMap.unarchived);

  // we only need AND if both read/unread and archived/unarchived are set
  const andClause = (read || unread) && (archived || unarchived);

  const all =
    !types.length ||
    types.length === 4 ||
    (!read && !unread && !archived && !unarchived);

  return {
    all,
    read,
    unread,
    archived,
    unarchived,
    andClause,
  };
}

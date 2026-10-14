import { cache } from "react";
import prisma from "@/utils/prisma";
import {
  buildMailPath,
  getSplitSlugs,
  type MailUrlView,
  withPageParams,
} from "@/utils/mail-url";
import { getMailSettings } from "@/utils/split-inbox/settings.server";
import { isInboxStyleLandingSplit } from "@/utils/split-inbox/inbox-styles";

/**
 * The signed-in user's accounts in the order they were connected. Position in
 * this list is the `n` in `/mail/u/{n}`, so it must stay deterministic: id
 * breaks ties between accounts created in the same instant. Removing an
 * account shifts the ones after it down, as signing out of one does in Gmail.
 */
export const getOrderedEmailAccountIds = cache(async (userId: string) => {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return accounts.map((account) => account.id);
});

/** Parameters the old `/{emailAccountId}/mail` address carried its view in. */
const LEGACY_MAIL_PARAMS = [
  "type",
  "labelId",
  "folderId",
  "split",
  "accountScope",
  "thread-id",
  "thread-account-id",
  "q",
];

/**
 * Translates an old `/{emailAccountId}/mail?split=…&thread-id=…` address into
 * the readable one, so bookmarks, emails and notifications keep working. Only
 * the user's own accounts resolve; any other id lands on their first inbox.
 * Labels and folders keep their provider id here, and the mail screen swaps it
 * for the slug once it has the names.
 */
export async function getMailRedirectPath({
  userId,
  emailAccountId,
  searchParams,
}: {
  userId: string;
  emailAccountId: string | null;
  searchParams?: Record<string, string | string[] | undefined>;
}): Promise<string | null> {
  const accountIds = await getOrderedEmailAccountIds(userId);
  if (!accountIds.length) return null;
  const ownedIndex = emailAccountId ? accountIds.indexOf(emailAccountId) : -1;
  const accountIndex = Math.max(ownedIndex, 0);
  const params = toSearchParams(searchParams);
  const owned = ownedIndex >= 0;

  const allInboxes = params.get("accountScope") === "all";
  const view = owned
    ? await getLegacyView(params, accountIds[accountIndex])
    : ({ kind: "inbox" } as const);
  const threadAccountId = params.get("thread-account-id");
  const threadAccountIndex =
    allInboxes && threadAccountId ? accountIds.indexOf(threadAccountId) : -1;

  const path = buildMailPath({
    accountIndex,
    allInboxes,
    view,
    threadId: owned ? params.get("thread-id") : null,
    threadAccountIndex: threadAccountIndex >= 0 ? threadAccountIndex : null,
  });

  return withPageParams(path, params.toString(), LEGACY_MAIL_PARAMS);
}

async function getLegacyView(
  params: URLSearchParams,
  emailAccountId: string,
): Promise<MailUrlView> {
  const q = params.get("q")?.trim();
  if (q) return { kind: "search", q };
  const labelId = params.get("labelId");
  if (labelId) return { kind: "label", slug: labelId };
  const folderId = params.get("folderId");
  if (folderId) return { kind: "folder", slug: folderId };
  const type = params.get("type");
  if (type && type !== "inbox" && type !== "label" && type !== "folder")
    return { kind: "type", type };

  const splitId = params.get("split");
  if (!splitId) return { kind: "inbox" };
  const { splits } = await getMailSettings({ emailAccountId });
  const slug = getSplitSlugs(splits).get(splitId);
  const landing = splits.find(isInboxStyleLandingSplit) ?? splits[0];
  if (!slug || landing?.id === splitId) return { kind: "inbox" };
  return { kind: "split", slug };
}

function toSearchParams(
  searchParams?: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      params.append(key, item);
  }
  return params;
}

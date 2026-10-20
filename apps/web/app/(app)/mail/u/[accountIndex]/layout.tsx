import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { InboxPreviewSeed } from "@/app/(app)/[emailAccountId]/mail/InboxPreviewList";
import { MailScreen } from "@/app/(app)/[emailAccountId]/mail/MailScreen";
import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";
import { auth } from "@/utils/auth";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  parseLastEmailAccountCookieValue,
} from "@/utils/cookies";
import {
  hasLocalMailbox,
  LOCAL_MAILBOX_COOKIE,
} from "@/utils/mail-engine/local-mailbox-cookie";
import {
  buildMailPath,
  MAIL_PATH_HEADER,
  parseAccountIndex,
  parseMailPath,
} from "@/utils/mail-url";
import { getOrderedEmailAccounts } from "@/utils/mail-url.server";
import { buildLoginRedirectUrl } from "@/utils/redirect";
import { isGoogleProvider } from "@/utils/email/provider-types";
import prisma from "@/utils/prisma";
import {
  findLandingSplit,
  getDefaultInboxStyle,
  getInboxStyleSplits,
  isInboxStyleCardPending,
} from "@/utils/split-inbox/inbox-styles";
import {
  type MailSplit,
  mailSplitToThreadsQuery,
} from "@/utils/split-inbox/split-query";
import { getMailSettings } from "@/utils/split-inbox/settings.server";
import { loadInboxPreview } from "@/utils/threads/inbox-preview.server";
import { createScopedLogger } from "@/utils/logger";
import { OFFLINE_MAIL_SAVE_HEADER } from "@/utils/offline/mail-cache";

const logger = createScopedLogger("mail/route-layout");
// Next.js names the server action a request runs in this header.
const SERVER_ACTION_HEADER = "next-action";

// The mail screen lives in the layout, not the page: a layout persists while
// the view below it (`inbox`, `sent`, a thread) changes, so switching views
// keeps the list, selection and mail engine instead of remounting them. The
// view is read from the address on the client.
export default async function MailRouteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ accountIndex: string }>;
}) {
  const [session, { accountIndex }] = await Promise.all([auth(), params]);
  // The proxy sends signed-out visits to log in with the full address; this
  // keeps at least the account when a session ends between the two checks.
  if (!session?.user)
    redirect(
      buildLoginRedirectUrl(`/mail/u/${encodeURIComponent(accountIndex)}`),
    );

  // Only the signed-in user's own accounts are numbered, so `/u/{n}` can never
  // reach someone else's mailbox.
  const accounts = await getOrderedEmailAccounts(session.user.id);
  if (!accounts.length) redirect("/connect-mailbox");
  // The same rule the client reads the address with, or its updates would
  // find no mail address to change.
  const index = parseAccountIndex(accountIndex);
  const account = index === null ? undefined : accounts[index];
  if (!account) {
    // Removing an earlier account shifts later ones down, so a position past
    // the end is most likely the account this browser was last in.
    const lastAccountId = parseLastEmailAccountCookieValue({
      userId: session.user.id,
      cookieValue: (await cookies()).get(LAST_EMAIL_ACCOUNT_COOKIE)?.value,
    });
    const lastIndex = accounts.findIndex(({ id }) => id === lastAccountId);
    redirect(buildMailPath({ accountIndex: Math.max(lastIndex, 0) }));
  }

  const { preview } = await startInboxPreview(account, session.user.id);
  return (
    <MailScreenLayout>
      {/* Always here, so the mail screen keeps its place in the tree. */}
      <InboxPreviewSeed emailAccountId={account.id} preview={preview}>
        <MailScreen />
      </InboxPreviewSeed>
      {children}
    </MailScreenLayout>
  );
}

/**
 * A browser with no local mailbox for the account, as after every sign-in,
 * would wait for the mail engine to boot and sync before showing any mail.
 * The inbox's newest conversations are fetched here instead, without being
 * awaited, so they stream to the page with its first response. Wrapped, as an
 * async function's returned promise would otherwise be awaited with it.
 */
async function startInboxPreview(
  account: { id: string; provider: string },
  userId: string,
) {
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
  const [pathname, search] = (headerStore.get(MAIL_PATH_HEADER) ?? "").split(
    "?",
  );
  // A server action that sets a cookie, such as the last account opened,
  // renders this layout again to answer it, and the service worker's offline
  // copy is a shell. Neither shows these rows (the page keeps the ones it
  // has), so neither spends Gmail quota on them during the first sync.
  if (
    headerStore.has(SERVER_ACTION_HEADER) ||
    headerStore.has(OFFLINE_MAIL_SAVE_HEADER)
  )
    return { preview: null };
  const location = parseMailPath(pathname ?? "", search);
  if (location?.view?.kind !== "inbox" || location.allInboxes)
    return { preview: null };
  if (hasLocalMailbox(cookieStore.get(LOCAL_MAILBOX_COOKIE)?.value, account.id))
    return { preview: null };
  return { preview: loadLandingInboxPreview(account, userId) };
}

// The rows are the newest of whatever `/inbox` opens on: the whole inbox's
// newest is mostly other tabs' mail, so an inbox that opens on Gmail's Primary
// is read by Primary's labels. Checked with the rows, not before the page is
// sent, so the page never waits on it.
async function loadLandingInboxPreview(
  account: { id: string; provider: string },
  userId: string,
) {
  const [settings, user] = await Promise.all([
    getMailSettings({ emailAccountId: account.id }).catch((error: unknown) => {
      logger.warn("Could not read the inbox's tabs for its preview", {
        emailAccountId: account.id,
        error,
      });
      return null;
    }),
    prisma.user
      .findUnique({ where: { id: userId }, select: { dismissedHints: true } })
      .catch(() => null),
  ]);
  if (!settings) return null;
  const landing = findLandingSplit(settings.splits);
  if (landing?.filters.length) {
    const labelIds = gmailTabLabelIds(account.provider, landing);
    if (!labelIds) return null;
    return loadInboxPreview({
      emailAccountId: account.id,
      provider: account.provider,
      tab: { splitId: landing.id, labelIds },
    });
  }
  // A new mailbox opens on All until its inbox style is chosen, which for
  // Gmail opens on Primary from then on, so Primary's newest mail is read
  // ahead for the mail engine rather than waiting on its first sync.
  const styleCardPending =
    !!user &&
    isInboxStyleCardPending({
      provider: account.provider,
      emailAccountId: account.id,
      dismissedHints: user.dismissedHints,
    });
  const defaultLanding = getInboxStyleSplits(
    getDefaultInboxStyle(account.provider),
  )[0];
  const readAhead =
    styleCardPending && defaultLanding
      ? gmailTabLabelIds(account.provider, {
          matchAll: true,
          filters: defaultLanding.filters,
        })
      : null;
  return loadInboxPreview({
    emailAccountId: account.id,
    provider: account.provider,
    ...(readAhead && { readAhead }),
  });
}

/** A tab Gmail can list by labels alone, as its categories are, or null. */
function gmailTabLabelIds(
  provider: string,
  split: Pick<MailSplit, "matchAll" | "filters">,
) {
  if (!isGoogleProvider(provider)) return null;
  const query = mailSplitToThreadsQuery(split);
  const onlyLabels = Object.keys(query).every((key) => key === "labelIds");
  return onlyLabels && query.labelIds?.length ? query.labelIds : null;
}

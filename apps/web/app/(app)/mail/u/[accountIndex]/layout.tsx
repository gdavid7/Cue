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
import { findLandingSplit } from "@/utils/split-inbox/inbox-styles";
import { getMailSettings } from "@/utils/split-inbox/settings.server";
import { loadInboxPreview } from "@/utils/threads/inbox-preview.server";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("mail/route-layout");

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

  const { preview } = await startInboxPreview(account);
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
async function startInboxPreview(account: { id: string; provider: string }) {
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
  const [pathname, search] = (headerStore.get(MAIL_PATH_HEADER) ?? "").split(
    "?",
  );
  const location = parseMailPath(pathname ?? "", search);
  if (location?.view?.kind !== "inbox" || location.allInboxes)
    return { preview: null };
  if (hasLocalMailbox(cookieStore.get(LOCAL_MAILBOX_COOKIE)?.value, account.id))
    return { preview: null };
  return { preview: loadLandingInboxPreview(account) };
}

// An inbox that opens on a tab, such as Gmail's Primary, would show its other
// tabs' mail and then swap to the tab. Checked with the rows, not before the
// page is sent, so the page never waits on it.
async function loadLandingInboxPreview(account: {
  id: string;
  provider: string;
}) {
  const settings = await getMailSettings({ emailAccountId: account.id }).catch(
    (error: unknown) => {
      logger.warn("Could not read the inbox's tabs for its preview", {
        emailAccountId: account.id,
        error,
      });
      return null;
    },
  );
  if (!settings || findLandingSplit(settings.splits)?.filters.length)
    return null;
  return loadInboxPreview({
    emailAccountId: account.id,
    provider: account.provider,
  });
}

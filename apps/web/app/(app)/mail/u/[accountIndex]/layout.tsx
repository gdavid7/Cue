import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { InboxPreviewSeed } from "@/app/(app)/[emailAccountId]/mail/InboxPreviewList";
import { MailScreen } from "@/app/(app)/[emailAccountId]/mail/MailScreen";
import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";
import { auth } from "@/utils/auth";
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
import { loadInboxPreview } from "@/utils/threads/inbox-preview.server";

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
  if (!account) redirect(buildMailPath({ accountIndex: 0 }));

  const { preview } = await startInboxPreview(account);
  const screen = <MailScreen />;
  return (
    <MailScreenLayout>
      {preview ? (
        <InboxPreviewSeed emailAccountId={account.id} preview={preview}>
          {screen}
        </InboxPreviewSeed>
      ) : (
        screen
      )}
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
  return {
    preview: loadInboxPreview({
      emailAccountId: account.id,
      provider: account.provider,
    }),
  };
}

import { redirect } from "next/navigation";
import { MailScreen } from "@/app/(app)/[emailAccountId]/mail/MailScreen";
import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";
import { auth } from "@/utils/auth";
import { buildMailPath, parseAccountIndex } from "@/utils/mail-url";
import { getOrderedEmailAccountIds } from "@/utils/mail-url.server";
import { buildLoginRedirectUrl } from "@/utils/redirect";

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
  const accountIds = await getOrderedEmailAccountIds(session.user.id);
  if (!accountIds.length) redirect("/connect-mailbox");
  // The same rule the client reads the address with, or its updates would
  // find no mail address to change.
  const index = parseAccountIndex(accountIndex);
  if (index === null || index >= accountIds.length)
    redirect(buildMailPath({ accountIndex: 0 }));

  return (
    <MailScreenLayout>
      <MailScreen />
      {children}
    </MailScreenLayout>
  );
}

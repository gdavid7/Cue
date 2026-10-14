import { redirect } from "next/navigation";
import { MailScreen } from "@/app/(app)/[emailAccountId]/mail/MailScreen";
import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";
import { auth } from "@/utils/auth";
import { buildMailPath } from "@/utils/mail-url";
import { getOrderedEmailAccountIds } from "@/utils/mail-url.server";

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
  if (!session?.user) redirect("/login");

  // Only the signed-in user's own accounts are numbered, so `/u/{n}` can never
  // reach someone else's mailbox.
  const accountIds = await getOrderedEmailAccountIds(session.user.id);
  if (!accountIds.length) redirect("/connect-mailbox");
  const index = /^\d+$/.test(accountIndex) ? Number(accountIndex) : -1;
  if (index < 0 || index >= accountIds.length)
    redirect(buildMailPath({ accountIndex: 0 }));

  return (
    <MailScreenLayout>
      <MailScreen />
      {children}
    </MailScreenLayout>
  );
}

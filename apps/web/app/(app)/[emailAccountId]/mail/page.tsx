import { redirect } from "next/navigation";
import { auth } from "@/utils/auth";
import { buildLoginRedirectUrl, buildRedirectUrl } from "@/utils/redirect";
import { getMailRedirectPath } from "@/utils/mail-url.server";

// The mail screen moved to `/mail/u/{n}/…`. Old links — bookmarks, emails,
// notifications, installed apps — still arrive here and are translated.
export default async function LegacyMailPage({
  params,
  searchParams,
}: {
  params: Promise<{ emailAccountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ emailAccountId }, query, session] = await Promise.all([
    params,
    searchParams,
    auth(),
  ]);
  if (!session?.user) {
    redirect(
      buildLoginRedirectUrl(buildRedirectUrl(`/${emailAccountId}/mail`, query)),
    );
  }

  const path = await getMailRedirectPath({
    userId: session.user.id,
    emailAccountId,
    searchParams: query,
  });
  redirect(path ?? "/connect-mailbox");
}

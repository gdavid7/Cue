import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AddAccount } from "@/components/AddAccount";
import { MutedText } from "@/components/Typography";
import { auth } from "@/utils/auth";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";
import { getConnectMailboxNextPath } from "@/utils/connect-mailbox";
import prisma from "@/utils/prisma";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import { getEnabledMailboxProviders } from "@/utils/oauth/provider-config";

export const metadata: Metadata = {
  title: getBrandTitle("Connect Mailbox"),
  description: `Connect a Google or Microsoft mailbox to continue to ${BRAND_NAME}.`,
  alternates: { canonical: "/connect-mailbox" },
};

export default async function ConnectMailboxPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const session = await auth();

  if (!session?.user) redirect("/login");

  const nextPath = getConnectMailboxNextPath(searchParams?.next);
  const emailAccount = await prisma.emailAccount.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (emailAccount) redirect(nextPath);

  const enabledProviders = getEnabledMailboxProviders();
  const hasOutlook = enabledProviders.includes("microsoft");
  const hasGmail = enabledProviders.includes("google");
  const providerNames = [hasGmail && "Gmail", hasOutlook && "Outlook"]
    .filter(Boolean)
    .join(" or ");
  const dataProviders = [hasGmail && "Google", hasOutlook && "Microsoft"]
    .filter(Boolean)
    .join(" and ");

  return (
    <div className="flex min-h-screen flex-col justify-center text-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4">
        <div className="text-center">
          <h1 className="font-title text-2xl text-foreground">
            Connect your mailbox
          </h1>
          <p className="mt-4 text-muted-foreground">
            Connect {providerNames || "your mailbox"} to start using{" "}
            {BRAND_NAME}.
          </p>
        </div>

        <MailboxProvidersProvider enabledProviders={enabledProviders}>
          <AddAccount helperText="You can add more mailboxes later from Accounts." />
        </MailboxProvidersProvider>

        <MutedText className="text-center">
          {dataProviders || "Your provider"}{" "}
          {dataProviders.includes(" and ") ? "are" : "is"} used here only to
          connect your inbox data.
        </MutedText>
      </div>
    </div>
  );
}

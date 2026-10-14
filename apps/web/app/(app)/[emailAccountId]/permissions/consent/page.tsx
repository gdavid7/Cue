"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeading, TypographyP } from "@/components/Typography";
import { useAccount } from "@/providers/EmailAccountProvider";
import { toastError } from "@/components/Toast";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { BRAND_NAME } from "@/utils/branding";
import { redirectToSafeUrl } from "@/utils/redirect";
import { GOOGLE_OAUTH_TESTING_MODE } from "@/utils/access/config";
import { CONSENT_REASON_EXPIRED } from "@/utils/permissions-consent";

const REQUIRED_PERMISSIONS = [
  {
    name: "Your name and email address",
    why: "to know which account is yours.",
  },
  {
    name: "Read and organize your mail",
    why: `so ${BRAND_NAME} can sort it into tabs, run your rules and save reply drafts.`,
  },
  {
    name: "Send mail as you",
    why: "only for replies you send, or rules you set up to send.",
  },
  {
    name: "Mailbox settings",
    why: "to read your signature, time zone and out-of-office.",
  },
];

export default function PermissionsConsentPage() {
  const {
    emailAccountId,
    userEmail,
    provider,
    isLoading: accountLoading,
  } = useAccount();
  const searchParams = useSearchParams();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isMicrosoft = provider === "microsoft";
  const isExpired = searchParams.get("reason") === CONSENT_REASON_EXPIRED;

  const handleReconnect = async () => {
    setIsReconnecting(true);

    try {
      const accountProvider = isMicrosoft ? "microsoft" : "google";
      const url = await getAccountLinkingUrl(accountProvider, {
        reconnectEmailAccountId: emailAccountId,
      });
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      toastError({
        title: "Couldn't start signing in",
        description:
          error instanceof Error
            ? error.message
            : "Check your connection and try again.",
      });
    } finally {
      setIsReconnecting(false);
    }
  };

  const reconnectButton = (label: string) => (
    <Button
      className="mt-6"
      size="lg"
      onClick={handleReconnect}
      loading={isReconnecting}
      disabled={isReconnecting || accountLoading}
    >
      {label}
    </Button>
  );

  const signOutHint = (
    <p className="mt-8 text-center text-muted-foreground text-sm">
      Having trouble?{" "}
      <Link href="/logout" className="underline hover:text-foreground">
        Sign out
      </Link>{" "}
      and sign back in.
    </p>
  );

  if (isExpired) {
    const providerName = isMicrosoft ? "Microsoft" : "Google";
    return (
      <div className="flex flex-col items-center justify-center px-4 py-16 sm:p-20 md:p-32">
        <PageHeading className="text-center">
          Sign in again to reconnect {isMicrosoft ? "Outlook" : "Gmail"}
        </PageHeading>
        <TypographyP className="mx-auto mt-4 max-w-prose text-center">
          {providerName} signed {BRAND_NAME} out
          {userEmail ? ` of ${userEmail}` : ""}. Your mail and settings are
          still here, and new mail picks up where it left off.
        </TypographyP>
        {!isMicrosoft && GOOGLE_OAUTH_TESTING_MODE && (
          <TypographyP className="mx-auto mt-2 max-w-prose text-center text-muted-foreground text-sm">
            During the beta, Google asks you to do this about once a week.
          </TypographyP>
        )}
        {reconnectButton("Sign in again")}
        {signOutHint}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 sm:p-20 md:p-32">
      <PageHeading className="text-center">
        {BRAND_NAME} needs a few more permissions
      </PageHeading>

      <TypographyP className="mx-auto mt-4 max-w-prose text-center">
        {isMicrosoft
          ? `Your Microsoft account is connected, but ${BRAND_NAME} is missing one or more required Microsoft 365 permissions.`
          : `Sign in again and allow each permission so ${BRAND_NAME} can work.`}
      </TypographyP>

      {isMicrosoft && (
        <TypographyP className="mx-auto mt-3 max-w-prose text-center text-muted-foreground">
          If your organization restricts user consent, ask your Microsoft 365
          admin to approve {BRAND_NAME} and then reconnect your account.
        </TypographyP>
      )}
      {!isMicrosoft && (
        <div className="mx-auto mt-6 w-full max-w-prose">
          <p className="font-medium text-sm">
            When you reconnect, approve these so {BRAND_NAME} can work:
          </p>
          <ul className="mt-2 space-y-2 text-left text-sm">
            {REQUIRED_PERMISSIONS.map((permission) => (
              <li className="flex gap-2" key={permission.name}>
                <CheckIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span>
                  <span className="font-medium">{permission.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {permission.why}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-muted-foreground text-sm">
            Calendar and contacts access is optional. {BRAND_NAME} uses it to
            mention meetings and suggest recipients.
          </p>
        </div>
      )}

      {reconnectButton("Reconnect account")}
      {signOutHint}
    </div>
  );
}

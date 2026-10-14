"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeading, TypographyP } from "@/components/Typography";
import { useAccount } from "@/providers/EmailAccountProvider";
import { toastError } from "@/components/Toast";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { BRAND_NAME } from "@/utils/branding";
import { redirectToSafeUrl } from "@/utils/redirect";

const REQUIRED_PERMISSIONS = [
  {
    name: "Your name and email address",
    why: "to know which account is yours.",
  },
  {
    name: "Read, organize and label your mail",
    why: `so ${BRAND_NAME} can sort mail, run your rules and save reply drafts.`,
  },
  {
    name: "Send mail as you",
    why: "only for replies you send, or rules you set up to send.",
  },
  {
    name: "Mailbox settings",
    why: "to read your time zone and keep labels and filters in sync.",
  },
];

export default function PermissionsConsentPage() {
  const { emailAccountId, provider, isLoading: accountLoading } = useAccount();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isMicrosoft = provider === "microsoft";

  const handleReconnect = async () => {
    setIsReconnecting(true);

    try {
      const accountProvider = provider === "microsoft" ? "microsoft" : "google";
      const url = await getAccountLinkingUrl(accountProvider, {
        reconnectEmailAccountId: emailAccountId,
      });
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      toastError({
        title: "Error initiating reconnection",
        description:
          error instanceof Error
            ? error.message
            : "Please try again or contact support",
      });
    } finally {
      setIsReconnecting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center sm:p-20 md:p-32">
      <PageHeading className="text-center">
        {BRAND_NAME} needs a few more permissions
      </PageHeading>

      <TypographyP className="mx-auto mt-4 max-w-prose text-center">
        {isMicrosoft
          ? `Your Microsoft account is connected, but ${BRAND_NAME} is missing one or more required Microsoft 365 permissions.`
          : `You must sign in and give access to all permissions for ${BRAND_NAME} to work.`}
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
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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

      <Button
        className="mt-4"
        onClick={handleReconnect}
        loading={isReconnecting}
        disabled={isReconnecting || accountLoading}
      >
        Reconnect account
      </Button>

      <p className="mt-8 text-center text-muted-foreground">
        Having trouble?{" "}
        <Link href="/logout" className="underline hover:text-primary">
          Sign out
        </Link>{" "}
        and sign back in again.
      </p>

      <div className="mt-8">
        <Image
          src="/images/illustrations/falling.svg"
          alt=""
          width={400}
          height={400}
          unoptimized
          className="dark:brightness-90 dark:invert"
        />
      </div>
    </div>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useRef } from "react";
import { posthog } from "@/utils/analytics/posthog-client";
import {
  getEmailAlreadyLinkedDescription,
  getRequiresReconsentDescription,
  getSignInSupportText,
} from "@/app/(landing)/login/messages";
import { Button } from "@/components/ui/button";
import { SignInLayout } from "@/components/layouts/SignInLayout";
import { ErrorPage } from "@/components/ErrorPage";
import { useUser } from "@/hooks/useUser";
import { LoadingContent } from "@/components/LoadingContent";
import { Loading } from "@/components/Loading";
import { WELCOME_PATH } from "@/utils/config";
import { CrispChatLoggedOutVisible } from "@/components/CrispChat";
import { getAndClearAuthErrorCookie } from "@/utils/auth-cookies";
import { BRAND_NAME } from "@/utils/branding";
import {
  getPendingAuthProvider,
  trackAuthFailure,
} from "@/utils/analytics/auth-funnel";

const errorMessages: Record<string, { title: string; description: string }> = {
  email_not_found: {
    title: "Account not authorized",
    description:
      "Your account is not authorized to access this application. This may be because your email is not part of the allowed organization. Please contact your administrator or try signing in with a different account.",
  },
  signup_not_allowed: {
    title: "You're not in yet",
    description: `${BRAND_NAME} is in private beta. We've saved a request for this Google account and will email you when your spot opens. ${BRAND_NAME} didn't keep any access to your mail.`,
  },
  email_already_linked: {
    title: "Email already linked",
    description: getEmailAlreadyLinkedDescription(),
  },
  account_not_linked: {
    title: "Sign-in method doesn't match",
    description:
      "An account already exists for this email, but it was created with a different sign-in method or a different provider account. Sign in the way you originally signed up, or contact support so we can reconnect the two.",
  },
  org_invite_invalid_code: {
    title: "Organization invite sign-in failed",
    description:
      "We couldn't complete sign-in while joining this organization. Please start from the invitation link again. If it still fails, sign in with the original account for this mailbox, then accept the invite again.",
  },
  invalid_code: {
    title: "Sign-in session expired",
    description:
      "Your sign-in link is no longer valid. This can happen if the login flow was opened twice, timed out, or already used. Please start sign-in again from the login page.",
  },
  requiresreconsent: {
    title: "Permissions need to be refreshed",
    description: getRequiresReconsentDescription(),
  },
};

function LoginErrorContent() {
  const hasTrackedAuthFailure = useRef(false);
  const { data, isLoading, error } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error")?.toLowerCase();
  const reason = searchParams.get("reason")?.toLowerCase();
  const resolvedErrorCode = resolveErrorCode({ errorCode, reason });

  useEffect(() => {
    if (isLoading || data?.id || hasTrackedAuthFailure.current) return;

    hasTrackedAuthFailure.current = true;
    trackAuthFailure(posthog, {
      provider: getPendingAuthProvider(),
      stage: "callback",
      errorCode: resolvedErrorCode,
    });
  }, [data?.id, isLoading, resolvedErrorCode]);

  // For some reason users are being sent to this page when logged in
  // This will redirect them out of this page to the app
  useEffect(() => {
    if (data?.id) {
      const authErrorCookie = getAndClearAuthErrorCookie();

      if (authErrorCookie) {
        router.push("/accounts");
      } else {
        router.push(WELCOME_PATH);
      }
    }
  }, [data, router]);

  if (isLoading) return <Loading />;
  // will redirect to welcome if user is logged in
  if (data?.id) return <Loading />;

  const errorInfo = resolvedErrorCode ? errorMessages[resolvedErrorCode] : null;
  const title = errorInfo?.title || "Couldn't sign you in";
  const supportText = getSignInSupportText();
  const fallbackDescription = resolvedErrorCode
    ? `Please try signing in again. (Error code: ${resolvedErrorCode}) ${supportText}`
    : `Please try signing in again. ${supportText}`;
  const isWaitlisted = resolvedErrorCode === "signup_not_allowed";
  const description = errorInfo?.description
    ? isWaitlisted
      ? errorInfo.description
      : `${errorInfo.description} ${supportText}`
    : fallbackDescription;

  return (
    <LoadingContent loading={isLoading} error={error}>
      <ErrorPage
        title={title}
        description={description}
        button={
          isWaitlisted ? (
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
              <Button asChild>
                <Link href="/login">Back to {BRAND_NAME}</Link>
              </Button>
              {/* Google shows its account chooser on the next attempt. */}
              <Button asChild variant="ghost">
                <Link href="/login">Use a different Google account</Link>
              </Button>
            </div>
          ) : (
            <Button asChild>
              <Link href="/login">Try another sign-in method</Link>
            </Button>
          )
        }
      />
      {/* <AutoLogOut loggedIn={!!session?.user.email} /> */}
    </LoadingContent>
  );
}

export default function LogInErrorPage() {
  return (
    <SignInLayout>
      <Suspense fallback={<Loading />}>
        <LoginErrorContent />
      </Suspense>

      <Suspense>
        <CrispChatLoggedOutVisible />
      </Suspense>
    </SignInLayout>
  );
}

function resolveErrorCode({
  errorCode,
  reason,
}: {
  errorCode?: string;
  reason?: string;
}) {
  if (reason === "org_invite" && errorCode === "invalid_code") {
    return "org_invite_invalid_code";
  }

  return errorCode;
}

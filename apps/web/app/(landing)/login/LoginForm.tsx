"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { Button as UIButton } from "@/components/ui/button";
import { signIn, signInWithSocialRedirect } from "@/utils/auth-client";
import {
  getInboxZeroDesktopApp,
  type DesktopAuthProvider,
} from "@/utils/desktop-app";
import { WELCOME_PATH } from "@/utils/config";
import { toastError } from "@/components/Toast";
import { normalizeInternalPath } from "@/utils/path";
import { buildRedirectUrl, redirectToSafeUrl } from "@/utils/redirect";
import { createClientLogger } from "@/utils/logger-client";
import { finishPendingLocalMailboxWipe } from "@/utils/mail-engine/wipe-local-mailbox";
import type { LoginProvider } from "@/utils/oauth/login-providers";
import {
  trackAuthFailure,
  trackAuthStarted,
} from "@/utils/analytics/auth-funnel";

const logger = createClientLogger("login/LoginForm");
const CONNECT_MAILBOX_PATH = "/connect-mailbox";

export function LoginForm({
  enabledProviders,
  useGoogleOauthEmulator,
  otherOptions = false,
  emphasis = "primary",
}: {
  enabledProviders: readonly LoginProvider[];
  useGoogleOauthEmulator: boolean;
  otherOptions?: boolean;
  // "secondary" when requesting access is the main action on the page.
  emphasis?: "primary" | "secondary";
}) {
  const providerButtonVariant = emphasis === "primary" ? "default" : "outline";
  const posthog = usePostHog();
  const searchParams = useSearchParams();
  const next = searchParams?.get("next");
  const { callbackURL, errorCallbackURL } = getAuthCallbackUrls(next);
  const appleCallbackURL = buildConnectMailboxUrl(callbackURL);
  const showOtherOptions =
    otherOptions ||
    !enabledProviders.some(
      (provider) => provider === "google" || provider === "microsoft",
    );
  const showAppleLogin = showOtherOptions && enabledProviders.includes("apple");
  const showGoogleLogin = !otherOptions && enabledProviders.includes("google");
  const showMicrosoftLogin =
    !otherOptions && enabledProviders.includes("microsoft");
  const showSsoLogin = showOtherOptions && enabledProviders.includes("sso");

  const [loadingApple, setLoadingApple] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [loadingMicrosoft, setLoadingMicrosoft] = useState(false);

  // Sign-out lands here and stops waiting on a slow local mailbox wipe, so
  // finish it now rather than leave the previous user's mail on this device
  // until someone opens the mail app again.
  useEffect(() => {
    finishPendingLocalMailboxWipe();
  }, []);

  const handleGoogleSignIn = async () => {
    setLoadingGoogle(true);
    trackAuthStarted(posthog, "google");
    try {
      if (await startDesktopAuthIfAvailable("google", callbackURL)) {
        return;
      }
      if (useGoogleOauthEmulator) {
        const result = await signInWithSocialRedirect({
          provider: "google",
          errorCallbackURL,
          callbackURL,
        });
        if (!result.url) {
          throw new Error("Missing Google sign-in redirect URL");
        }
        redirectToSafeUrl(result.url, { allowExternal: true });
      } else {
        await signIn.social({
          provider: "google",
          errorCallbackURL,
          callbackURL,
        });
      }
    } catch (error) {
      trackAuthFailure(posthog, {
        provider: "google",
        stage: "start",
        errorCode: getSignInErrorCode(error),
      });
      const description = getSocialSignInErrorMessage(error);
      logger.error("Error signing in with Google", { error });
      toastError({
        title: "Error signing in with Google",
        description,
      });
    } finally {
      setLoadingGoogle(false);
    }
  };

  const handleMicrosoftSignIn = async () => {
    await handleSocialSignIn({
      provider: "microsoft",
      providerName: "Microsoft",
      callbackURL,
      errorCallbackURL,
      setLoading: setLoadingMicrosoft,
      posthog,
    });
  };

  return (
    <div className="flex flex-col justify-center gap-2">
      {showGoogleLogin ? (
        <UIButton
          size="lg"
          variant={providerButtonVariant}
          className="w-full px-4"
          loading={loadingGoogle}
          onClick={handleGoogleSignIn}
        >
          <ProviderIcon src="/images/google.svg" />
          Continue with Google
        </UIButton>
      ) : null}

      {showMicrosoftLogin ? (
        <UIButton
          size="lg"
          variant={providerButtonVariant}
          className="w-full px-4"
          loading={loadingMicrosoft}
          onClick={handleMicrosoftSignIn}
        >
          <ProviderIcon src="/images/microsoft.svg" />
          Continue with Microsoft
        </UIButton>
      ) : null}

      {showAppleLogin ? (
        <UIButton
          variant="outline"
          size="lg"
          loading={loadingApple}
          onClick={() =>
            handleSocialSignIn({
              provider: "apple",
              providerName: "Apple",
              callbackURL: appleCallbackURL,
              errorCallbackURL,
              setLoading: setLoadingApple,
              posthog,
            })
          }
        >
          Continue with Apple
        </UIButton>
      ) : null}

      {showOtherOptions ? (
        <>
          <UIButton variant="outline" size="lg" asChild>
            <Link
              href={buildRedirectUrl("/login/email", { next: callbackURL })}
            >
              Email code (existing accounts)
            </Link>
          </UIButton>
          {showSsoLogin && (
            <UIButton variant="outline" size="lg" asChild>
              <Link
                href={buildRedirectUrl("/login/sso", { next: callbackURL })}
              >
                Continue with SSO
              </Link>
            </UIButton>
          )}
          {otherOptions && (
            <UIButton variant="ghost" size="lg" asChild>
              <Link href={buildRedirectUrl("/login", { next: callbackURL })}>
                Back
              </Link>
            </UIButton>
          )}
        </>
      ) : (
        <UIButton variant="ghost" size="lg" asChild>
          <Link
            href={buildRedirectUrl("/login/options", { next: callbackURL })}
          >
            Other sign-in options
          </Link>
        </UIButton>
      )}
    </div>
  );
}

function ProviderIcon({ src }: { src: string }) {
  return (
    <span className="mr-2 flex size-6 items-center justify-center rounded-full bg-white">
      <Image src={src} alt="" width={18} height={18} unoptimized />
    </span>
  );
}

function getAuthCallbackUrls(next: string | null) {
  const callbackURL = normalizeInternalPath(next) ?? WELCOME_PATH;
  const errorCallbackURL = isOrganizationInvitationPath(callbackURL)
    ? "/login/error?reason=org_invite"
    : "/login/error";

  return { callbackURL, errorCallbackURL };
}

function buildConnectMailboxUrl(nextPath: string) {
  if (nextPath === CONNECT_MAILBOX_PATH) return CONNECT_MAILBOX_PATH;
  return buildRedirectUrl(CONNECT_MAILBOX_PATH, { next: nextPath });
}

function isOrganizationInvitationPath(path: string) {
  const pathname = path.split("?")[0];
  return /^\/organizations\/invitations\/[^/]+\/accept\/?$/.test(pathname);
}

async function handleSocialSignIn({
  provider,
  providerName,
  callbackURL,
  errorCallbackURL,
  setLoading,
  posthog,
}: {
  provider: "apple" | "google" | "microsoft";
  providerName: "Apple" | "Google" | "Microsoft";
  callbackURL: string;
  errorCallbackURL: string;
  setLoading: (loading: boolean) => void;
  posthog: ReturnType<typeof usePostHog>;
}) {
  setLoading(true);
  trackAuthStarted(posthog, provider);
  try {
    if (await startDesktopAuthIfAvailable(provider, callbackURL)) {
      return;
    }
    await signIn.social({
      provider,
      errorCallbackURL,
      callbackURL,
    });
  } catch (error) {
    trackAuthFailure(posthog, {
      provider,
      stage: "start",
      errorCode: getSignInErrorCode(error),
    });
    const description = getSocialSignInErrorMessage(error);
    logger.error(`Error signing in with ${providerName}`, { error });
    toastError({
      title: `Error signing in with ${providerName}`,
      description,
    });
  } finally {
    setLoading(false);
  }
}

function getSocialSignInErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    if (isNetworkSignInError(error.message)) {
      return "Could not start sign-in. Please check that this app is opened from its configured public URL, then try again.";
    }

    return error.message;
  }

  return "Please try again or contact support.";
}

function getSignInErrorCode(error: unknown) {
  return error instanceof Error && isNetworkSignInError(error.message)
    ? "network_error"
    : "client_error";
}

function isNetworkSignInError(message: string) {
  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage === "load failed" ||
    normalizedMessage === "failed to fetch" ||
    normalizedMessage === "networkerror when attempting to fetch resource."
  );
}

async function startDesktopAuthIfAvailable(
  provider: DesktopAuthProvider,
  callbackPath: string,
) {
  const desktopApp = getInboxZeroDesktopApp();
  if (!desktopApp) return false;
  await desktopApp.startAuth(provider, { callbackPath });
  return true;
}

import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  MailCheckIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
  SunIcon,
} from "lucide-react";
import { LoginForm } from "@/app/(landing)/login/LoginForm";
import { RequestAccessForm } from "@/app/(landing)/login/RequestAccessForm";
import {
  getEmailAlreadyLinkedDescription,
  getRequiresReconsentDescription,
  getSignInSupportText,
} from "@/app/(landing)/login/messages";
import { env } from "@/env";
import { auth } from "@/utils/auth";
import { isGoogleOauthEmulationEnabled } from "@/utils/gmail/oauth";
import { getEnabledLoginProviders } from "@/utils/oauth/login-providers";
import { AlertBasic } from "@/components/Alert";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { WELCOME_PATH } from "@/utils/config";
import { CrispChatLoggedOutVisible } from "@/components/CrispChat";
import { MutedText } from "@/components/Typography";
import { normalizeInternalPath } from "@/utils/path";
import { BRAND_NAME, getPossessiveBrandName } from "@/utils/branding";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/utils/site-metadata";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/login" },
};

const CAPABILITIES = [
  {
    icon: MailCheckIcon,
    title: "Knows what needs you",
    description: "Needs reply and Reading sort themselves.",
  },
  {
    icon: PenLineIcon,
    title: "Has the reply ready",
    description: "Drafts that learn from your edits.",
  },
  {
    icon: SunIcon,
    title: "Briefs you",
    description: "Today, plus meeting briefs before every call.",
  },
  {
    icon: MessageCircleQuestionIcon,
    title: "Answers questions",
    description:
      "Ask about anything in your email, calendar and connected apps.",
  },
];

export default async function AuthenticationPage(props: {
  searchParams?: Promise<Record<string, string>>;
}) {
  const searchParams = await props.searchParams;
  const session = await auth();
  const nextPath = normalizeInternalPath(searchParams?.next);
  const isSelfHosted = env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS;

  if (session?.user && !searchParams?.error) {
    redirect(nextPath ?? WELCOME_PATH);
  }

  const enabledProviders = Array.from(getEnabledLoginProviders());
  const waitlistEnabled = env.AUTH_WAITLIST_ENABLED;
  const fromApproval = searchParams?.from === "approval";
  const showRequestForm = waitlistEnabled && !fromApproval;

  const loginForm = (
    <Suspense>
      <LoginForm
        enabledProviders={enabledProviders}
        useGoogleOauthEmulator={isGoogleOauthEmulationEnabled()}
        emphasis={showRequestForm ? "secondary" : "primary"}
      />
    </Suspense>
  );

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 sm:py-12 lg:flex lg:items-center lg:py-16">
      <div className="mx-auto grid w-full max-w-md gap-y-8 lg:max-w-5xl lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-x-16 lg:gap-y-10">
        <section aria-labelledby="pitch-heading" className="lg:col-start-1">
          <Logo className="h-6 text-foreground" />
          <p className="mt-8 font-medium text-muted-foreground text-sm lg:mt-12">
            Next-generation email
          </p>
          <h1
            id="pitch-heading"
            className="mt-2 font-title text-4xl text-foreground leading-tight tracking-tight sm:text-5xl"
          >
            The better email.
          </h1>
          <p className="mt-3 text-foreground/80 text-lg leading-snug">
            {BRAND_NAME} reads your Gmail so you know what needs you, and has
            the reply ready.
          </p>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Email has worked the same way for over 50 years: a pile of messages,
            and everything else is up to you.
          </p>
        </section>

        <section
          aria-label={showRequestForm ? "Request access" : "Sign in"}
          className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center"
        >
          <div className="space-y-5 rounded-xl border bg-card p-5 shadow-sm sm:p-6">
            {searchParams?.error && <ErrorAlert error={searchParams.error} />}

            {showRequestForm ? (
              <>
                <RequestAccessForm />
                <div className="flex items-center gap-3 text-muted-foreground text-xs">
                  <span className="h-px flex-1 bg-border" />
                  Already approved?
                  <span className="h-px flex-1 bg-border" />
                </div>
                {loginForm}
              </>
            ) : (
              <>
                {fromApproval && (
                  <div className="space-y-1">
                    <h2 className="font-semibold text-foreground text-lg">
                      Your spot is ready
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Continue with the Google account we approved.
                    </p>
                  </div>
                )}
                {loginForm}
              </>
            )}

            <p className="text-muted-foreground text-xs leading-relaxed">
              Google will ask to let {BRAND_NAME} read and send mail and see
              your calendar. That&apos;s how it knows what needs you, drafts
              replies and prepares briefs. Nothing sends without you.
            </p>

            {fromApproval && waitlistEnabled && (
              <p className="text-muted-foreground text-xs">
                Not approved yet?{" "}
                <Link
                  href="/login"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Request access
                </Link>
              </p>
            )}
          </div>
        </section>

        <section
          aria-label={`What ${BRAND_NAME} does`}
          className="lg:col-start-1"
        >
          <ul className="space-y-4">
            {CAPABILITIES.map((capability) => (
              <li key={capability.title} className="flex gap-3">
                <capability.icon
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <p className="leading-snug">
                  <span className="font-medium text-foreground">
                    {capability.title}
                  </span>
                  <span className="sr-only"> — </span>
                  <span className="block text-muted-foreground text-sm">
                    {capability.description}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <footer className="space-y-3 lg:col-span-2">
          <nav
            aria-label="Legal"
            className="flex gap-4 text-muted-foreground text-sm"
          >
            <Link
              href="/terms"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Privacy
            </Link>
          </nav>
          <LoginFooter
            isSelfHosted={isSelfHosted}
            selfHostedLoginFooterText={
              env.NEXT_PUBLIC_SELF_HOSTED_LOGIN_FOOTER_TEXT || undefined
            }
          />
        </footer>
      </div>
    </main>
  );
}

function LoginFooter({
  isSelfHosted,
  selfHostedLoginFooterText,
}: {
  isSelfHosted?: boolean;
  selfHostedLoginFooterText?: string;
}) {
  if (isSelfHosted && selfHostedLoginFooterText !== undefined) {
    const trimmedFooterText = selfHostedLoginFooterText.trim();
    if (!trimmedFooterText || trimmedFooterText.toLowerCase() === "none") {
      return null;
    }

    return (
      <MutedText className="whitespace-pre-line text-xs">
        {selfHostedLoginFooterText}
      </MutedText>
    );
  }

  return (
    <MutedText className="max-w-2xl text-xs">
      {getPossessiveBrandName()} use and transfer of information received from
      Google APIs to any other app will adhere to{" "}
      <a
        href="https://developers.google.com/terms/api-services-user-data-policy"
        className="underline underline-offset-4 hover:text-foreground"
      >
        Google API Services User Data
      </a>{" "}
      Policy, including the Limited Use requirements.
    </MutedText>
  );
}

function ErrorAlert({ error }: { error: string }) {
  if (error === "RequiresReconsent") {
    return (
      <AlertBasic
        variant="destructive"
        title="Permissions need to be refreshed"
        description={getRequiresReconsentDescription({
          includeSupportText: true,
        })}
      />
    );
  }

  if (error === "OAuthAccountNotLinked") {
    return (
      <AlertBasic
        variant="destructive"
        title="Account already attached to another user"
        description={
          <>
            <span>You can merge accounts instead.</span>
            <Button asChild className="mt-2">
              <Link href="/accounts">Merge accounts</Link>
            </Button>
          </>
        }
      />
    );
  }

  if (error === "email_already_linked") {
    return (
      <AlertBasic
        variant="destructive"
        title="Email Already Linked"
        description={getEmailAlreadyLinkedDescription({
          includeSupportText: true,
        })}
      />
    );
  }

  return (
    <>
      <AlertBasic
        variant="destructive"
        title="Error logging in"
        description={`There was an error logging in. Please try logging in again. ${getSignInSupportText()}`}
      />
      <Suspense>
        <CrispChatLoggedOutVisible />
      </Suspense>
    </>
  );
}

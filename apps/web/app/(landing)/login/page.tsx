import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { LoginForm } from "@/app/(landing)/login/LoginForm";
import { HeroInboxLoop } from "@/app/(landing)/login/HeroInboxLoop";
import { RequestAccessForm } from "@/app/(landing)/login/RequestAccessForm";
import {
  FaqSection,
  IntegrationsSection,
  IntelligenceSection,
  KeepGmailSection,
} from "@/app/(landing)/login/LandingSections";
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
import { GOOGLE_APP_UNVERIFIED } from "@/utils/google-app-status";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/utils/site-metadata";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/login" },
};

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
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 sm:py-12 lg:py-16">
      <div className="mx-auto grid w-full max-w-md gap-y-8 lg:max-w-5xl lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-x-16 lg:gap-y-10">
        <section aria-labelledby="pitch-heading" className="lg:col-start-1">
          <Logo className="h-6 text-foreground" />
          <p className="mt-8 font-medium text-muted-foreground text-sm lg:mt-12">
            Next-generation email platform
          </p>
          <h1
            id="pitch-heading"
            className="mt-2 font-title text-4xl text-foreground leading-tight tracking-tight sm:text-5xl"
          >
            The better email.
          </h1>
          <p className="mt-3 text-foreground/80 text-lg leading-snug">
            {BRAND_NAME} tells you what most emails need from you and suggests a
            reply, so you decide what goes out.
          </p>
          <p className="mt-6 flex gap-2 text-foreground text-sm leading-snug">
            <CheckIcon
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <span>
              Works with your existing Gmail. Your emails stay in Gmail, and if
              you stop using {BRAND_NAME}, nothing changes.{" "}
              <a
                href="#keep-gmail"
                className="whitespace-nowrap text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                How it works
              </a>
            </span>
          </p>
          <p className="mt-2 flex gap-2 text-foreground text-sm leading-snug">
            <CheckIcon
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            Built for students, freelancers, founders and small teams.
          </p>
          {/* On phones the form sits below the example, so offer a way
              straight to it. */}
          <Button asChild size="lg" className="mt-6 w-full lg:hidden">
            <a href="#get-access">
              {showRequestForm ? "Request access" : "Get started"}
            </a>
          </Button>
          <div className="mt-8">
            <p className="mb-2 text-muted-foreground text-xs">
              What {BRAND_NAME} writes under each email
            </p>
            <HeroInboxLoop />
          </div>
        </section>

        <section
          id="get-access"
          aria-label={showRequestForm ? "Request access" : "Sign in"}
          className="scroll-mt-8 lg:col-start-2 lg:row-start-1 lg:self-center"
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
            {GOOGLE_APP_UNVERIFIED && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                During the private beta, Google may show an &ldquo;unverified
                app&rdquo; warning. Choose Advanced, then Go to {BRAND_NAME} to
                continue.
              </p>
            )}

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

        <div className="mt-8 space-y-20 sm:mt-12 sm:space-y-24 lg:col-span-2">
          <KeepGmailSection />
          <IntelligenceSection />
          <IntegrationsSection />
          <FaqSection />
          <section
            aria-labelledby="final-cta-heading"
            className="rounded-xl border bg-card px-5 py-8 text-center sm:px-8 sm:py-10"
          >
            <h2
              id="final-cta-heading"
              className="font-title text-2xl text-foreground leading-tight tracking-tight sm:text-3xl"
            >
              Try the better email.
            </h2>
            {waitlistEnabled && (
              <p className="mx-auto mt-3 max-w-md text-muted-foreground leading-relaxed">
                {BRAND_NAME} is in private beta. We let people in a few at a
                time and review every request personally.
              </p>
            )}
            <Button asChild size="lg" className="mt-6">
              <a href="#get-access">
                {showRequestForm ? "Request access" : "Get started"}
              </a>
            </Button>
          </section>
        </div>

        <footer className="space-y-3 border-t pt-8 lg:col-span-2">
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

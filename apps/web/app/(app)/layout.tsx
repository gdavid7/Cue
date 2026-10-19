import "../../styles/globals.css";
import type { Metadata } from "next";
import type React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Inter } from "next/font/google";
import { SideNavWithTopNav } from "@/components/SideNavWithTopNav";
import { auth } from "@/utils/auth";
import { PostHogIdentify } from "@/providers/PostHogProvider";
import { CommandK } from "@/components/CommandK";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { AppProviders } from "@/providers/AppProviders";
import { AssessUser } from "@/app/(app)/[emailAccountId]/assess";
import { SentryIdentify } from "@/app/(app)/sentry-identify";
import { AiAutomationStatusBanner } from "@/app/(app)/AiAutomationStatusBanner";
import { ErrorMessages } from "@/app/(app)/ErrorMessages";
import { DesktopMailIndicators } from "@/app/(app)/DesktopMailIndicators";
import { TabUnreadTitle } from "@/app/(app)/TabUnreadTitle";
import { WebNewMailNotifications } from "@/app/(app)/WebNewMailNotifications";
import { ProviderRateLimitBanner } from "@/app/(app)/ProviderRateLimitBanner";
import { MailEngineRuntime } from "@/utils/mail-engine/MailEngineHost";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { EmailViewer } from "@/components/EmailViewer";
import { SettingsDialog } from "@/app/(app)/settings/SettingsDialog";
import { AnnouncementDialog } from "@/components/feature-announcements/AnnouncementDialog";
import { captureException } from "@/utils/error";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { getEnabledMailboxProviders } from "@/utils/oauth/provider-config";
import { getOrderedEmailAccounts } from "@/utils/mail-url.server";
import { THEME_COLOR } from "@/components/theme-options";
import { premiumEntitlementSelect } from "@/utils/premium";
import {
  getAiAccess,
  NO_AI_BANNER_DISMISSED_COOKIE,
} from "@/utils/premium/ai-access";

const logger = createScopedLogger("AppLayout");

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  preload: true,
  display: "swap",
});

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export const viewport = {
  themeColor: THEME_COLOR,
  initialScale: 1,
  width: "device-width",
  // safe area for iOS PWA
  viewportFit: "cover",
  // Android shrinks the layout (and `dvh`) for the keyboard, so bottom
  // controls like compose's Send stay above it.
  interactiveWidget: "resizes-content",
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user.email) redirect("/login");

  const [cookieStore, accounts, aiAccess] = await Promise.all([
    cookies(),
    getOrderedEmailAccounts(session.user.id),
    getUserAiAccess(session.user.id),
  ]);
  const isClosed = cookieStore.get("left-sidebar:state")?.value === "false";

  after(async () => {
    const email = session.user.email;
    try {
      await prisma.user.update({
        where: { email },
        data: { lastLogin: new Date() },
      });
    } catch (error) {
      logger.error("Failed to update last login", { email, error });
      captureException(error, { userEmail: email });
    }
  });

  return (
    <div className={inter.variable}>
      <div className="font-inter">
        <AppProviders
          accounts={accounts}
          userId={session.user.id}
          enabledMailboxProviders={getEnabledMailboxProviders()}
        >
          <MailEngineRuntime>
            <SideNavWithTopNav defaultOpen={!isClosed}>
              <DesktopMailIndicators />
              <TabUnreadTitle />
              <WebNewMailNotifications />
              <AiAutomationStatusBanner
                aiAccess={aiAccess}
                dismissed={
                  cookieStore.get(NO_AI_BANNER_DISMISSED_COOKIE)?.value === "1"
                }
              />
              <ErrorMessages />
              <ProviderRateLimitBanner />
              {children}
            </SideNavWithTopNav>
            <EmailViewer />
            <SettingsDialog />
            <AnnouncementDialog />
            <FeedbackDialog />
            <ErrorBoundary extra={{ component: "AppLayout" }}>
              <PostHogIdentify />

              <CommandK />
              <AssessUser />
              <SentryIdentify email={session.user.email} />
            </ErrorBoundary>
          </MailEngineRuntime>
        </AppProviders>
      </div>
    </div>
  );
}

async function getUserAiAccess(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiApiKey: true, premium: { select: premiumEntitlementSelect } },
  });
  return getAiAccess({
    premium: user?.premium,
    hasAiApiKey: Boolean(user?.aiApiKey),
  });
}

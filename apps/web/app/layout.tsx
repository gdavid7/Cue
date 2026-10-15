import { Suspense } from "react";
import type { Metadata } from "next";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { AxiomWebVitals } from "next-axiom";
import { GoogleTagManager } from "@next/third-parties/google";
import { Analytics as DubAnalytics } from "@dub/analytics/react";
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import type { WebApplication, WithContext } from "schema-dts";
import "../styles/globals.css";
import { PostHogPageview, PostHogProvider } from "@/providers/PostHogProvider";
import { env } from "@/env";
import { GlobalProviders } from "@/providers/GlobalProviders";
import { UTM } from "@/app/utm";
import { startupImage } from "@/app/startup-image";
import { Toaster } from "@/components/Toast";
import { VercelWebAnalytics } from "@/components/VercelWebAnalytics";
import {
  CookieConsentBanner,
  WithCookieConsent,
} from "@/components/CookieConsent";
import {
  BRAND_ICON_URL,
  BRAND_NAME,
  SUPPORT_EMAIL,
  toAbsoluteUrl,
} from "@/utils/branding";
import { isIndexingAllowed } from "@/utils/indexing";
import { THEME_COLOR } from "@/components/theme-options";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/utils/site-metadata";

const aeonikFont = localFont({
  src: "../styles/aeonik-medium.woff",
  variable: "--font-title",
  preload: true,
  display: "swap",
});
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const title = SITE_TITLE;
const description = SITE_DESCRIPTION;

const indexingAllowed = isIndexingAllowed(env.NEXT_PUBLIC_BASE_URL);

// JSON-LD structured data
const jsonLd: WithContext<WebApplication> = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: BRAND_NAME,
  url: env.NEXT_PUBLIC_BASE_URL,
  description,
  applicationCategory: "CommunicationApplication",
  operatingSystem: "Web Browser",
  featureList: [
    "Knows which emails need your reply",
    "Reply drafts that learn from your edits",
    "Daily brief and meeting briefs",
    "Answers questions about your email, calendar and connected apps",
  ],
  publisher: {
    "@type": "Organization",
    "@id": toAbsoluteUrl("/#organization"),
    name: BRAND_NAME,
    url: env.NEXT_PUBLIC_BASE_URL,
    logo: {
      "@type": "ImageObject",
      url: toAbsoluteUrl(BRAND_ICON_URL),
    },
    ...(SUPPORT_EMAIL
      ? {
          contactPoint: {
            "@type": "ContactPoint" as const,
            email: SUPPORT_EMAIL,
            contactType: "customer support",
          },
        }
      : {}),
  },
};

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    siteName: BRAND_NAME,
    type: "website",
    url: env.NEXT_PUBLIC_BASE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  metadataBase: new URL(env.NEXT_PUBLIC_BASE_URL),
  // issues with robots.txt: https://github.com/vercel/next.js/issues/58615#issuecomment-1852457285
  robots: {
    index: indexingAllowed,
    follow: indexingAllowed,
  },
  // pwa
  applicationName: BRAND_NAME,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: BRAND_NAME,
    startupImage,
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport = {
  themeColor: THEME_COLOR,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body
        className={`h-full ${env.NEXT_PUBLIC_USE_AEONIK_FONT ? aeonikFont.variable : ""} ${geist.variable} font-sans antialiased`}
      >
        <script
          // Marks the Mac Electron shell before paint so traffic-light
          // insets apply without a logo flash. Harmless in the browser.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static UA check, no user input
          dangerouslySetInnerHTML={{
            __html:
              'if(window.inboxZeroDesktop&&/Mac/i.test(navigator.userAgent))document.documentElement.dataset.macDesktop=""',
          }}
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify on controlled object is safe
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd),
          }}
        />
        <PostHogProvider>
          <Suspense>
            <PostHogPageview />
          </Suspense>
          <GlobalProviders>
            {children}
            <Toaster />
          </GlobalProviders>
        </PostHogProvider>
        <VercelWebAnalytics />
        <AxiomWebVitals />
        <UTM />
        <SpeedInsights />
        <WithCookieConsent>
          {env.NEXT_PUBLIC_DUB_REFER_DOMAIN && (
            <DubAnalytics
              apiHost="/_proxy/dub"
              scriptProps={{ src: "/_proxy/dub/script.js" }}
              domainsConfig={{ refer: env.NEXT_PUBLIC_DUB_REFER_DOMAIN }}
            />
          )}
          {env.NEXT_PUBLIC_GTM_ID ? (
            <GoogleTagManager gtmId={env.NEXT_PUBLIC_GTM_ID} />
          ) : null}
        </WithCookieConsent>
        <CookieConsentBanner />
      </body>
    </html>
  );
}

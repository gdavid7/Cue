import Link from "next/link";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";
import { CookieSettingsButton } from "@/components/CookieConsent";

export const footerNavigation = {
  main: [
    { name: "AI Email Assistant", href: "/ai-automation" },
    { name: "Email Client", href: "/email-client" },
    { name: "Mobile App", href: "/mobile-app" },
    { name: "Desktop App", href: "/desktop" },
    { name: "AI Chat for Slack & Telegram", href: "/ai-assistant-chat" },
    { name: "Slack AI Assistant", href: "/slack-integration" },
    { name: "Telegram AI Assistant", href: "/telegram-integration" },
    { name: "Teams AI Assistant", href: "/teams-integration" },
    { name: "Brief My Meeting", href: "/brief-my-meeting" },
    { name: "AI Meeting Notetaker", href: "/ai-meeting-notetaker" },
    { name: "Reply Zero", href: "/reply-zero-ai" },
    { name: "Bulk Email Unsubscriber", href: "/bulk-email-unsubscriber" },
    { name: "Clean your inbox", href: "/clean-inbox" },
    { name: "Cold Email Blocker", href: "/block-cold-emails" },
    { name: "Email Analytics", href: "/email-analytics" },
    { name: "Auto Forward Emails", href: "/auto-forward-emails" },
    { name: "Auto-File Attachments", href: "/auto-file-email-attachments" },
  ],
  useCases: [
    { name: "Founder", href: "/founders" },
    { name: "Small Business", href: "/small-business" },
    { name: "Content Creator", href: "/creator" },
    { name: "Realtor", href: "/real-estate" },
    { name: "Customer Support", href: "/customer-support" },
    { name: "E-commerce", href: "/ecommerce" },
  ],
  industries: [
    { name: "MSPs", href: "/msp" },
    { name: "Property Management", href: "/property-management" },
    { name: "Law Firms", href: "/law-firms" },
    { name: "Accounting Firms", href: "/accounting-firms" },
  ],
  compare: [
    {
      name: "Best AI Email Assistants",
      href: "/blog/post/best-ai-email-assistants",
    },
    {
      name: "AI Email Assistant Directory",
      href: "https://aiemailassistants.com",
      target: "_blank",
    },
    { name: "vs Fyxer.ai", href: "/best-fyxer-alternative" },
    { name: "vs Superhuman", href: "/best-superhuman-alternative" },
    { name: "vs Shortwave", href: "/best-shortwave-alternative" },
    {
      name: "vs Perplexity Email Assistant",
      href: "/best-perplexity-email-assistant-alternative",
    },
  ],
  tools: [
    { name: "All Free Email Tools", href: "/tools" },
    {
      name: "Email Deliverability Checker",
      href: "/tools/email-deliverability-checker",
    },
    { name: "Gmail Personality Quiz", href: "/tools/gmail-quiz" },
    { name: "Subject Line Analyzer", href: "/tools/subject-line-analyzer" },
    {
      name: "Email Signature Generator",
      href: "/tools/email-signature-generator",
    },
    { name: "Meeting Cost Calculator", href: "/tools/meeting-cost-calculator" },
    {
      name: "Team Email Cost Calculator",
      href: "/tools/email-cost-calculator",
    },
  ],
  support: [
    { name: "Pricing", href: "/pricing" },
    { name: "Contact us", href: `mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}` },
    { name: "CLI", href: "/cli" },
    { name: "OpenClaw Skill", href: "/openclaw" },
  ],
  company: [
    { name: "About", href: "/about" },
    { name: "Blog", href: "/blog" },
    { name: "Case Studies", href: "/case-studies" },
    { name: "OSS Friends", href: "/oss-friends" },
    {
      name: "Bot Directory",
      href: "https://botdirectory.ai",
      target: "_blank",
    },
    { name: "Rakazo", href: "https://rakazo.com", target: "_blank" },
  ],
  legal: [
    { name: "Terms", href: "/terms" },
    { name: "Privacy", href: "/privacy" },
  ],
};

// Simple footer for self-hosted deployments
const selfHostedFooter = {
  resources: [
    { name: "Contact us", href: `mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}` },
  ],
  legal: [
    { name: "Terms", href: "/terms" },
    { name: "Privacy", href: "/privacy" },
  ],
};

export function Footer() {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return (
      <footer className="relative">
        <div className="mx-auto max-w-7xl overflow-hidden px-6 py-12 lg:px-8">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {selfHostedFooter.resources.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                target={item.target}
                rel={
                  item.target === "_blank" ? "noopener noreferrer" : undefined
                }
                className="text-sm leading-6 text-gray-600 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
            <span className="text-gray-300">|</span>
            {selfHostedFooter.legal.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="text-sm leading-6 text-gray-600 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
            <CookieSettingsButton className="text-sm leading-6 text-gray-600 hover:text-gray-900" />
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="relative">
      <div className="mx-auto max-w-7xl overflow-hidden px-6 py-20 sm:py-24 lg:px-8">
        <nav aria-label="Footer">
          <div className="mt-16 grid grid-cols-2 gap-8 lg:grid-cols-5 xl:col-span-2 xl:mt-0">
            <div>
              <FooterList title="Product" items={footerNavigation.main} />
            </div>
            <div>
              <FooterList title="Use Cases" items={footerNavigation.useCases} />

              <div className="mt-6">
                <FooterList
                  title="Industries"
                  items={footerNavigation.industries}
                />
              </div>

              <div className="mt-6">
                <FooterList title="Compare" items={footerNavigation.compare} />
              </div>
            </div>
            <div>
              <FooterList title="Support" items={footerNavigation.support} />

              <div className="mt-6">
                <FooterList title="Free Tools" items={footerNavigation.tools} />
              </div>
            </div>
            <div>
              <FooterList title="Company" items={footerNavigation.company} />
            </div>
            <div>
              <FooterList title="Legal" items={footerNavigation.legal} />
              <CookieSettingsButton className="mt-4 text-sm leading-6 text-gray-600 hover:text-gray-900" />
            </div>
          </div>
        </nav>

        <p className="mt-10 text-center text-xs leading-5 text-gray-500">
          &copy; {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

function FooterList(props: {
  title: string;
  items: { name: string; href: string; target?: string }[];
}) {
  return (
    <>
      <h3 className="text-sm font-semibold leading-6 text-gray-900">
        {props.title}
      </h3>
      <ul className="mt-6 space-y-4">
        {props.items.map((item) => (
          <li key={item.name}>
            <Link
              href={item.href}
              target={item.target}
              prefetch={false}
              className="text-sm leading-6 text-gray-600 hover:text-gray-900"
            >
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

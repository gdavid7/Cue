import Link from "next/link";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";
import { CookieSettingsButton } from "@/components/CookieConsent";

export const footerNavigation = {
  support: [
    { name: "Pricing", href: "/pricing" },
    { name: "Contact us", href: `mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}` },
  ],
  company: [{ name: "OSS Friends", href: "/oss-friends" }],
  legal: [
    { name: "Terms", href: "/terms" },
    { name: "Privacy", href: "/privacy" },
  ],
};

// Simple footer for self-hosted deployments
type FooterLink = { name: string; href: string; target?: string };

const selfHostedFooter: { resources: FooterLink[]; legal: FooterLink[] } = {
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
          <div className="mt-16 grid grid-cols-2 gap-8 lg:grid-cols-3 xl:col-span-2 xl:mt-0">
            <div>
              <FooterList title="Support" items={footerNavigation.support} />
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

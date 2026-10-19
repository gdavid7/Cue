import Link from "next/link";
import { env } from "@/env";
import { Logo } from "@/components/new-landing/common/Logo";
import { cn } from "@/utils";
import { FooterLineLogo } from "@/components/new-landing/FooterLineLogo";
import { Paragraph } from "@/components/new-landing/common/Typography";
import { UnicornScene } from "@/components/new-landing/UnicornScene";
import { footerNavigation } from "@/app/(landing)/home/Footer";
import { BRAND_LOGO_URL } from "@/utils/branding";

interface FooterProps {
  className: string;
  variant?: "default" | "simple";
}

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

export function Footer({ className, variant = "default" }: FooterProps) {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return (
      <footer className="border-t border-[#E7E7E7A3] bg-cover bg-center bg-no-repeat overflow-hidden">
        <div className={cn("overflow-hidden px-6 py-12 lg:px-8", className)}>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {selfHostedFooter.resources.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                target={item.target}
                rel={
                  item.target === "_blank" ? "noopener noreferrer" : undefined
                }
                prefetch={false}
                className="text-sm leading-6 text-gray-500 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
            <span className="text-gray-300">|</span>
            {selfHostedFooter.legal.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                prefetch={false}
                className="text-sm leading-6 text-gray-500 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer
      className={cn(
        "border-t border-[#E7E7E7A3] bg-cover bg-center bg-no-repeat overflow-hidden",
        variant === "default" && "relative z-50",
      )}
    >
      {variant === "default" ? <UnicornScene className="opacity-15" /> : null}
      <div
        className={cn("overflow-hidden px-6 py-20 sm:py-24 lg:px-8", className)}
      >
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
            </div>
          </div>
        </nav>
        <div className="mt-40">
          <Logo />
        </div>
      </div>
      {variant === "default" && !BRAND_LOGO_URL ? (
        <FooterLineLogo className="hidden xl:block absolute bottom-0 left-1/2 -translate-x-1/2 mx-auto px-6 lg:px-8 -z-10" />
      ) : null}
    </footer>
  );
}

function FooterList(props: {
  title: string;
  items: { name: string; href: string; target?: string }[];
}) {
  return (
    <>
      <Paragraph
        color="gray-900"
        size="sm"
        className="font-semibold leading-6"
        as="h3"
      >
        {props.title}
      </Paragraph>
      <ul className="mt-6 space-y-3">
        {props.items.map((item) => (
          <li key={item.name}>
            <Link
              href={item.href}
              target={item.target}
              prefetch={false}
              className="text-sm leading-6 text-gray-500 hover:text-gray-900"
            >
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

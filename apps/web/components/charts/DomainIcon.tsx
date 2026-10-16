"use client";

import { getDomain } from "tldts";
import { SiteIcon } from "@/components/SiteIcon";

/** The favicon of a domain's registrable site (mail.notion.so → notion.so). */
export function DomainIcon({
  domain,
  size = 20,
  variant = "default",
}: {
  domain: string;
  size?: number;
  variant?: "default" | "circular";
}) {
  return (
    <SiteIcon
      domain={getDomain(domain) || domain}
      fallbackSeed={domain}
      size={size}
      variant={variant}
    />
  );
}

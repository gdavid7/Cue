import Image from "next/image";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/utils/branding";

interface LogoProps {
  className?: string;
}

export function Logo({ className }: LogoProps) {
  if (BRAND_LOGO_URL) {
    return (
      <Image
        src={BRAND_LOGO_URL}
        alt={`${BRAND_NAME} logo`}
        width={209}
        height={25}
        className={className}
        unoptimized
      />
    );
  }

  // A mark and wordmark drawn as text, so a custom NEXT_PUBLIC_BRAND_NAME
  // renders too. Sized by height, like the image logo.
  return (
    <svg
      viewBox={`0 0 ${30 + BRAND_NAME.length * 14} 24`}
      fill="none"
      className={className}
    >
      <title>{BRAND_NAME}</title>
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <path
        d="M16.2 8.2a5.4 5.4 0 1 0 0 7.6"
        stroke="hsl(var(--background))"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <text
        x="30"
        y="19"
        fill="currentColor"
        fontFamily="inherit"
        fontSize="21"
        fontWeight="600"
        letterSpacing="-0.5"
      >
        {BRAND_NAME}
      </text>
    </svg>
  );
}

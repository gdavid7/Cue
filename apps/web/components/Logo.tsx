import Image from "next/image";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/utils/branding";

interface LogoProps {
  className?: string;
  /** Draws the dot in the text color, for colored backgrounds where the accent blue disappears. */
  monochrome?: boolean;
}

const DEFAULT_BRAND_NAME = "Cue";
const ACCENT_CLASS = "fill-[#2563EB] dark:fill-[#60A5FA]";

export function Logo({ className, monochrome }: LogoProps) {
  const dotClass = monochrome ? "fill-current" : ACCENT_CLASS;

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

  // A custom NEXT_PUBLIC_BRAND_NAME keeps the mark but sets its own name as
  // text. Sized by height, like the image logo.
  if (BRAND_NAME !== DEFAULT_BRAND_NAME) {
    return (
      <svg
        viewBox={`0 0 ${30 + BRAND_NAME.length * 14} 24`}
        fill="none"
        role="img"
        className={className}
      >
        <title>{BRAND_NAME}</title>
        <path
          d="M15.42 5.72A7.4 7.4 0 1 0 15.42 18.28"
          stroke="currentColor"
          strokeWidth="4.2"
          strokeLinecap="round"
        />
        <circle cx="18.9" cy="12" r="3.1" className={dotClass} />
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

  return (
    <svg viewBox="3 3 82 22" fill="none" role="img" className={className}>
      <title>{BRAND_NAME}</title>
      <g transform="scale(1.17)">
        <path
          d="M16.49 6.18A7.6 7.6 0 1 0 16.49 17.82"
          stroke="currentColor"
          strokeWidth="3.4"
          strokeLinecap="round"
        />
        <circle cx="19.2" cy="12" r="2.5" className={dotClass} />
      </g>
      <g
        transform="translate(36.5 0)"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15.46 7.49A8.5 8.5 0 1 0 15.46 20.51" />
        <path d="M21.4 11.5V18a4.5 4.5 0 0 0 9 0M30.4 11.5V22.5" />
        <path d="M35.9 17H46.9A5.5 5.5 0 1 0 45.49 20.68" />
      </g>
    </svg>
  );
}

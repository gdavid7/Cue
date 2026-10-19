import { COLORS } from "@/utils/colors";

interface FooterLineLogoProps {
  className?: string;
}

export function FooterLineLogo({ className }: FooterLineLogoProps) {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="3 3 82 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      opacity="0.09"
      stroke={COLORS.footer.gray}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>Cue</title>
      <g transform="scale(1.17)">
        <path d="M16.49 6.18A7.6 7.6 0 1 0 16.49 17.82" strokeWidth="3.4" />
        <circle
          cx="19.2"
          cy="12"
          r="2.5"
          fill={COLORS.footer.gray}
          stroke="none"
        />
      </g>
      <g transform="translate(36.5 0)" strokeWidth="3">
        <path d="M15.46 7.49A8.5 8.5 0 1 0 15.46 20.51" />
        <path d="M21.4 11.5V18a4.5 4.5 0 0 0 9 0M30.4 11.5V22.5" />
        <path d="M35.9 17H46.9A5.5 5.5 0 1 0 45.49 20.68" />
      </g>
    </svg>
  );
}

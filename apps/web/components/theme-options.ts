import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

export const THEME_OPTIONS = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

/**
 * Public marketing pages are designed for a light surface only, so they keep
 * it whatever the visitor's preference. Everything signed-in, plus sign-in and
 * onboarding, follows the chosen theme.
 */
const LIGHT_ONLY_PATHS = [
  "/app",
  "/home",
  "/oss-friends",
  "/pricing",
  "/thank-you",
  "/welcome-upgrade",
];

export function getForcedTheme(pathname: string | null) {
  if (!pathname) return;
  const isLightOnly = LIGHT_ONLY_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  return isLightOnly ? "light" : undefined;
}

/** Browser chrome before hydration; `ThemeProvider` then follows the page. */
export const THEME_COLOR = [
  { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  { media: "(prefers-color-scheme: dark)", color: "#26282c" },
];

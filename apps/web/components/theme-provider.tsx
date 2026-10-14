"use client";

import { useEffect, type PropsWithChildren } from "react";
import { usePathname } from "next/navigation";
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
  useTheme,
} from "next-themes";
import { getForcedTheme } from "@/components/theme-options";

/**
 * One theme for every page, applied by next-themes' inline script before the
 * first paint so a dark preference never flashes white. "System" follows the
 * OS setting live.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const forcedTheme = getForcedTheme(pathname);

  const props: PropsWithChildren<ThemeProviderProps> = {
    attribute: "class",
    defaultTheme: "system",
    enableSystem: true,
    disableTransitionOnChange: true,
    forcedTheme,
    children: (
      <>
        <ThemeColorSync forcedTheme={forcedTheme} pathname={pathname} />
        {children}
      </>
    ),
  };

  return <NextThemesProvider {...props} />;
}

// The browser and installed-app title bars read `theme-color`. The server
// sends one per OS scheme, which is wrong once someone picks a theme that
// differs from their OS, so it follows the page's own background instead.
// Navigations can re-render the tags, so it re-applies on each route.
function ThemeColorSync({
  forcedTheme,
  pathname,
}: {
  forcedTheme?: string;
  pathname: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const theme = forcedTheme ?? resolvedTheme;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-applies after navigation re-renders the tags
  useEffect(() => {
    if (!theme) return;
    // next-themes swaps the class in its own effect, which runs after this one.
    const frame = requestAnimationFrame(() => {
      const color = getComputedStyle(document.body).backgroundColor;
      for (const meta of document.querySelectorAll<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )) {
        meta.content = color;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, pathname]);

  return null;
}

"use client";

import { useEffect, useState } from "react";
import { Geist } from "next/font/google";
import "../styles/globals.css";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { captureException } from "@/utils/error";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

// biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
export default function GlobalError({ error }: any) {
  const dark = useSavedDarkTheme();

  useEffect(() => {
    captureException(error);
  }, [error]);

  // This replaces the root layout, so the providers never signal. The page
  // offers its own reload, so the desktop shell shouldn't replace it.
  useEffect(() => {
    getInboxZeroDesktopApp()?.signalReady?.();
  }, []);

  return (
    <html
      lang="en"
      className={dark ? "dark" : undefined}
      style={{ colorScheme: dark ? "dark" : "light" }}
    >
      <body
        className={`min-h-screen bg-background p-4 font-sans text-foreground antialiased ${geist.variable}`}
      >
        <ErrorDisplay
          error={{ error: error?.message }}
          onRetry={() => window.location.reload()}
        />
      </body>
    </html>
  );
}

// This page replaces the root layout and its theme provider, so it applies
// the saved choice ("system" by default) itself.
function useSavedDarkTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("theme");
      } catch {}
      setDark(saved === "dark" || (saved !== "light" && systemDark.matches));
    };
    apply();
    systemDark.addEventListener("change", apply);
    return () => systemDark.removeEventListener("change", apply);
  }, []);

  return dark;
}

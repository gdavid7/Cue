"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { createClientLogger } from "@/utils/logger-client";

const logger = createClientLogger("not-found");

export default function NotFound() {
  const pathname = usePathname();

  useEffect(() => {
    logger.warn("Page not found", { pathname });
  }, [pathname]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center text-foreground">
      <Logo className="h-7" />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-muted-foreground">
          This link doesn't lead anywhere.
        </p>
      </div>
      <Button asChild>
        {/* The root sends people to their inbox, or to sign in first. */}
        <Link href="/">Go to your inbox</Link>
      </Button>
    </main>
  );
}

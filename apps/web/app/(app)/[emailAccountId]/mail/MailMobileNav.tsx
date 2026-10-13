"use client";

import { HomeIcon, InboxIcon, PenIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import { prefixPath } from "@/utils/path";

/**
 * The phone's way around: the sidebar is hidden below `lg`, so compose and the
 * Today briefing need a home within thumb reach.
 */
export function MailMobileNav({
  accountSwitcher,
}: {
  /** `MailAccountSwitcher` with the "bar" variant. */
  accountSwitcher: ReactNode;
}) {
  const { emailAccountId } = useAccount();
  const { onOpen: openCompose } = useComposeModal();

  return (
    <nav
      aria-label="Mail"
      className="flex shrink-0 items-center justify-around gap-1 border-border border-t bg-background px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <Link
        className="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] text-foreground"
        href={prefixPath(emailAccountId, "/mail")}
      >
        <InboxIcon className="size-5" />
        Inbox
      </Link>
      <button
        aria-label="Compose"
        className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md"
        onClick={openCompose}
        type="button"
      >
        <PenIcon className="size-5" />
      </button>
      <Link
        className="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] text-muted-foreground"
        href={prefixPath(emailAccountId, "/home")}
      >
        <HomeIcon className="size-5" />
        Today
      </Link>
      {accountSwitcher}
    </nav>
  );
}

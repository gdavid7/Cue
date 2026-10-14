"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoadingContent } from "@/components/LoadingContent";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useHome } from "@/hooks/useHome";
import { useMailHref } from "@/hooks/useMailHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import type { HomeThread } from "@/utils/home/get-home";
import { formatShortDate } from "@/utils/date";
import { getInitials } from "@/utils/email";
import { BeforeYourMeeting } from "./BeforeYourMeeting";

/**
 * Today: what needs you and who you're waiting on. A row opens the
 * conversation in the mail reader, where the reply is already drafted.
 */
export function HomeDashboard() {
  const { emailAccountId, emailAccount } = useAccount();
  const { data, isLoading, error } = useHome(emailAccountId);
  const greetingText = useGreeting();
  const firstName = (emailAccount?.name || "").split(" ")[0];
  const mailHref = useMailHref();
  const threadHref = (threadId: string) => mailHref({ threadId });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 md:px-8">
      <header>
        <h1 className="font-title text-2xl text-foreground">
          {greetingText}
          {firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Here's what needs your attention.
        </p>
      </header>

      <BeforeYourMeeting emailAccountId={emailAccountId} />

      <LoadingContent
        error={error}
        loading={isLoading}
        loadingComponent={<HomeSkeleton />}
      >
        {data ? (
          <>
            <Section
              title="Needs you"
              count={data.needsYou.length}
              empty="Nothing needs a reply right now."
            >
              {data.needsYou.map((thread) => (
                <ThreadRow
                  key={thread.threadId}
                  href={threadHref(thread.threadId)}
                  thread={thread}
                />
              ))}
            </Section>

            <Section
              title="Waiting on others"
              count={data.waiting.length}
              empty="You're not waiting on anyone."
            >
              {data.waiting.map((thread) => (
                <ThreadRow
                  waiting
                  key={thread.threadId}
                  href={threadHref(thread.threadId)}
                  thread={thread}
                />
              ))}
            </Section>
          </>
        ) : null}
      </LoadingContent>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-title text-foreground text-lg">
        {title}
        <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-muted-foreground text-xs">
          {count}
        </span>
      </h2>
      {count ? (
        <div className="space-y-1.5">{children}</div>
      ) : (
        <p className="rounded-lg border border-border border-dashed px-4 py-3 text-muted-foreground text-sm">
          {empty}
        </p>
      )}
    </section>
  );
}

function ThreadRow({
  thread,
  href,
  waiting,
}: {
  thread: HomeThread;
  href: string;
  /** Show how long the user has been waiting instead of the preview. */
  waiting?: boolean;
}) {
  return (
    <Link
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-border bg-card px-4 text-left transition-colors hover:bg-muted/50",
        waiting ? "py-2.5" : "py-3.5",
      )}
      href={href}
    >
      <Avatar className={cn("shrink-0", waiting ? "size-8" : "size-10")}>
        <AvatarFallback className="font-medium text-sm">
          {getInitials(thread.fromName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-sm",
              thread.unread ? "font-semibold" : "font-medium",
            )}
          >
            {thread.fromName}
          </span>
          {thread.tag ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
              {thread.tag}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-muted-foreground text-xs">
            {waiting
              ? waitingFor(thread.at)
              : formatShortDate(new Date(thread.at))}
          </span>
        </div>
        <div className="truncate text-foreground text-sm">{thread.subject}</div>
        {waiting ? null : (
          <p className="mt-0.5 line-clamp-1 text-muted-foreground text-sm">
            {thread.preview}
          </p>
        )}
      </div>
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton className="h-20 rounded-xl" key={i} />
      ))}
    </div>
  );
}

/**
 * Time of day comes from the browser's clock, which the server doesn't know,
 * so render a neutral greeting until mounted rather than mismatch on hydration.
 */
function useGreeting() {
  const [text, setText] = useState("Hello");
  useEffect(() => {
    const hour = new Date().getHours();
    setText(
      hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening",
    );
  }, []);
  return text;
}

function waitingFor(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "Today" : `Waiting ${days}d`;
}

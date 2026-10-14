"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckIcon, ReplyIcon } from "lucide-react";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHome } from "@/hooks/useHome";
import { useMailHref } from "@/hooks/useMailHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { markNoReplyNeededAction } from "@/utils/actions/rule-feedback";
import { markNeedsReplyAction } from "@/utils/actions/thread-assist";
import type { AgentTask, HomeThread } from "@/utils/home/get-home";
import { formatShortDate } from "@/utils/date";
import { getInitials } from "@/utils/email";
import { getActionErrorMessage } from "@/utils/error";
import { prefixPath } from "@/utils/path";
import { PageHeading } from "@/components/Typography";
import { BeforeYourMeeting } from "./BeforeYourMeeting";

const ALSO_IN_INBOX_LIMIT = 5;

/**
 * Today: what needs a reply, what Cue did for you, and who you're waiting
 * on. A row opens the conversation in the mail reader. An empty lane only
 * says "nothing here" once Cue is actually checking.
 */
export function HomeDashboard() {
  const { emailAccountId, emailAccount } = useAccount();
  const { data, isLoading, error, mutate } = useHome(emailAccountId);
  const greetingText = useGreeting();
  const firstName = (emailAccount?.name || "").split(" ")[0];
  const mailHref = useMailHref();
  const threadHref = (threadId: string) =>
    // from=today lets the reader return here rather than to the inbox.
    `${mailHref({ threadId })}?from=today`;

  // The row moves lanes at once; the server catches up behind it.
  const correct = async (
    thread: HomeThread,
    needsReply: boolean,
  ): Promise<void> => {
    if (!data) return;
    const moved: GetHomeResponse = needsReply
      ? {
          ...data,
          needsYou: [thread, ...data.needsYou],
          alsoInInbox: data.alsoInInbox.filter(
            (t) => t.threadId !== thread.threadId,
          ),
        }
      : {
          ...data,
          needsYou: data.needsYou.filter((t) => t.threadId !== thread.threadId),
          alsoInInbox: [thread, ...data.alsoInInbox],
        };
    mutate(moved, false);

    const action = needsReply ? markNeedsReplyAction : markNoReplyNeededAction;
    const result = await action(emailAccountId, { threadId: thread.threadId });
    if (result?.serverError || result?.validationErrors) {
      mutate();
      toastError({
        title: "Couldn't update this email",
        description: getActionErrorMessage(
          result,
          "Nothing changed. Check your connection and try again.",
        ),
      });
      return;
    }
    toastSuccess({
      description: needsReply
        ? "Moved to Needs reply."
        : "Removed from Needs reply. Cue will learn from this.",
    });
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 md:px-8">
      <header>
        <PageHeading>
          {greetingText}
          {firstName ? `, ${firstName}` : ""}
        </PageHeading>
        <p className="mt-1 text-muted-foreground text-sm">
          What needs a reply, and what Cue handled for you.
        </p>
      </header>

      <BeforeYourMeeting emailAccountId={emailAccountId} />

      <LoadingContent
        error={error}
        loading={isLoading}
        loadingComponent={<HomeSkeleton />}
      >
        {data ? (
          <HomeLanes
            data={data}
            emailAccountId={emailAccountId}
            onCorrect={correct}
            threadHref={threadHref}
          />
        ) : null}
      </LoadingContent>
    </div>
  );
}

function HomeLanes({
  data,
  emailAccountId,
  threadHref,
  onCorrect,
}: {
  data: GetHomeResponse;
  emailAccountId: string;
  threadHref: (threadId: string) => string;
  onCorrect: (thread: HomeThread, needsReply: boolean) => Promise<void>;
}) {
  const { cue, stats } = data;
  const mailHref = useMailHref();
  const notice = cueNotice(cue, emailAccountId);
  const canCheck = !notice;
  const caughtUp =
    canCheck && data.needsYou.length === 0 && data.waiting.length === 0;
  const drafts = data.agentTasks.filter((task) => task.kind === "draft");
  const otherTasks = data.agentTasks.filter((task) => task.kind !== "draft");

  return (
    <>
      {notice ? (
        <div
          className="rounded-lg bg-muted/60 px-4 py-3 text-foreground text-sm"
          role="status"
        >
          {notice.text}
          {notice.link ? (
            <>
              {" "}
              <Link
                className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                href={notice.link.href}
              >
                {notice.link.label}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {caughtUp ? (
        <p className="text-muted-foreground text-sm" role="status">
          You're all caught up.
        </p>
      ) : null}

      {data.needsYou.length > 0 || (canCheck && !caughtUp) ? (
        <Section
          title="Needs reply"
          count={formatCount(data.needsYou.length, stats.needsYouCapped)}
          empty="Nothing needs a reply."
        >
          {data.needsYou.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              href={threadHref(thread.threadId)}
              thread={thread}
              correction={{
                label: "No reply needed",
                icon: CheckIcon,
                onClick: () => onCorrect(thread, false),
              }}
            />
          ))}
        </Section>
      ) : null}

      {drafts.length > 0 || otherTasks.length > 0 ? (
        <Section
          title={drafts.length ? "Drafts ready for you" : "Cue is working on"}
          count={formatCount(data.agentTasks.length, false)}
        >
          {[...drafts, ...otherTasks].map((task) => (
            <TaskRow
              href={threadHref(task.threadId)}
              key={task.id}
              task={task}
            />
          ))}
        </Section>
      ) : null}

      {data.waiting.length > 0 || (canCheck && !caughtUp) ? (
        <Section
          title="Waiting on"
          count={formatCount(data.waiting.length, stats.waitingCapped)}
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
      ) : null}

      {data.handledLabels.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          Cue filed mail for you in the last {stats.handledWindowDays} days:{" "}
          {data.handledLabels.map((label, index) => (
            <span key={label.labelId}>
              {index > 0 ? ", " : null}
              <Link
                className="text-foreground underline-offset-2 hover:underline"
                href={mailHref({
                  view: { kind: "label", slug: label.labelId },
                })}
              >
                {label.name} {formatCount(label.count, label.capped)}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}

      {data.alsoInInbox.length > 0 ? (
        <Section
          title="Also in your inbox"
          action={
            <Link
              className="font-sans text-muted-foreground text-sm underline-offset-2 hover:text-foreground hover:underline"
              href={mailHref()}
            >
              Open inbox
            </Link>
          }
        >
          {data.alsoInInbox.slice(0, ALSO_IN_INBOX_LIMIT).map((thread) => (
            <ThreadRow
              compact
              key={thread.threadId}
              href={threadHref(thread.threadId)}
              thread={thread}
              correction={
                cue.aiAccess
                  ? {
                      label: "Needs reply",
                      icon: ReplyIcon,
                      onClick: () => onCorrect(thread, true),
                    }
                  : undefined
              }
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}

/** Why Cue can't yet say what needs a reply, or null when it can. */
function cueNotice(
  cue: GetHomeResponse["cue"],
  emailAccountId: string,
): { text: string; link?: { label: string; href: string } } | null {
  if (!cue.aiAccess) {
    return {
      text: "Turn on the AI assistant to see what needs a reply.",
      link: { label: "See plans", href: "/premium" },
    };
  }
  if (!cue.replyTracking) {
    return {
      text: "Reply tracking is off, so Cue isn't checking what needs a reply.",
      link: {
        label: "Turn it on in Rules",
        href: prefixPath(emailAccountId, "/automation"),
      },
    };
  }
  if (!cue.hasReadMail) {
    return {
      text: "Cue is reading your recent mail. What needs a reply will show up here.",
    };
  }
  return null;
}

function Section({
  title,
  count,
  empty,
  action,
  children,
}: {
  title: string;
  count?: string;
  empty?: string;
  action?: React.ReactNode;
  children: React.ReactNode[];
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-title text-foreground text-lg">
        {title}
        {count ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-muted-foreground text-xs">
            {count}
          </span>
        ) : null}
        {action ? <span className="ml-auto">{action}</span> : null}
      </h2>
      {children.length ? (
        // One flat list, like the inbox, rather than a stack of cards.
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {children}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{empty}</p>
      )}
    </section>
  );
}

function ThreadRow({
  thread,
  href,
  waiting,
  compact,
  correction,
}: {
  thread: HomeThread;
  href: string;
  /** Show how long the user has been waiting instead of the preview. */
  waiting?: boolean;
  /** One line, for the rest of the inbox. */
  compact?: boolean;
  /** Fix Cue's call on this conversation without opening it. */
  correction?: {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    onClick: () => Promise<void>;
  };
}) {
  const small = waiting || compact;
  const [pending, setPending] = useState(false);
  const Icon = correction?.icon;

  return (
    <div className="flex items-center transition-colors hover:bg-muted/50">
      <Link
        className={cn(
          "flex min-w-0 flex-1 items-start gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          small ? "py-2.5" : "py-3.5",
        )}
        href={href}
      >
        <Avatar className={cn("shrink-0", small ? "size-8" : "size-10")}>
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
          <div className="truncate text-foreground text-sm">
            {thread.subject}
          </div>
          {small ? null : (
            <p className="mt-0.5 line-clamp-1 text-muted-foreground text-sm">
              {thread.preview}
            </p>
          )}
        </div>
      </Link>
      {correction && Icon ? (
        <Button
          aria-label={`${correction.label}: ${thread.subject}`}
          className="mr-2 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await correction.onClick();
            } finally {
              setPending(false);
            }
          }}
          size="sm"
          title={correction.label}
          type="button"
          variant="ghost"
        >
          <Icon className="size-4" />
          <span className="hidden sm:inline">{correction.label}</span>
        </Button>
      ) : null}
    </div>
  );
}

function TaskRow({ task, href }: { task: AgentTask; href: string }) {
  return (
    <Link
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={href}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground text-sm">
          {task.title}
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {task.detail}
        </div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatShortDate(new Date(task.at))}
      </span>
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

/** Lists are capped, so a full one reads "10+", and an empty one shows no pill. */
function formatCount(count: number, capped: boolean) {
  if (!count) return;
  return capped ? `${count}+` : String(count);
}

function waitingFor(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "Today" : `Waiting ${days}d`;
}

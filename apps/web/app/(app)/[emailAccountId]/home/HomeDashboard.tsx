"use client";

import {
  ArrowRightIcon,
  BotIcon,
  CalendarIcon,
  CheckCircle2Icon,
  ClockIcon,
  CornerUpLeftIcon,
  InboxIcon,
  type LucideIcon,
  MailIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMediaQuery } from "usehooks-ts";
import { LoadingContent } from "@/components/LoadingContent";
import { MarkNeedsReplyButton } from "@/components/thread-context/MarkNeedsReplyButton";
import { SuggestedReply } from "@/components/thread-context/SuggestedReply";
import { ThreadContextList } from "@/components/thread-context/ThreadContextList";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHome } from "@/hooks/useHome";
import { useThreadBrief } from "@/hooks/useThreadBrief";
import { useThreadContext } from "@/hooks/useThreadContext";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import type { AgentTask, HomeThread, Priority } from "@/utils/home/get-home";
import { formatShortDate } from "@/utils/date";
import { getInitials } from "@/utils/email";
import { prefixPath } from "@/utils/path";

/**
 * Cue's home: the inbox organized around outcomes instead of time. What needs
 * you, what the assistant is doing, who owes you a reply, and what was sorted.
 */
export function HomeDashboard() {
  const { emailAccountId, emailAccount } = useAccount();
  const { data, isLoading, error, mutate } = useHome(emailAccountId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The detail panel only fits beside the lists on wide screens. Narrower,
  // a row opens the conversation instead, and nothing is fetched for a panel
  // nobody can see.
  const wide = useMediaQuery("(min-width: 1280px)", {
    initializeWithValue: false,
  });
  const router = useRouter();
  const greetingText = useGreeting();
  const selected = wide
    ? (data?.needsYou.find((t) => t.threadId === selectedId) ??
      data?.waiting.find((t) => t.threadId === selectedId) ??
      data?.alsoInInbox.find((t) => t.threadId === selectedId) ??
      data?.needsYou[0] ??
      null)
    : null;
  const firstName = (emailAccount?.name || "").split(" ")[0];
  const threadHref = (threadId: string) =>
    `${prefixPath(emailAccountId, "/mail")}?thread-id=${encodeURIComponent(threadId)}&thread-account-id=${encodeURIComponent(emailAccountId)}`;
  const select = (threadId: string) =>
    wide ? setSelectedId(threadId) : router.push(threadHref(threadId));

  return (
    <div className="flex min-h-full flex-col xl:flex-row">
      <div className="min-w-0 flex-1 space-y-8 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-title text-2xl text-foreground">
              {greetingText}
              {firstName ? `, ${firstName}` : ""}
            </h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Here's what needs your attention.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={prefixPath(emailAccountId, "/mail")}>
              <InboxIcon className="mr-2 size-4" />
              Open inbox
            </Link>
          </Button>
        </header>

        <LoadingContent
          error={error}
          loading={isLoading}
          loadingComponent={<HomeSkeleton />}
        >
          {data ? (
            <>
              <StatCards stats={data.stats} />

              <Section
                title="Needs you"
                count={data.needsYou.length}
                empty="Nothing needs a reply right now."
              >
                {data.needsYou.map((thread) => (
                  <ThreadRow
                    key={thread.threadId}
                    onSelect={() => select(thread.threadId)}
                    selected={selected?.threadId === thread.threadId}
                    thread={thread}
                  />
                ))}
              </Section>

              <Section
                title="Agent working on"
                count={data.agentTasks.length}
                empty="Nothing in progress. Reply drafts the assistant writes and actions it schedules show up here."
              >
                {data.agentTasks.map((task) => (
                  <AgentTaskRow
                    href={threadHref(task.threadId)}
                    key={task.id}
                    task={task}
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
                    compact
                    key={thread.threadId}
                    onSelect={() => select(thread.threadId)}
                    selected={selected?.threadId === thread.threadId}
                    thread={thread}
                  />
                ))}
              </Section>

              <Section
                title="Also in your inbox"
                count={data.alsoInInbox.length}
                empty="Nothing else in your inbox."
              >
                {data.alsoInInbox.map((thread) => (
                  <ThreadRow
                    compact
                    key={thread.threadId}
                    onSelect={() => select(thread.threadId)}
                    selected={selected?.threadId === thread.threadId}
                    thread={thread}
                  />
                ))}
                <Link
                  className="flex items-center gap-1 px-1 pt-1 text-muted-foreground text-sm hover:text-foreground"
                  href={prefixPath(emailAccountId, "/mail")}
                >
                  See everything in your inbox
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </Section>

              <Section
                title="Sorted automatically"
                count={data.handled.length}
                empty="Nothing sorted in the last week."
              >
                <p className="px-1 pb-1 text-muted-foreground text-sm">
                  Labeled by your rules and left in your inbox. Open a label to
                  see everything in it:
                </p>
                <div className="flex flex-wrap gap-2 px-1 pb-2">
                  {data.handledLabels.map((label) => (
                    <Link
                      className="rounded-full border border-border px-3 py-1 text-sm hover:bg-muted/60"
                      href={`${prefixPath(emailAccountId, "/mail")}?type=label&labelId=${encodeURIComponent(label.labelId)}`}
                      key={label.labelId}
                    >
                      {label.name} · {label.count}
                    </Link>
                  ))}
                </div>
                {data.handled.slice(0, 5).map((thread) => (
                  <Link
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted/60"
                    href={threadHref(thread.threadId)}
                    key={thread.threadId}
                  >
                    <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600" />
                    <span className="truncate text-foreground">
                      {thread.subject}
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {thread.tag ? `Sorted as ${thread.tag}` : "Sorted"}
                    </span>
                  </Link>
                ))}
              </Section>
            </>
          ) : null}
        </LoadingContent>
      </div>

      {selected ? (
        <DetailPanel
          emailAccountId={emailAccountId}
          lane={laneOf(data, selected.threadId)}
          onChanged={() => mutate()}
          threadHref={threadHref}
          thread={selected}
        />
      ) : null}
    </div>
  );
}

function StatCards({
  stats,
}: {
  stats: NonNullable<ReturnType<typeof useHome>["data"]>["stats"];
}) {
  const cards: {
    value: string;
    label: string;
    detail: string;
    icon: LucideIcon;
    className: string;
  }[] = [
    {
      value: countLabel(stats.needsYou, stats.needsYouCapped),
      label: "Need your response",
      detail: stats.needsYou ? `~${stats.estimatedMinutes} min` : "All clear",
      icon: InboxIcon,
      className:
        "bg-rose-50 text-rose-950 dark:bg-rose-950/30 dark:text-rose-100",
    },
    {
      value: String(stats.agentWorking),
      label: "Agent working on",
      detail: stats.agentWorking ? "In progress" : "Idle",
      icon: BotIcon,
      className: "bg-sky-50 text-sky-950 dark:bg-sky-950/30 dark:text-sky-100",
    },
    {
      value: countLabel(stats.waiting, stats.waitingCapped),
      label: "Waiting on others",
      detail: "Replies expected",
      icon: ClockIcon,
      className:
        "bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100",
    },
    {
      value: countLabel(stats.handled, stats.handledCapped),
      label: "Sorted automatically",
      detail: `Last ${stats.handledWindowDays} days`,
      icon: CheckCircle2Icon,
      className:
        "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div className={cn("rounded-xl p-4", card.className)} key={card.label}>
          <div className="flex items-start justify-between">
            <div className="font-title text-3xl">{card.value}</div>
            <card.icon className="size-4 opacity-60" />
          </div>
          <div className="mt-1 font-medium text-sm">{card.label}</div>
          <div className="mt-2 text-xs opacity-70">{card.detail}</div>
        </div>
      ))}
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

const PRIORITY_STYLE: Record<Priority, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
};

function ThreadRow({
  thread,
  selected,
  onSelect,
  compact,
  waiting,
}: {
  thread: HomeThread;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
  /** Show how long the user has been waiting instead of when it arrived. */
  waiting?: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-4 text-left transition-colors",
        compact ? "py-2.5" : "py-3.5",
        selected
          ? "border-primary/30 bg-primary/5"
          : "border-border bg-card hover:bg-muted/50",
      )}
      onClick={onSelect}
      type="button"
    >
      <Avatar className={cn("shrink-0", compact ? "size-8" : "size-10")}>
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
            {waiting ? waitingFor(thread.at) : formatTime(thread.at)}
          </span>
        </div>
        <div className="truncate text-foreground text-sm">{thread.subject}</div>
        {compact ? null : (
          <div className="mt-0.5 flex items-start gap-2">
            <p className="line-clamp-1 flex-1 text-muted-foreground text-sm">
              {thread.preview}
            </p>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 font-medium text-xs capitalize",
                PRIORITY_STYLE[thread.priority],
              )}
            >
              {thread.priority}
            </span>
          </div>
        )}
      </div>
    </button>
  );
}

const TASK_ICON: Record<AgentTask["kind"], LucideIcon> = {
  draft: MailIcon,
  scheduled: CalendarIcon,
  processing: BotIcon,
};

function AgentTaskRow({ task, href }: { task: AgentTask; href: string }) {
  const Icon = TASK_ICON[task.kind];
  return (
    <Link
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-muted/50"
      href={href}
    >
      <Icon className="size-5 shrink-0 text-sky-600" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{task.title}</div>
        <div className="text-muted-foreground text-xs">{task.detail}</div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs">
        {task.kind === "scheduled" ? formatTime(task.at) : "View"}
      </span>
    </Link>
  );
}

function DetailPanel({
  thread,
  emailAccountId,
  threadHref,
  lane,
  onChanged,
}: {
  thread: HomeThread;
  emailAccountId: string;
  threadHref: (threadId: string) => string;
  lane: "needs-you" | "waiting" | "other";
  onChanged: () => void;
}) {
  const {
    data: briefData,
    isLoading,
    error,
  } = useThreadBrief({
    threadId: thread.threadId,
    emailAccountId,
  });
  const brief = briefData?.brief;
  const router = useRouter();
  const { data: context } = useThreadContext({
    threadId: thread.threadId,
    emailAccountId,
  });
  const steps = suggestedSteps({
    thread,
    context: context?.items ?? [],
    threadHref,
  });

  return (
    <aside
      aria-label="Selected conversation"
      className="w-full shrink-0 space-y-4 border-border bg-muted/20 px-4 py-6 xl:sticky xl:top-0 xl:h-svh xl:w-[420px] xl:overflow-y-auto xl:border-l"
    >
      <div className="flex items-center gap-3">
        <Avatar className="size-11">
          <AvatarFallback className="font-medium">
            {getInitials(thread.fromName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate font-title text-lg">{thread.fromName}</div>
          <div className="truncate text-muted-foreground text-sm">
            {thread.fromEmail}
            {thread.tag ? ` · ${thread.tag}` : ""}
          </div>
        </div>
      </div>
      {lane === "other" ? (
        <MarkNeedsReplyButton
          emailAccountId={emailAccountId}
          onMarked={onChanged}
          threadId={thread.threadId}
        />
      ) : null}

      <PanelCard icon={SparklesIcon} title="AI summary">
        <LoadingContent
          error={error}
          loading={isLoading}
          loadingComponent={
            <div className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          }
        >
          {brief ? (
            <>
              <p className="text-foreground text-sm leading-6">
                {brief.summary}
              </p>
              {brief.keyPoints.length ? (
                <>
                  <div className="mt-3 font-medium text-sm">Key points</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground text-sm">
                    {brief.keyPoints.map((point, index) => (
                      <li key={index}>{point}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {brief.source === "extract" ? (
                <p className="mt-3 text-muted-foreground text-xs">
                  {brief.aiUnavailable
                    ? "Taken from the email itself. Upgrade or add an AI key for written summaries."
                    : "Taken from the email itself."}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              No summary available.
            </p>
          )}
        </LoadingContent>
      </PanelCard>

      <PanelCard icon={SparklesIcon} title="Relevant context">
        <div className="-mx-2">
          <ThreadContextList
            emailAccountId={emailAccountId}
            onOpenThread={(id) => router.push(threadHref(id))}
            threadId={thread.threadId}
          />
        </div>
      </PanelCard>

      {lane === "waiting" ? null : (
        <PanelCard icon={SparklesIcon} title="Suggested reply">
          <SuggestedReply
            emailAccountId={emailAccountId}
            onOpenThread={(id) => router.push(threadHref(id))}
            threadId={thread.threadId}
          />
        </PanelCard>
      )}

      <PanelCard icon={SparklesIcon} title="Suggested next steps">
        <div className="space-y-1">
          {steps.map((step) => (
            <Link
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60"
              href={step.href}
              key={step.href + step.title}
              rel={step.external ? "noreferrer" : undefined}
              target={step.external ? "_blank" : undefined}
            >
              <step.icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">{step.title}</div>
                <div className="truncate text-muted-foreground text-xs">
                  {step.detail}
                </div>
              </div>
              <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </PanelCard>
    </aside>
  );
}

function PanelCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 flex items-center gap-2 font-medium text-sm">
        <Icon className="size-4 text-primary" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Next steps built from what Cue actually found: reply, read the related
 * conversation it surfaced, or prepare for the meeting coming up.
 */
function suggestedSteps({
  thread,
  context,
  threadHref,
}: {
  thread: HomeThread;
  context: NonNullable<ReturnType<typeof useThreadContext>["data"]>["items"];
  threadHref: (threadId: string) => string;
}) {
  const steps: {
    title: string;
    detail: string;
    href: string;
    icon: LucideIcon;
    external?: boolean;
  }[] = [
    {
      title: `Reply to ${thread.fromName.split(" ")[0]}`,
      detail: "Open the conversation",
      href: threadHref(thread.threadId),
      icon: CornerUpLeftIcon,
    },
  ];
  const email = context.find((item) => item.kind === "email");
  if (email) {
    steps.push({
      title: "Review related email",
      detail: email.title,
      href: threadHref(email.id),
      icon: MailIcon,
    });
  }
  const meeting = context.find(
    (item) =>
      item.kind === "event" && item.url && Date.parse(item.at) > Date.now(),
  );
  if (meeting?.url) {
    steps.push({
      title: "Prepare for the meeting",
      detail: meeting.title,
      href: meeting.url,
      icon: CalendarIcon,
      external: true,
    });
  }
  return steps;
}

function HomeSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton className="h-28 rounded-xl" key={i} />
        ))}
      </div>
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

function countLabel(count: number, capped: boolean) {
  return capped ? `${count}+` : String(count);
}

function formatTime(iso: string) {
  return formatShortDate(new Date(iso));
}

function waitingFor(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "Today" : `Waiting ${days}d`;
}

function laneOf(
  data: ReturnType<typeof useHome>["data"],
  threadId: string,
): "needs-you" | "waiting" | "other" {
  if (data?.needsYou.some((t) => t.threadId === threadId)) return "needs-you";
  if (data?.waiting.some((t) => t.threadId === threadId)) return "waiting";
  return "other";
}

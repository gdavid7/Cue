"use client";

import {
  CalendarIcon,
  FileTextIcon,
  GlobeIcon,
  GraduationCapIcon,
  type LucideIcon,
  MailIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { LoadingContent } from "@/components/LoadingContent";
import { Skeleton } from "@/components/ui/skeleton";
import { useThreadContext } from "@/hooks/useThreadContext";
import type { ThreadContextItem } from "@/utils/thread-context/get-thread-context";
import { reasonLabel } from "@/utils/thread-context/reason-label";

const KIND: Record<
  ThreadContextItem["kind"],
  { icon: LucideIcon; label: string }
> = {
  email: { icon: MailIcon, label: "Email" },
  event: { icon: CalendarIcon, label: "Calendar" },
  file: { icon: FileTextIcon, label: "File" },
  assignment: { icon: GraduationCapIcon, label: "Assignment" },
  chat: { icon: MessagesSquareIcon, label: "Message" },
  web: { icon: GlobeIcon, label: "Web" },
};

/**
 * Items elsewhere in the user's mail and calendar that matter for a thread,
 * each with the reason it's here. Used beside the mail reader and on Home.
 */
export function ThreadContextList({
  threadId,
  emailAccountId,
  onOpenThread,
}: {
  threadId: string;
  emailAccountId: string;
  onOpenThread: (threadId: string) => void;
}) {
  const { data, isLoading, error } = useThreadContext({
    threadId,
    emailAccountId,
  });

  return (
    <LoadingContent
      error={error}
      errorComponent={
        <PanelMessage
          title="Couldn't load context"
          body="Try opening the conversation again."
        />
      }
      loading={isLoading}
      loadingComponent={<ContextSkeleton />}
    >
      {data?.items.length ? (
        <ul className="space-y-1">
          {data.items.map((item) => (
            <li key={item.id}>
              <ContextItem item={item} onOpenThread={onOpenThread} />
            </li>
          ))}
        </ul>
      ) : (
        <PanelMessage
          title="Nothing related found"
          body="No other conversations or meetings with these people or about this topic."
        />
      )}
    </LoadingContent>
  );
}

function ContextItem({
  item,
  onOpenThread,
}: {
  item: ThreadContextItem;
  onOpenThread: (threadId: string) => void;
}) {
  const { icon: Icon, label } = KIND[item.kind];
  const content = (
    <>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-medium text-foreground text-sm">
            {item.title}
          </div>
          <div className="mt-0.5 text-muted-foreground text-xs">
            {item.source ?? label} · {formatWhen(item.at)}
          </div>
        </div>
      </div>
      {item.snippet ? (
        <p className="mt-1.5 line-clamp-2 pl-6 text-muted-foreground text-xs leading-5">
          {item.snippet}
        </p>
      ) : null}
      {item.reasons.length ? (
        <div className="mt-2 flex flex-wrap gap-1 pl-6">
          {item.reasons.map((reason, index) => (
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              // Reasons never reorder, and two can read the same.
              key={index}
            >
              {reasonLabel(reason)}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );

  const className =
    "block w-full rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/60";

  if (item.kind === "email") {
    return (
      <button
        className={className}
        onClick={() => onOpenThread(item.id)}
        type="button"
      >
        {content}
      </button>
    );
  }
  if (item.url) {
    return (
      <a className={className} href={item.url} rel="noreferrer" target="_blank">
        {content}
      </a>
    );
  }
  return <div className={className}>{content}</div>;
}

function PanelMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-4 text-center">
      <div className="font-medium text-foreground text-sm">{title}</div>
      <p className="mt-1 text-muted-foreground text-xs leading-5">{body}</p>
    </div>
  );
}

function ContextSkeleton() {
  return (
    <div className="space-y-4 px-2 py-1">
      {[0, 1, 2].map((i) => (
        <div className="space-y-2" key={i}>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

// Whole days, rounded toward zero like the "In 2d" reason, so they agree.
function formatWhen(iso: string) {
  const date = new Date(iso);
  const days = Math.trunc((date.getTime() - Date.now()) / 86_400_000);
  if (days === 0)
    return date.getTime() >= Date.now() ? "today" : "earlier today";
  if (days > 0) return `in ${days}d`;
  if (days > -30) return `${-days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

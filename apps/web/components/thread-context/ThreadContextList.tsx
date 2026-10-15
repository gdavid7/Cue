"use client";

import {
  CalendarIcon,
  ContactIcon,
  FileTextIcon,
  GlobeIcon,
  GraduationCapIcon,
  ListTodoIcon,
  type LucideIcon,
  MailIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { useState } from "react";
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
  task: { icon: ListTodoIcon, label: "Task" },
  contact: { icon: ContactIcon, label: "Contact" },
};

/**
 * Items elsewhere in the user's mail and calendar that matter for a thread,
 * one line each, with why it's here on hover. Renders nothing until there is
 * something to show, so it never takes room from the conversation.
 */
export function ThreadContextList({
  threadId,
  emailAccountId,
  onOpenThread,
  limit,
  heading,
}: {
  threadId: string;
  emailAccountId: string;
  onOpenThread: (threadId: string) => void;
  /** Rows shown before "Show more". All of them when unset. */
  limit?: number;
  heading?: string;
}) {
  const { data } = useThreadContext({ threadId, emailAccountId });
  const [expanded, setExpanded] = useState(false);
  const items = data?.items ?? [];
  if (!items.length) return null;

  const shown = expanded || !limit ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;

  return (
    <section aria-label={heading ?? "Related"}>
      {heading ? (
        <h3 className="mb-1 px-2 font-medium text-muted-foreground text-xs">
          {heading}
        </h3>
      ) : null}
      <ul>
        {shown.map((item, index) => (
          <li
            className={
              limit && index >= limit
                ? "fade-in slide-in-from-top-1 animate-in duration-300"
                : undefined
            }
            key={item.id}
          >
            <ContextItem item={item} onOpenThread={onOpenThread} />
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          className="mt-0.5 rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Show {hidden} more
        </button>
      ) : null}
    </section>
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
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground">{item.title}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {item.source ?? label} · {formatWhen(item.at)}
      </span>
    </>
  );
  const props = {
    className:
      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 active:bg-muted",
    title: item.reasons.map(reasonLabel).join(" · ") || undefined,
  };

  if (item.kind === "email") {
    return (
      <button {...props} onClick={() => onOpenThread(item.id)} type="button">
        {content}
      </button>
    );
  }
  if (item.url) {
    return (
      <a {...props} href={item.url} rel="noreferrer" target="_blank">
        {content}
      </a>
    );
  }
  return <div {...props}>{content}</div>;
}

// Whole days, rounded toward zero, so "in 2d" agrees with the reason it gives.
function formatWhen(iso: string) {
  const date = new Date(iso);
  const days = Math.trunc((date.getTime() - Date.now()) / 86_400_000);
  if (days === 0)
    return date.getTime() >= Date.now() ? "today" : "earlier today";
  if (days > 0) return `in ${days}d`;
  if (days > -30) return `${-days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

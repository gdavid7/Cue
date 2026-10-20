"use client";

import Link from "next/link";
import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useGetStarted } from "@/hooks/useGetStarted";
import { useMailHref } from "@/hooks/useMailHref";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import {
  GET_STARTED_DISMISSED_HINT,
  type GetStartedItemId,
} from "@/utils/get-started/checklist";
import { prefixPath } from "@/utils/path";
import { cn } from "@/utils";

const ITEM_COPY: Record<
  GetStartedItemId,
  { title: string; hint: string; target?: "mail" | "calendars" }
> = {
  "inbox-style": {
    title: "Pick your inbox style",
    hint: "Tabs, Focused and Other, or one inbox.",
    target: "mail",
  },
  keyboard: {
    title: "Triage 5 emails from the keyboard",
    hint: "E archives, # deletes, H snoozes.",
    target: "mail",
  },
  reply: {
    title: "Send a reply Cue drafted",
    hint: "Open an email marked Draft ready.",
    target: "mail",
  },
  ask: {
    title: "Ask Cue or search your mail",
    hint: "Ask Cue is at the top of your inbox.",
    target: "mail",
  },
  calendar: {
    title: "Connect your calendar",
    hint: "So Cue can prepare you for meetings.",
    target: "calendars",
  },
  phone: {
    title: "Add Cue to your phone",
    hint: "Open Cue in your phone's browser, then Add to Home Screen.",
  },
};

/**
 * The first week's checklist on Today. Each step ticks itself off from what
 * the person does; it goes away when all are done, after a week, or when
 * closed.
 */
export function GetStartedChecklist() {
  const { emailAccountId } = useAccount();
  const mailHref = useMailHref();
  const { data, mutate } = useGetStarted();
  const { data: user, mutate: mutateUser } = useUser();
  const items = data?.items;
  if (!items) return null;

  const doneCount = items.filter((item) => item.done).length;
  const hrefFor = (target: "mail" | "calendars") =>
    target === "mail" ? mailHref() : prefixPath(emailAccountId, "/calendars");

  const dismiss = () => {
    mutate({ items: null }, { revalidate: false });
    if (user) {
      mutateUser(
        {
          ...user,
          dismissedHints: [...user.dismissedHints, GET_STARTED_DISMISSED_HINT],
        },
        { revalidate: false },
      );
    }
    dismissHintAction({ hintId: GET_STARTED_DISMISSED_HINT }).finally(() =>
      mutateUser(),
    );
  };

  return (
    <section
      aria-labelledby="get-started-title"
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="get-started-title" className="font-medium text-sm">
            Get started with Cue
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {doneCount} of {items.length} done. Each step checks itself off.
          </p>
        </div>
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Hide checklist"
          onClick={dismiss}
        >
          <XIcon className="size-4" aria-hidden />
        </Button>
      </div>
      <Progress
        value={(doneCount / items.length) * 100}
        aria-label="Steps done"
        className="mt-3 h-1"
        innerClassName="bg-primary motion-reduce:transition-none"
      />
      <ul className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {items.map((item) => {
          const copy = ITEM_COPY[item.id];
          const body = (
            <>
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  item.done
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40",
                )}
                aria-hidden
              >
                {item.done ? <CheckIcon className="size-3" /> : null}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-sm",
                    item.done && "text-muted-foreground line-through",
                  )}
                >
                  {copy.title}
                  <span className="sr-only">{item.done ? ", done" : ""}</span>
                </span>
                {item.done ? null : (
                  <span className="block text-muted-foreground text-xs">
                    {copy.hint}
                  </span>
                )}
              </span>
            </>
          );
          const rowClassName = "flex gap-2 rounded-md px-1.5 py-1.5";
          return (
            <li
              key={item.id}
              data-get-started-item={item.id}
              data-done={item.done}
            >
              {copy.target && !item.done ? (
                <Link
                  href={hrefFor(copy.target)}
                  className={cn(rowClassName, "hover:bg-muted active:bg-muted")}
                >
                  {body}
                </Link>
              ) : (
                <div className={rowClassName}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

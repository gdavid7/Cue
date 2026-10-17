"use client";

import { type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { posthog } from "@/utils/analytics/posthog-client";
import { toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMailSettings } from "@/hooks/useMailSettings";
import { useSignUpEvent } from "@/hooks/useSignupEvent";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import { applyInboxStyleAction } from "@/utils/actions/mail-split";
import type { ApplyInboxStyleBody } from "@/utils/actions/mail-split.validation";
import { getActionErrorMessage } from "@/utils/error";
import {
  getDefaultInboxStyle,
  getInboxStyleHintId,
  getInboxStyleOptions,
  type InboxStyle,
} from "@/utils/split-inbox/inbox-styles";
import { cn } from "@/utils";
import { ONBOARDING_ANALYTICS_EVENTS } from "@/utils/analytics/product";

const TITLE = "How should Cue split your inbox?";
const REASSURANCE =
  "Cue adds matching tabs. Nothing in your mailbox is labelled or moved.";
// The first-run card leads with Cue's own tabs, the part that shows the work.
const CARD_TITLE = "Let Cue find what needs you";
const CARD_REASSURANCE =
  "Cue adds tabs inside Cue. Nothing in your mailbox is labelled or moved.";

const STYLE_COPY: Record<
  InboxStyle,
  { name: string; description: string; tabCount: number }
> = {
  tabs: {
    name: "Tabs",
    description: "Primary, Promotions, Social, Updates",
    tabCount: 4,
  },
  "focused-other": {
    name: "Focused and Other",
    description: "What matters first, the rest in Other",
    tabCount: 2,
  },
  "one-inbox": {
    name: "One inbox",
    description: "Everything together",
    tabCount: 0,
  },
};

/**
 * Shown once per mailbox above the list, not as a dialog, so first-time mail
 * stays usable (and clickable) while the person decides.
 */
export function InboxStyleCard({
  ready,
  onDone,
}: {
  /** False while the first page of mail is still loading. */
  ready: boolean;
  /** Called once a style is applied, to start the tour. */
  onDone: () => void;
}) {
  const { emailAccountId, provider } = useAccount();
  const { data: user, mutate: mutateUser } = useUser();
  const [chosen, setChosen] = useState<InboxStyle | null>(null);
  const [addCueTabs, setAddCueTabs] = useState(true);
  const [isClosed, setIsClosed] = useState(false);
  const hintId = getInboxStyleHintId(emailAccountId);
  const { apply, isApplying } = useApplyInboxStyle(() => {
    setIsClosed(true);
    // The saved hint keeps the card hidden for good once a style is chosen.
    dismissHintAction({ hintId }).then(() => mutateUser());
    onDone();
  });

  const options = getInboxStyleOptions(provider);
  if (
    !ready ||
    isClosed ||
    !user ||
    options.length < 2 ||
    user.dismissedHints.includes(hintId) ||
    isSnoozedThisSession(hintId)
  ) {
    return null;
  }

  const style = chosen ?? getDefaultInboxStyle(provider);

  // "Not now" is not a decision: the card returns next session, and the
  // same choice stays in the split library meanwhile.
  function snooze() {
    posthog?.capture(ONBOARDING_ANALYTICS_EVENTS.setupChoice, {
      action: "not_now",
      style,
      cue_tabs: addCueTabs,
    });
    setIsClosed(true);
    try {
      sessionStorage.setItem(hintId, "snoozed");
    } catch {
      // Private mode or blocked storage: closing for this view is enough.
    }
  }

  return (
    <section
      aria-labelledby="inbox-style-title"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <h2 id="inbox-style-title" className="font-medium text-sm">
        {CARD_TITLE}
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs">{CARD_REASSURANCE}</p>
      <CueTabsCheckbox
        id="inbox-style-cue-tabs"
        className="mt-3 rounded-lg border border-border p-2 text-sm"
        checked={addCueTabs}
        onCheckedChange={setAddCueTabs}
        label="Needs reply and Reading tabs."
      />
      <h3 className="mt-3 text-muted-foreground text-xs">
        Keep a familiar layout
      </h3>
      <InboxStyleOptions
        className="mt-1.5"
        options={options}
        value={style}
        onChange={setChosen}
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="xs-2"
          variant="ghost"
          disabled={isApplying}
          onClick={snooze}
        >
          Not now
        </Button>
        <Button
          size="xs-2"
          loading={isApplying}
          onClick={() => {
            posthog?.capture(ONBOARDING_ANALYTICS_EVENTS.setupChoice, {
              action: "apply",
              style,
              cue_tabs: addCueTabs,
            });
            apply({ style, addCueTabs });
          }}
        >
          Set up my inbox
        </Button>
      </div>
      <RegistrationConversion />
    </section>
  );
}

/** Re-opens the same choice later, from the split library ("Match my old inbox"). */
export function InboxStyleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { provider } = useAccount();
  const [chosen, setChosen] = useState<InboxStyle | null>(null);
  // Off here: people reopen this to change the style, so the tabs are an
  // explicit choice rather than something re-added each time.
  const [addCueTabs, setAddCueTabs] = useState(false);
  const { apply, isApplying } = useApplyInboxStyle(() => onOpenChange(false));

  const options = getInboxStyleOptions(provider);
  const style = chosen ?? getDefaultInboxStyle(provider);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription>{REASSURANCE}</DialogDescription>
        </DialogHeader>
        <InboxStyleOptions
          options={options}
          value={style}
          onChange={setChosen}
        />
        <CueTabsCheckbox
          id="inbox-style-dialog-cue-tabs"
          className="text-xs"
          checked={addCueTabs}
          onCheckedChange={setAddCueTabs}
          label={
            <>
              Also add &ldquo;Needs reply&rdquo; and &ldquo;Reading&rdquo; tabs.
            </>
          }
        />
        <DialogFooter>
          <Button
            loading={isApplying}
            onClick={() => apply({ style, addCueTabs })}
          >
            Use this
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CueTabsCheckbox({
  id,
  checked,
  onCheckedChange,
  label,
  className,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-2 sm:max-w-md",
        className,
      )}
    >
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span>
        <span className="font-medium">{label}</span>{" "}
        <span className="text-muted-foreground text-xs">
          Needs reply holds mail waiting on your answer; Reading holds
          newsletters and promotions. Cue sorts them itself.
        </span>
      </span>
    </label>
  );
}

function useApplyInboxStyle(onApplied: () => void) {
  const { emailAccountId } = useAccount();
  const { mutate: mutateSettings } = useMailSettings();
  const [isApplying, setIsApplying] = useState(false);

  const apply = async (input: ApplyInboxStyleBody) => {
    setIsApplying(true);
    const result = await applyInboxStyleAction(emailAccountId, input);
    setIsApplying(false);
    if (result?.serverError || result?.validationErrors) {
      toast.error(getActionErrorMessage(result));
      return;
    }
    await mutateSettings();
    toastSuccess({ description: getAppliedMessage(input) });
    onApplied();
  };

  return { apply, isApplying };
}

/**
 * The card is the first thing a new account sees, so it reports the completed
 * sign-up the old onboarding used to. The endpoint only counts new users.
 */
function RegistrationConversion() {
  useSignUpEvent();
  return null;
}

function InboxStyleOptions({
  options,
  value,
  onChange,
  className,
}: {
  options: InboxStyle[];
  value: InboxStyle;
  onChange: (style: InboxStyle) => void;
  className?: string;
}) {
  // Arrow keys move the choice, as in any radio group; Tab leaves the group.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.indexOf(value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-inbox-style="${next}"]`)
      ?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Inbox style"
      onKeyDown={onKeyDown}
      className={cn("grid grid-cols-2 gap-2 sm:max-w-md", className)}
    >
      {options.map((style) => {
        const checked = style === value;
        const copy = STYLE_COPY[style];
        return (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-inbox-style={style}
            onClick={() => onChange(style)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-accent",
            )}
          >
            <StyleThumbnail tabCount={copy.tabCount} />
            <span className="min-w-0">
              <span className="block font-medium text-xs">{copy.name}</span>
              <span className="block text-[11px] text-muted-foreground leading-4">
                {copy.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A schematic inbox, not a product screenshot: a tab strip over a few rows. */
function StyleThumbnail({ tabCount }: { tabCount: number }) {
  return (
    <span
      aria-hidden
      className="flex h-12 flex-col gap-1 rounded-md border border-border bg-background p-1.5"
    >
      {tabCount > 0 && (
        <span className="flex gap-0.5">
          {Array.from({ length: tabCount }, (_, index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                index === 0 ? "bg-primary/60" : "bg-muted-foreground/25",
              )}
            />
          ))}
        </span>
      )}
      {["w-full", "w-4/5", "w-11/12", "w-3/4"]
        .slice(0, tabCount > 0 ? 3 : 4)
        .map((width) => (
          <span
            key={width}
            className={cn(
              "block h-1 rounded-full bg-muted-foreground/20",
              width,
            )}
          />
        ))}
    </span>
  );
}

const ARROW_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function getAppliedMessage(input: ApplyInboxStyleBody) {
  if (input.addCueTabs)
    return "Tabs added. Needs reply fills in over the next minute.";
  if (STYLE_COPY[input.style].tabCount > 0) return "Tabs added";
  return "Saved. Your mail stays in one inbox.";
}

function isSnoozedThisSession(hintId: string) {
  try {
    return sessionStorage.getItem(hintId) === "snoozed";
  } catch {
    return false;
  }
}

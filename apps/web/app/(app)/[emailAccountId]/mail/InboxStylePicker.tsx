"use client";

import { useState } from "react";
import { toast } from "sonner";
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

const TITLE = "Which looks like your inbox?";
const REASSURANCE = "Cue adds matching tabs. Nothing in your mailbox is moved.";

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
export function InboxStyleCard({ onDone }: { onDone: () => void }) {
  const { emailAccountId, provider } = useAccount();
  const { data: user, mutate: mutateUser } = useUser();
  const [chosen, setChosen] = useState<InboxStyle | null>(null);
  const [addCueTabs, setAddCueTabs] = useState(true);
  // Hides the card at once; the hint saved below keeps it hidden next visit.
  const [isClosed, setIsClosed] = useState(false);
  const { apply, isApplying } = useApplyInboxStyle(() => close());

  const hintId = getInboxStyleHintId(emailAccountId);
  const options = getInboxStyleOptions(provider);
  if (
    isClosed ||
    !user ||
    options.length < 2 ||
    user.dismissedHints.includes(hintId)
  ) {
    return null;
  }

  const style = chosen ?? getDefaultInboxStyle(provider);

  function close() {
    setIsClosed(true);
    dismissHintAction({ hintId }).then(() => mutateUser());
    onDone();
  }

  return (
    <section
      aria-labelledby="inbox-style-title"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <h2 id="inbox-style-title" className="font-medium text-sm">
        {TITLE}
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs">{REASSURANCE}</p>
      <InboxStyleOptions
        className="mt-3"
        options={options}
        value={style}
        onChange={setChosen}
      />
      <label
        htmlFor="inbox-style-cue-tabs"
        className="mt-3 flex cursor-pointer items-start gap-2 text-xs sm:max-w-md"
      >
        <Checkbox
          id="inbox-style-cue-tabs"
          className="mt-0.5"
          checked={addCueTabs}
          onCheckedChange={(checked) => setAddCueTabs(checked === true)}
        />
        <span>
          Also add &ldquo;Needs reply&rdquo; and &ldquo;Reading&rdquo; tabs.{" "}
          <span className="text-muted-foreground">
            Cue adds labels such as &ldquo;To Reply&rdquo; and
            &ldquo;Newsletter&rdquo; in your mailbox; it never moves emails.
          </span>
        </span>
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="xs-2"
          variant="ghost"
          disabled={isApplying}
          onClick={close}
        >
          Not now
        </Button>
        <Button
          size="xs-2"
          loading={isApplying}
          onClick={() => apply({ style, addCueTabs })}
        >
          Use this
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
        <DialogFooter>
          <Button
            loading={isApplying}
            onClick={() => apply({ style, addCueTabs: false })}
          >
            Use this
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  return (
    <div
      role="radiogroup"
      aria-label="Inbox style"
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

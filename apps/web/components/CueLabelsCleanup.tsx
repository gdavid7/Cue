"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import useSWR, { useSWRConfig } from "swr";
import type { GetCueLabelsResponse } from "@/app/api/user/cue-labels/route";
import { toastError, toastSuccess } from "@/components/Toast";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { removeCueLabelsAction } from "@/utils/actions/cue-labels";
import { dismissHintAction } from "@/utils/actions/hints";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getActionErrorMessage } from "@/utils/error";
import { getCueLabelsHintId } from "@/utils/label/cue-default-labels";
import { isInboxStyleCardPending } from "@/utils/split-inbox/inbox-styles";
import { cn } from "@/utils";

type CueLabel = GetCueLabelsResponse["labels"][number];

const TITLE = "Remove Cue’s labels from Gmail";
const DESCRIPTION =
  "Cue sorts your mail inside Cue now and no longer uses these labels. Your emails aren’t deleted, only the labels.";
const OWN_LABEL_NOTE = "Untick any label you created yourself before Cue.";

/**
 * Shown once per mailbox above the mail list while Cue's old labels are still
 * in Gmail. Settings keeps the same choice available after it's dismissed.
 */
export function CueLabelsCard() {
  const { emailAccountId, provider } = useAccount();
  const { data: user, mutate: mutateUser } = useUser();
  // Hides the card at once; the hint saved below keeps it hidden next visit.
  const [isClosed, setIsClosed] = useState(false);

  const hintId = getCueLabelsHintId(emailAccountId);
  // Waits for the inbox style card, so a mailbox never shows both at once.
  const isHidden =
    isClosed ||
    !user ||
    user.dismissedHints.includes(hintId) ||
    isInboxStyleCardPending({
      provider,
      emailAccountId,
      dismissedHints: user.dismissedHints,
    });
  const { data } = useCueLabels(isHidden ? null : emailAccountId, provider);
  const removal = useCueLabelsRemoval({
    emailAccountId,
    labels: data?.labels ?? [],
    onRemoved: () => setIsClosed(true),
  });

  if (isHidden || !data?.labels.length) return null;

  function close() {
    setIsClosed(true);
    dismissHintAction({ hintId }).then(() => mutateUser());
  }

  return (
    <section
      aria-labelledby="cue-labels-title"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <h2 id="cue-labels-title" className="font-medium text-sm">
        {TITLE}
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs">
        {DESCRIPTION} {OWN_LABEL_NOTE}
      </p>
      <CueLabelsChecklist
        className="mt-3"
        idPrefix="cue-labels-card"
        labels={data.labels}
        removal={removal}
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="xs-2"
          variant="ghost"
          disabled={removal.isExecuting}
          onClick={close}
        >
          Keep labels
        </Button>
        <RemoveButton size="xs-2" removal={removal} />
      </div>
    </section>
  );
}

/** The same choice in Settings, for after the mail-screen card is dismissed. */
export function CueLabelsSetting({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useCueLabels(emailAccountId, provider);
  const removal = useCueLabelsRemoval({
    emailAccountId,
    labels: data?.labels ?? [],
    onRemoved: () => setOpen(false),
  });

  if (!data?.labels.length) return null;

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Cue&apos;s old Gmail labels</ItemTitle>
          <ItemDescription>{DESCRIPTION}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Review labels
          </Button>
        </ItemActions>
      </Item>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{TITLE}</DialogTitle>
            <DialogDescription>
              {DESCRIPTION} {OWN_LABEL_NOTE}
            </DialogDescription>
          </DialogHeader>
          <CueLabelsChecklist
            idPrefix={`cue-labels-${emailAccountId}`}
            labels={data.labels}
            removal={removal}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={removal.isExecuting}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <RemoveButton removal={removal} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CueLabelsChecklist({
  idPrefix,
  labels,
  removal,
  className,
}: {
  idPrefix: string;
  labels: CueLabel[];
  removal: ReturnType<typeof useCueLabelsRemoval>;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y divide-border rounded-lg border", className)}>
      {labels.map((label) => {
        const id = `${idPrefix}-${label.id}`;
        return (
          <li key={label.id}>
            <label
              htmlFor={id}
              className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm"
            >
              <Checkbox
                id={id}
                checked={removal.isSelected(label.id)}
                disabled={removal.isExecuting}
                onCheckedChange={(checked) =>
                  removal.setSelected(label.id, checked === true)
                }
              />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              {label.messagesTotal !== null && (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {formatEmailCount(label.messagesTotal)}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function RemoveButton({
  removal,
  size,
}: {
  removal: ReturnType<typeof useCueLabelsRemoval>;
  size?: "xs-2";
}) {
  const count = removal.selectedIds.length;
  return (
    <Button
      size={size}
      variant="destructive"
      loading={removal.isExecuting}
      disabled={!count}
      onClick={removal.remove}
    >
      {count === 1 ? "Remove 1 label" : `Remove ${count} labels`}
    </Button>
  );
}

function useCueLabels(
  emailAccountId: string | null | undefined,
  provider: string,
) {
  return useSWR<GetCueLabelsResponse>(
    emailAccountId && isGoogleProvider(provider)
      ? ["/api/user/cue-labels", emailAccountId]
      : null,
  );
}

/**
 * Every label starts ticked; only the ones the person unticks are tracked, so
 * labels that load later are included without syncing state.
 */
function useCueLabelsRemoval({
  emailAccountId,
  labels,
  onRemoved,
}: {
  emailAccountId: string;
  labels: CueLabel[];
  onRemoved: () => void;
}) {
  const { mutate } = useSWRConfig();
  const { mutate: mutateUser } = useUser();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const selectedIds = labels
    .filter((label) => !unticked.has(label.id))
    .map((label) => label.id);

  const { execute, isExecuting } = useAction(
    removeCueLabelsAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        const results = data?.results ?? [];
        const removed = results.filter((result) => result.status === "removed");
        const failed = results.filter((result) => result.status === "failed");

        if (failed.length) {
          toastError({
            description: `Couldn’t remove ${failed.map((result) => result.name).join(", ")}. Try again from Settings.`,
          });
        }
        if (removed.length) {
          toastSuccess({
            description: `Removed ${removed.length === 1 ? "1 label" : `${removed.length} labels`}. Your emails are still there.`,
          });
        }

        // The sidebar's labels and counts are cached per account under these.
        mutate(
          (key) =>
            isAccountKey(key, "/api/user/cue-labels", emailAccountId) ||
            isAccountKey(key, "/api/labels", emailAccountId),
        );
        // Labels left unticked were kept on purpose, so the card isn't offered again.
        dismissHintAction({ hintId: getCueLabelsHintId(emailAccountId) }).then(
          () => mutateUser(),
        );
        onRemoved();
      },
      onError: ({ error }) => {
        toastError({ description: getActionErrorMessage(error) });
      },
    },
  );

  return {
    selectedIds,
    isExecuting,
    isSelected: (labelId: string) => !unticked.has(labelId),
    setSelected: (labelId: string, selected: boolean) =>
      setUnticked((current) => {
        const next = new Set(current);
        if (selected) next.delete(labelId);
        else next.add(labelId);
        return next;
      }),
    remove: () => execute({ labelIds: selectedIds }),
  };
}

function formatEmailCount(count: number) {
  return count === 1 ? "1 email" : `${count.toLocaleString()} emails`;
}

function isAccountKey(key: unknown, prefix: string, emailAccountId: string) {
  if (typeof key === "string") return key.startsWith(prefix);
  return (
    Array.isArray(key) &&
    typeof key[0] === "string" &&
    key[0].startsWith(prefix) &&
    (key[1] === undefined || key[1] === emailAccountId)
  );
}

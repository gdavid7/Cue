"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import useSWR from "swr";
import { FileTextIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import {
  PERSON_CARD_CONVERSATION_LIMIT,
  type PersonCard as PersonCardData,
  type PersonCardConversation,
  type PersonCardQuery,
  type ReplyLag,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { AttachmentPreviewDialogContent } from "@/components/email-list/EmailAttachments";
import { LoadingContent } from "@/components/LoadingContent";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SystemType } from "@/generated/prisma/enums";
import { useIsMobile } from "@/hooks/use-mobile";
import { MAIL_SHORTCUTS_OFF_ATTRIBUTE } from "@/lib/shortcuts/registry";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import type { EmailLabels } from "@/providers/email-label-types";
import { cn } from "@/utils";
import { getAttachmentUrl } from "@/utils/attachments/download";
import { formatShortDate } from "@/utils/date";
import { getInitials, isSameEmailAddress } from "@/utils/email";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import { getRuleLabel } from "@/utils/rule/consts";

const SENDER_ATTRIBUTE = "data-person-card-sender";

type PersonCardScopeValue = {
  /** The open thread's account, or every account All inboxes includes. */
  accountIds: string[];
  ownAddresses: string[];
  replyTracking: PersonCardQuery["replyTracking"];
  /** The conversation being read, which the card doesn't list again. */
  openConversation: { accountId: string; conversationId: string } | null;
  onOpenConversation: (accountId: string, conversationId: string) => void;
  onSearch?: (query: string) => void;
};

type PersonFile = PersonCardData["files"][number];

const PersonCardScopeContext = createContext<PersonCardScopeValue | null>(null);

/** Where person cards read from and what their links open. */
export function PersonCardScope({
  value,
  children,
}: {
  value: PersonCardScopeValue;
  children: ReactNode;
}) {
  return (
    <PersonCardScopeContext.Provider value={value}>
      {children}
    </PersonCardScopeContext.Provider>
  );
}

/**
 * Opens the card of the open conversation's selected message's sender, or
 * of the newest open message's when none is selected, as the `i` shortcut
 * does. A conversation still loading out of sight is passed over.
 */
export function openSenderPersonCard() {
  const triggers = [
    ...document.querySelectorAll<HTMLElement>(
      `li[data-thread-message-id] [${SENDER_ATTRIBUTE}]`,
    ),
  ].filter((trigger) => !trigger.closest("[inert]"));
  const selected = triggers.find((trigger) =>
    trigger.closest('li[aria-current="true"]'),
  );
  (selected ?? triggers.at(-1))?.click();
}

/** The labels Cue's reply tracking puts on an account's conversations. */
export function getReplyTrackingLabels(
  accountId: string,
  labels: EmailLabels,
): PersonCardQuery["replyTracking"][number] {
  const idOf = (type: SystemType) =>
    Object.values(labels).find((label) => label.name === getRuleLabel(type))
      ?.id || null;
  return {
    accountId,
    toReplyLabelId: idOf(SystemType.TO_REPLY),
    awaitingReplyLabelId: idOf(SystemType.AWAITING_REPLY),
  };
}

/**
 * Makes a name or avatar open what you have going on with that person: a
 * popover beside it, or a sheet on a phone. Outside a reader, or for the
 * user's own address, it renders its children as they are.
 */
export function PersonCardTrigger({
  email,
  name,
  className,
  sender = false,
  children,
}: {
  email: string;
  name: string;
  className?: string;
  /** The message's sender, which the reader's `i` shortcut opens. */
  sender?: boolean;
  children: ReactNode;
}) {
  const scope = useContext(PersonCardScopeContext);
  if (
    !scope ||
    !email ||
    scope.ownAddresses.some((own) => isSameEmailAddress(own, email))
  )
    return <span className={className}>{children}</span>;
  return (
    <PersonCardPopover
      className={className}
      email={email}
      name={name}
      scope={scope}
      sender={sender}
    >
      {children}
    </PersonCardPopover>
  );
}

function PersonCardPopover({
  email,
  name,
  className,
  sender,
  scope,
  children,
}: {
  email: string;
  name: string;
  className?: string;
  sender: boolean;
  scope: PersonCardScopeValue;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState<PersonFile>();
  const displayName = name || email;
  const trigger = (
    <button
      aria-haspopup="dialog"
      className={cn(
        "rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      type="button"
      {...(sender ? { [SENDER_ATTRIBUTE]: "" } : {})}
    >
      {children}
    </button>
  );
  const body = open ? (
    <PersonCardBody
      email={email}
      name={name}
      onClose={() => setOpen(false)}
      onPreview={(file) => {
        setOpen(false);
        setPreviewing(file);
      }}
      scope={scope}
    />
  ) : null;

  return (
    <>
      {isMobile ? (
        <Sheet onOpenChange={setOpen} open={open}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent
            className="max-h-[85dvh] overflow-y-auto rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)]"
            {...{ [MAIL_SHORTCUTS_OFF_ATTRIBUTE]: "" }}
            side="bottom"
            size={null}
          >
            <SheetTitle className="sr-only">{displayName}</SheetTitle>
            <SheetDescription className="sr-only">{email}</SheetDescription>
            {body}
          </SheetContent>
        </Sheet>
      ) : (
        <Popover modal onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={displayName}
            className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[22rem] overflow-y-auto p-0 motion-reduce:animate-none"
            collisionPadding={16}
            data-testid="person-card"
            {...{ [MAIL_SHORTCUTS_OFF_ATTRIBUTE]: "" }}
          >
            {body}
          </PopoverContent>
        </Popover>
      )}
      <Dialog
        onOpenChange={(next) => !next && setPreviewing(undefined)}
        open={Boolean(previewing)}
      >
        {previewing ? (
          <AttachmentPreviewDialogContent
            emailAccountId={previewing.accountId}
            filename={previewing.attachment.filename}
            key={`${previewing.accountId}:${previewing.messageId}:${previewing.attachment.attachmentId}`}
            size={previewing.attachment.size}
            url={getAttachmentUrl({
              accountId: previewing.accountId,
              messageId: previewing.messageId,
              attachmentId: previewing.attachment.attachmentId,
            })}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function PersonCardBody({
  email,
  name,
  scope,
  onClose,
  onPreview,
}: {
  email: string;
  name: string;
  scope: PersonCardScopeValue;
  onClose: () => void;
  onPreview: (file: PersonFile) => void;
}) {
  const client = useOptionalMailClient() ?? getActiveMailClient();
  const { composeTo } = useComposeModal();
  const query = useMemo<PersonCardQuery>(
    () => ({
      accountIds: scope.accountIds,
      email,
      ownAddresses: scope.ownAddresses,
      replyTracking: scope.replyTracking,
    }),
    [email, scope.accountIds, scope.ownAddresses, scope.replyTracking],
  );
  const readCard = client?.queryPersonCard?.bind(client);
  // Read from this device's mail store only: opening a card never asks
  // Gmail or Outlook for anything.
  const { data, error, isLoading } = useSWR(
    readCard ? ["person-card", JSON.stringify(query)] : null,
    () => (readCard as NonNullable<typeof readCard>)(query),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const open = scope.openConversation;
  const notOpen = (conversation: PersonCardConversation) =>
    !open ||
    conversation.accountId !== open.accountId ||
    conversation.conversationId !== open.conversationId;
  const openConversation = (conversation: PersonCardConversation) => {
    onClose();
    scope.onOpenConversation(
      conversation.accountId,
      conversation.conversationId,
    );
  };
  const displayName = data?.name || name || email;

  return (
    <div className="flex flex-col text-sm">
      {/* Clear of the sheet's close button on phones. */}
      <header className="flex items-start gap-3 px-4 pt-4 pr-12 pb-3 md:pr-4">
        <Avatar aria-hidden className="size-10 shrink-0 border border-border">
          <AvatarFallback className="font-medium text-sm">
            {getInitials(displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-base text-foreground">
            {displayName}
          </h2>
          <p className="truncate text-muted-foreground">{email}</p>
          {data?.otherAddresses.map((address) => (
            <p className="truncate text-muted-foreground text-xs" key={address}>
              Also {address}
            </p>
          ))}
        </div>
      </header>
      <div className="flex gap-2 px-4 pb-3">
        <Button
          className="min-w-0 flex-1"
          onClick={() => {
            onClose();
            composeTo(email);
          }}
          size="sm"
          variant="outline"
        >
          <SquarePenIcon aria-hidden className="mr-1.5 size-3.5" />
          New message
        </Button>
        {scope.onSearch ? (
          <Button
            className="min-w-0 flex-1"
            onClick={() => {
              onClose();
              scope.onSearch?.(`from:${email}`);
            }}
            size="sm"
            variant="outline"
          >
            <SearchIcon aria-hidden className="mr-1.5 size-3.5" />
            Mail from them
          </Button>
        ) : null}
      </div>
      {readCard && !isUnsupported(error) ? (
        <LoadingContent
          error={error}
          errorComponent={
            <Note>Couldn&apos;t read your mail with them on this device.</Note>
          }
          loading={isLoading}
          loadingComponent={<PersonCardSkeleton />}
        >
          {data ? (
            <PersonCardDetails
              data={data}
              notOpen={notOpen}
              onOpenConversation={openConversation}
              onPreview={onPreview}
            />
          ) : null}
        </LoadingContent>
      ) : (
        <Note>Your mail history with them isn&apos;t available here.</Note>
      )}
    </div>
  );
}

function PersonCardDetails({
  data,
  notOpen,
  onOpenConversation,
  onPreview,
}: {
  data: PersonCardData;
  notOpen: (conversation: PersonCardConversation) => boolean;
  onOpenConversation: (conversation: PersonCardConversation) => void;
  onPreview: (file: PersonFile) => void;
}) {
  const conversations = data.conversations
    .filter(notOpen)
    .slice(0, PERSON_CARD_CONVERSATION_LIMIT - 1);
  const awaitingYou = data.awaitingYou.filter(notOpen);
  const awaitingThem = data.awaitingThem.filter(notOpen);
  const { theirs, yours } = data.replyLag;

  return (
    <>
      {awaitingYou.length > 0 ? (
        <ConversationSection
          conversations={awaitingYou}
          heading="Waiting on you"
          onOpen={onOpenConversation}
        />
      ) : null}
      {awaitingThem.length > 0 ? (
        <ConversationSection
          conversations={awaitingThem}
          heading="Waiting on them"
          onOpen={onOpenConversation}
        />
      ) : null}
      {conversations.length > 0 ? (
        <ConversationSection
          conversations={conversations}
          heading="Recent conversations"
          onOpen={onOpenConversation}
        />
      ) : data.automated ? null : (
        <Note>No other conversations with them yet.</Note>
      )}
      {data.files.length > 0 ? (
        <Section heading="Files they shared">
          <ul>
            {data.files.map((file) => (
              <li
                key={`${file.accountId}:${file.messageId}:${file.attachment.attachmentId}`}
              >
                <Row
                  label={`Preview ${file.attachment.filename}`}
                  meta={formatShortDate(new Date(file.receivedAtMs))}
                  onClick={() => onPreview(file)}
                >
                  <FileTextIcon
                    aria-hidden
                    className="mr-2 size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">{file.attachment.filename}</span>
                </Row>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {theirs || yours ? (
        <Section heading="Usual reply time">
          <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 px-4 pb-1">
            {theirs ? <LagRow label="They reply in" lag={theirs} /> : null}
            {yours ? <LagRow label="You reply in" lag={yours} /> : null}
          </dl>
        </Section>
      ) : null}
      {data.history.syncing ? (
        <Note>Still syncing older mail</Note>
      ) : data.history.sinceMs ? (
        <Note>
          From mail since{" "}
          {new Date(data.history.sinceMs).toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
          })}
        </Note>
      ) : null}
    </>
  );
}

function ConversationSection({
  heading,
  conversations,
  onOpen,
}: {
  heading: string;
  conversations: PersonCardConversation[];
  onOpen: (conversation: PersonCardConversation) => void;
}) {
  return (
    <Section heading={heading}>
      <ul>
        {conversations.map((conversation) => (
          <li key={`${conversation.accountId}:${conversation.conversationId}`}>
            <Row
              meta={formatShortDate(new Date(conversation.latestMessageAtMs))}
              onClick={() => onOpen(conversation)}
            >
              <span className="truncate">
                {conversation.subject || "(no subject)"}
              </span>
            </Row>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border border-t py-2">
      <h3 className="px-4 pt-1 pb-1 font-medium text-muted-foreground text-xs">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  meta,
  onClick,
  children,
}: {
  label?: string;
  meta: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="flex w-full min-w-0 items-center gap-3 px-4 py-1.5 text-left text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted active:bg-muted"
      onClick={onClick}
      type="button"
    >
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {meta}
      </span>
    </button>
  );
}

function LagRow({ label, lag }: { label: string; lag: ReplyLag }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground tabular-nums">
        {formatLag(lag.medianMs)}
      </dd>
      <dd className="text-right text-muted-foreground text-xs tabular-nums">
        {lag.exchanges} replies
      </dd>
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="border-border border-t px-4 py-3 text-muted-foreground text-xs">
      {children}
    </p>
  );
}

function PersonCardSkeleton() {
  return (
    <div className="space-y-2 border-border border-t px-4 py-3" role="status">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  );
}

// A tab that relays to another tab's engine can reach one too old to answer.
function isUnsupported(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith("unsupported method")
  );
}

function formatLag(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

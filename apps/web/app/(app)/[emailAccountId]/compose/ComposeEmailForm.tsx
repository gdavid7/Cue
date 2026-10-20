"use client";

import { completeRumAction } from "@/utils/analytics/rum-actions";
import {
  type EmailAttachmentMetadata,
  EMAIL_INLINE_IMAGE_MIME_TYPES,
  combineEmailHtml,
  detectInlineImageMimeType,
  finalizeEditableEmailHtml,
  formatAttachmentSize,
  prepareEmailDraft,
} from "@inboxzero/email-editor/core";
import {
  EmailEditor,
  type EmailEditorHandle,
  type EmailEditorState,
} from "@inboxzero/email-editor/web";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ImageIcon,
  Loader2Icon,
  PaperclipIcon,
  PictureInPicture2Icon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { type SubmitHandler, useForm } from "react-hook-form";
import useSWR, { useSWRConfig } from "swr";
import type { ScopedMutator } from "swr";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import type { GetSignatureResponse } from "@/app/api/user/signature/route";
import { ComposeContactRecipientField } from "./ComposeContactRecipientField";
import { Input } from "@/components/Input";
import { ButtonLoader } from "@/components/Loading";
import { LoadingContent } from "@/components/LoadingContent";
import { Tooltip } from "@/components/Tooltip";
import { threadScheduledEmailsKey } from "@/components/email-list/ThreadDeliveryStatus";
import {
  isUneditedSuggestion,
  withSuggestionEscapesRepaired,
} from "@/components/email-list/reply-assist";
import { useFirstSuggestedReplySent } from "@/app/(app)/[emailAccountId]/compose/use-first-suggested-reply-sent";
import {
  hideSendingDraftMessages,
  upcomingScheduledEmailsKey,
} from "@/hooks/useHiddenDraftMessageIds";
import { forgetDeletedDrafts } from "@/utils/mail-engine/forget-deleted-drafts";
import { VoiceInput } from "@/components/voice/VoiceInput";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  holdSessionExpiredRedirect,
  SESSION_EXPIRED_MESSAGE,
} from "@/utils/session-expired";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { env } from "@/env";
import { getAccountScopedKey } from "@/utils/swr";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useLocalReplyDraft } from "@/hooks/useLocalReplyDraft";
import {
  DraftAutosaveHaltedError,
  useProviderDraftAutosave,
} from "@/hooks/useProviderDraftAutosave";
import {
  MailCoverageGate,
  useMailEngineDemand,
} from "@/utils/mail-engine/MailEngineHost";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import { useReplyDraftPersistence } from "@/hooks/useReplyDraftPersistence";
import {
  MAIL_SHORTCUT_SCOPES,
  TYPING_SURFACE_ATTRIBUTE,
} from "@/lib/shortcuts/registry";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useOwnEmailAddresses } from "@/hooks/useOwnEmailAddresses";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import {
  updateDraftAction,
  saveComposeDraftAction,
  discardComposeDraftAction,
} from "@/utils/actions/mail";
import { scheduleEmailAction } from "@/utils/actions/scheduled-email";
import {
  recordReplySuggestionStageAction,
  recordSuggestedReplyDraftAction,
} from "@/utils/actions/thread-assist";
import { formatRecipientNames, splitRecipientList } from "@/utils/email";
import type {
  ReplySuggestionOrigin,
  StoredReplyDraft,
} from "@/utils/mail-engine/reply-drafts";
import {
  getDraftSessionMessageIds,
  forgetReplyDraftProvider,
  getReplyDraft,
  updateReplyDraftProviderState,
  type ReplyDraftContent,
  type ReplyDraftIdentity,
  type ReplyDraftMode,
} from "@/utils/mail-engine/reply-drafts";
import { createPreservedEmailBlocks } from "@/utils/email/preserved-blocks";
import { resolveSendDraftId } from "@/app/(app)/[emailAccountId]/compose/send-draft-reference";
import { followProviderDraftMessage } from "@/app/(app)/[emailAccountId]/compose/follow-provider-draft-message";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { stripBrandingSignatures } from "@/utils/referral/signature";
import {
  getActionErrorMessage,
  UNEXPECTED_ACTION_ERROR_MESSAGE,
} from "@/utils/error";
import { redirectToSafeUrl } from "@/utils/redirect";
import {
  type SendEmailBody,
  validateSendEmailPayloadSize,
} from "@/utils/types/mail";
import { randomUuid } from "@/utils/uuid";
import type { DraftAttachment } from "@/utils/email/types";
import { cn } from "@/utils";
import {
  type ComposeRecipientField,
  resolveComposeRecipientFields,
} from "./compose-recipients";
import { DeliveryOptions, type DeliveryOptionsHandle } from "./DeliveryOptions";
import { resolveRemoteImages } from "./resolve-remote-images";
import { useComposeAssist } from "./useComposeAssist";
import { useComposeSnippets } from "./useComposeSnippets";
import {
  getReminderAfterSendTimeChange,
  parseDeliveryTimes,
} from "./delivery-times";
import {
  queueReaderEmail,
  READER_EMAIL_SETTLEMENT_TIMEOUT_MS,
  waitForReaderEmailSettlement,
} from "./queued-reply";
import { beginUndoSend, UNDO_SEND_DELAY_MS } from "./undo-send";
import { getReplyToEmailPayload } from "./reply-to-email-payload";
import {
  enqueueDraftOperation,
  waitForDraftOperations,
} from "./draft-operation-queue";
import {
  forgetAttachedFiles,
  readDraftAttachmentFiles,
  removeDraftAttachment,
  resolveDraftId,
  uploadDraftAttachment,
} from "./upload-draft-attachment";
import { useComposeDraftAttachments } from "./useComposeDraftAttachments";
import {
  type ComposeAttachment,
  getEditorInlineAttachments,
  describeUnattachedFiles,
  fitComposeAttachments,
  getGmailAttachmentDraftSaveIntervalMs,
  mergeDraftAttachments,
  routeComposeFiles,
  toAttachmentMetadata,
  toAttachmentReference,
} from "./compose-attachments";
import { useFileDropTarget } from "./useFileDropTarget";
import { getAttachmentTotalLimitBytes } from "@/utils/email/draft-attachment-upload";
import {
  finishComposeDraftMove,
  getMoveErrorMessage,
  type MovedFromDraft,
} from "./move-compose-draft";

export type ReplyingToEmail = {
  threadId?: string;
  headerMessageId?: string;
  messageId?: string;
  forwardedMessageId?: string;
  /**
   * The files that travel with a forward. They stay on the provider until the
   * send, so the composer shows them without ever holding their bytes.
   */
  /** An opened mailbox draft that already holds files. */
  draftHasAttachments?: boolean;
  forwardedAttachments?: Pick<
    EmailAttachmentMetadata,
    "id" | "filename" | "mimeType" | "size"
  >[];
  references?: string;
  subject: string;
  to: string;
  cc?: string;
  bcc?: string;
  draftHtml?: string;
  quotedContentHtml?: string;
  signatureHtml?: string;
  date?: string;
};

type ComposeEmailFormProps = {
  fromAccounts?: GetEmailAccountsResponse["emailAccounts"];
  layout?: "default" | "window";
  providerDraftMessageId?: string;
  draftKeyMessageId?: string;
  draftMode?: ReplyDraftMode;
  draftSessionId?: string;
  replyingToEmail?: ReplyingToEmail;
  refetch?: () => void;
  onSuccess?: (messageId: string, threadId: string) => void;
  onMarkDone?: () => void;
  onClose?: () => void;
  onRestore?: () => void;
  onDiscard?: (draftId?: string) => boolean | Promise<boolean>;
  onPopOut?: () => void;
  /**
   * Text to start from when there is no saved draft, such as a reply Cue
   * suggested. It is saved as a draft right away, like anything typed, except
   * Cue's suggestion: that stays in Cue until the user changes it.
   */
  initialBodyHtml?: string;
  /**
   * Cue's verified reply to the message, when this composer may hold it.
   * While the body is still exactly that text, the reply reads as ready and
   * credits Cue, with what backs it.
   */
  suggestion?: {
    reply: string;
    evidence?: ReactNode;
    /** Set when the suggestion is a rule's, waiting in Cue. */
    executedActionId?: string;
    /** Names of the rule's files, which go on the draft or the send with it. */
    files?: string[];
    /** Credit shown instead of "Suggested by Cue". */
    label?: string;
  };
  /**
   * Whether the composer takes focus when it opens. Off for one that opens on
   * its own, so keys meant as shortcuts aren't typed into it.
   */
  autoFocus?: boolean;
};

type ComposeFormValues = Omit<SendEmailBody, "attachments" | "messageHtml">;

type MoveToFinish = { from: MovedFromDraft; filesMoved: boolean };

/** What a new message keeps when its From account changes mid-draft. */
type MovedComposeDraft = {
  values: ComposeFormValues;
  editableHtml: string;
  mode: ReplyDraftContent["draft"]["mode"];
  files: { attachment: ComposeAttachment; file: Blob }[];
  /** Removed only once the new account holds the message. */
  from: MovedFromDraft;
};

export function ComposeEmailForm(props: ComposeEmailFormProps) {
  useMailEngineDemand();
  return (
    <MailCoverageGate>
      <ComposeEmailFormWithEngine {...props} />
    </MailCoverageGate>
  );
}

function ComposeEmailFormWithEngine(props: ComposeEmailFormProps) {
  const { emailAccountId, provider } = useAccount();
  const [selectedEmailAccountId, setSelectedEmailAccountId] =
    useState(emailAccountId);
  const [movedDraft, setMovedDraft] = useState<MovedComposeDraft>();
  const selectedAccountOverride =
    selectedEmailAccountId === emailAccountId
      ? undefined
      : selectedEmailAccountId;
  const {
    data: emailAccount,
    error,
    isLoading,
  } = useEmailAccountFull(selectedAccountOverride);
  // An account that can't load sends a moved draft back where it came from,
  // whose drafts are untouched until the move completes.
  useEffect(() => {
    if (!error || !movedDraft) return;
    toastError({ description: error.error });
    setMovedDraft(undefined);
    setSelectedEmailAccountId(movedDraft.from.emailAccountId);
  }, [error, movedDraft]);
  const selectedAccountProvider =
    props.fromAccounts?.find((account) => account.id === selectedEmailAccountId)
      ?.account.provider ?? provider;
  // A failed lookup still lets the user compose, just without a signature.
  const { data: composeSignature, isLoading: isLoadingSignature } =
    useSWR<GetSignatureResponse>(
      getAccountScopedKey("/api/user/signature", selectedEmailAccountId),
    );

  const localDraftIdentity = props.draftSessionId
    ? {
        emailAccountId: selectedEmailAccountId,
        threadId: props.replyingToEmail?.threadId ?? props.draftSessionId,
        messageId: props.draftSessionId,
      }
    : undefined;

  const localDraft = useLocalReplyDraft(
    localDraftIdentity,
    !props.providerDraftMessageId &&
      props.draftKeyMessageId &&
      props.replyingToEmail?.threadId
      ? {
          emailAccountId: selectedEmailAccountId,
          threadId: props.replyingToEmail.threadId,
          messageId: props.draftKeyMessageId,
        }
      : undefined,
    props.draftMode,
  );
  const composeSessionKey = `${selectedEmailAccountId}:${props.replyingToEmail?.threadId ?? ""}:${props.draftSessionId ?? ""}`;
  const draftAttachments = useComposeDraftAttachments({
    emailAccountId: selectedEmailAccountId,
    sessionKey: composeSessionKey,
    storedDraft: localDraft.draft,
    loadMailboxDraft: Boolean(
      props.providerDraftMessageId &&
        props.replyingToEmail?.draftHasAttachments,
    ),
    providerDraftMessageId: props.providerDraftMessageId,
    enabled: !localDraft.isLoading,
  });
  return (
    <LoadingContent
      error={error}
      loading={
        isLoading ||
        localDraft.isLoading ||
        draftAttachments.isLoading ||
        isLoadingSignature
      }
    >
      {emailAccount && (
        <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
          <ComposeEmailFormContent
            {...props}
            localDraftIdentity={localDraftIdentity}
            storedDraft={localDraft.draft}
            initialAttachments={draftAttachments.attachments}
            initialProviderDraftId={draftAttachments.draftId}
            initialDraftMissing={draftAttachments.draftMissing}
            draftLoadError={localDraft.error}
            accountProvider={selectedAccountProvider}
            accountSignatureHtml={composeSignature?.signatureHtml ?? ""}
            sendingAddress={emailAccount.email}
            sentWithFooterHtml={composeSignature?.footerHtml ?? ""}
            key={composeSessionKey}
            movedDraft={movedDraft}
            onMovedDraftApplied={() => setMovedDraft(undefined)}
            onSelectEmailAccount={(nextEmailAccountId, moved) => {
              setMovedDraft(moved);
              setSelectedEmailAccountId(nextEmailAccountId);
            }}
            selectedEmailAccountId={selectedEmailAccountId}
          />
        </ShortcutsProvider>
      )}
    </LoadingContent>
  );
}

function ComposeEmailFormContent({
  layout = "default",
  draftKeyMessageId,
  providerDraftMessageId,
  draftMode,
  storedDraft: savedDraft,
  movedDraft,
  onMovedDraftApplied,
  draftLoadError,
  replyingToEmail,
  fromAccounts,
  accountProvider,
  accountSignatureHtml,
  sendingAddress,
  sentWithFooterHtml,
  selectedEmailAccountId,
  onSelectEmailAccount,
  refetch,
  onSuccess,
  onMarkDone,
  onClose,
  onRestore,
  onDiscard,
  onPopOut,
  localDraftIdentity,
  initialAttachments,
  initialProviderDraftId,
  initialDraftMissing,
  initialBodyHtml,
  suggestion,
  autoFocus = true,
}: ComposeEmailFormProps & {
  localDraftIdentity?: ReplyDraftIdentity;
  storedDraft?: StoredReplyDraft;
  movedDraft?: MovedComposeDraft;
  onMovedDraftApplied: () => void;
  initialAttachments: ComposeAttachment[];
  initialProviderDraftId?: string;
  initialDraftMissing: boolean;
  draftLoadError?: Error;
  accountProvider: string;
  accountSignatureHtml: string;
  sendingAddress: string;
  sentWithFooterHtml: string;
  selectedEmailAccountId: string;
  onSelectEmailAccount: (
    emailAccountId: string,
    movedDraft: MovedComposeDraft,
  ) => void;
}) {
  // A draft moved here from another account starts from what it carried.
  const [isMovedDraft] = useState(Boolean(movedDraft));
  const storedDraft = useMemo(
    () =>
      isMovedDraft || !savedDraft
        ? undefined
        : withSuggestionEscapesRepaired(savedDraft),
    [isMovedDraft, savedDraft],
  );
  const ownEmails = useOwnEmailAddresses();
  const isComposeWindow = layout === "window";
  const isInlineReply = Boolean(draftKeyMessageId && replyingToEmail?.threadId);
  const canScheduleDelivery = isInlineReply || isComposeWindow;
  const isNewCompose = !replyingToEmail && !providerDraftMessageId;
  const { mutate } = useSWRConfig();
  const client = useOptionalMailClient() ?? getActiveMailClient();
  const [sendAt, setSendAt] = useState(storedDraft?.content?.sendAt ?? "");
  const [remindAt, setRemindAt] = useState(
    storedDraft?.content?.remindAt ?? "",
  );
  const [requestId] = useState(
    () => storedDraft?.content?.requestId ?? randomUuid(),
  );
  const deliveryPath = useRef(storedDraft?.content?.deliveryPath);
  const [submissionError, setSubmissionError] = useState(() => {
    const times = parseDeliveryTimes(sendAt, remindAt);
    return times.valid ? "" : times.error;
  });
  const editorInitialized = useRef(false);
  const providerDraftId = useRef(
    initialDraftMissing || isMovedDraft
      ? undefined
      : (storedDraft?.content?.providerDraftId ?? initialProviderDraftId),
  );
  const draftQueueKey = `${selectedEmailAccountId}:${requestId}`;

  const [initialComposer] = useState(() => {
    // Copied because restoring marks the inline images the editor shows.
    const restoredAttachments = movedDraft
      ? movedDraft.files.map(({ attachment }) => attachment)
      : initialAttachments.map((attachment) => ({
          ...attachment,
        }));
    if (storedDraft?.content) {
      const { draft, preservedBlocks } = storedDraft.content;
      const parsedDraft = new DOMParser().parseFromString(
        draft.editableHtml,
        "text/html",
      );
      // HTML still in its original form is sent exactly as loaded, so its
      // cid: images must not be swapped for local previews.
      const images =
        draft.mode === "edited"
          ? parsedDraft.querySelectorAll(
              'img[data-content-id], img[src^="cid:"]',
            )
          : [];
      for (const image of images) {
        const contentId =
          image.getAttribute("data-content-id") ??
          image.getAttribute("src")?.slice(4);
        const attachment = restoredAttachments.find(
          (item) => item.contentId === contentId,
        );
        if (attachment && contentId) {
          // Without a preview the image still goes out as its attachment.
          image.setAttribute(
            "src",
            attachment.previewUrl ?? `cid:${contentId}`,
          );
          image.setAttribute("data-content-id", contentId);
          attachment.managed = true;
        }
      }
      return {
        draft: {
          ...draft,
          editableHtml: sentWithFooterHtml
            ? stripBrandingOutsideSignature(parsedDraft.body)
            : parsedDraft.body.innerHTML,
        },
        preservedBlocks,
        attachments: restoredAttachments,
      };
    }

    const prepared = prepareEmailDraft({
      html: movedDraft
        ? ""
        : (initialBodyHtml ?? replyingToEmail?.draftHtml ?? ""),
      quotedHtml: replyingToEmail?.quotedContentHtml,
      signatureHtml:
        replyingToEmail?.signatureHtml ?? accountSignatureHtml ?? undefined,
    });
    // The text moves as written; only the signature is the new account's.
    const preparedDraft = movedDraft
      ? {
          ...prepared,
          editableHtml: movedDraft.editableHtml,
          mode: movedDraft.mode,
        }
      : prepared;
    // The footer travels with the signature so it lands right after it and is
    // removed with it, without introducing another block in the composer. A
    // reopened draft's signature may already carry a footer; it is replaced.
    const draft = {
      ...preparedDraft,
      editableHtml: sentWithFooterHtml
        ? stripBrandingSignatures(preparedDraft.editableHtml)
        : preparedDraft.editableHtml,
      signatureHtml: [
        stripBrandingSignatures(preparedDraft.signatureHtml),
        sentWithFooterHtml,
      ]
        .filter(Boolean)
        .join("<br>"),
    };
    const preservedBlocks = createPreservedEmailBlocks(draft);
    return { draft, preservedBlocks, attachments: restoredAttachments };
  });
  const { draft: initialDraft, preservedBlocks } = initialComposer;
  const [activeRecipientField, setActiveRecipientField] =
    useState<ComposeRecipientField>("to");
  const pendingRecipientsRef = useRef<Record<ComposeRecipientField, string>>({
    to: "",
    cc: "",
    bcc: "",
  });
  const [contactsReconnectRequired, setContactsReconnectRequired] =
    useState(false);
  const [isReconnectingContacts, setIsReconnectingContacts] = useState(false);
  const [editReply, setEditReply] = useState(false);
  // Forwards start without a recipient, so focus To. Replies already have one.
  const focusRecipientField = draftMode === "forward" || !replyingToEmail;
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(
    initialComposer.attachments,
  );
  // Set once a reply or forward has put files on a mailbox draft. A forward's
  // draft then holds the forwarded files and lists them with the others.
  const [savedToMailbox, setSavedToMailbox] = useState(
    Boolean(providerDraftId.current),
  );
  const forwardedAttachments = savedToMailbox
    ? []
    : (replyingToEmail?.forwardedAttachments ?? []);
  const attachmentLimitBytes = getAttachmentTotalLimitBytes(accountProvider);
  // Failed files aren't on the draft, so they don't count toward the limit.
  const attachmentTotalBytes = [
    ...forwardedAttachments,
    ...attachments.filter((attachment) => attachment.status !== "failed"),
  ].reduce((total, attachment) => total + attachment.size, 0);
  const attachmentsRef = useRef<ComposeAttachment[]>(
    initialComposer.attachments,
  );
  const isMountedRef = useRef(true);
  const editorRef = useRef<EmailEditorHandle>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inlineReplySummaryButtonRef = useRef<HTMLButtonElement>(null);
  const collapseInlineReplyFieldsButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const inlineImageInputRef = useRef<HTMLInputElement>(null);
  const sendAndMarkDoneButtonRef = useRef<HTMLButtonElement>(null);
  const deliveryOptionsRef = useRef<DeliveryOptionsHandle>(null);
  const shortcutOwnerId = useId();
  const {
    register,
    getValues,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
    setValue,
  } = useForm<ComposeFormValues>({
    defaultValues: movedDraft?.values ??
      storedDraft?.content?.values ?? {
        replyToEmail: getReplyToEmailPayload(replyingToEmail),
        subject: replyingToEmail?.subject,
        to: replyingToEmail?.to,
        cc: replyingToEmail?.cc,
        bcc: replyingToEmail?.bcc,
      },
  });
  // Cc and Bcc rows stay out of the way until asked for or already filled.
  const [shownRecipientRows, setShownRecipientRows] = useState({
    cc: false,
    bcc: false,
  });
  const showRecipientRow = (field: "cc" | "bcc") => {
    flushSync(() =>
      setShownRecipientRows((shown) => ({ ...shown, [field]: true })),
    );
    formRef.current?.querySelector<HTMLElement>(`#${field}`)?.focus();
  };
  const isRecipientRowShown = (field: ComposeRecipientField) =>
    field === "to" ||
    shownRecipientRows[field] ||
    Boolean(watch(field)) ||
    activeRecipientField === field;
  const assist = useComposeAssist({
    editorRef,
    emailAccountId: selectedEmailAccountId,
    threadId: replyingToEmail?.threadId,
    getEnvelope: () => ({
      to: getValues("to") || undefined,
      subject: getValues("subject") || undefined,
    }),
    formRef,
  });
  const { isOpen: assistIsOpen, focus: focusAssist } = assist;
  const {
    onSlashKeyDown,
    onSlashTrigger,
    toolbar: snippetToolbar,
  } = useComposeSnippets({
    editorRef,
    onAskCue: assist.openPrompt,
    to: watch("to"),
  });

  const lastDraftContent = useRef<ReplyDraftContent | undefined>(undefined);
  const getDraftContent = (options?: {
    sendAt?: string;
    remindAt?: string;
  }): ReplyDraftContent | undefined => {
    if (!editorRef.current)
      return lastDraftContent.current
        ? {
            ...lastDraftContent.current,
            providerDraftId: providerDraftId.current,
            attachments: attachmentsRef.current.flatMap(toAttachmentReference),
          }
        : undefined;
    const value = editorRef.current.getValue();
    const values = { ...getValues() };
    for (const field of ["to", "cc", "bcc"] as const) {
      const pending = pendingRecipientsRef.current[field].trim();
      if (pending)
        values[field] = [values[field], pending].filter(Boolean).join(", ");
    }
    const content: ReplyDraftContent = {
      providerDraftId: providerDraftId.current,
      composeMode: draftMode,
      requestId,
      deliveryPath: deliveryPath.current,
      values,
      draft: {
        ...initialDraft,
        editableHtml: value.editableHtml,
        mode: value.mode,
      },
      preservedBlocks: preservedBlocks.filter((block) =>
        value.preservedBlockIds.includes(block.id),
      ),
      attachments: attachmentsRef.current.flatMap(toAttachmentReference),
      sendAt: options?.sendAt ?? sendAt,
      remindAt: options?.remindAt ?? remindAt,
      startedFrom: startedFrom.current,
    };
    lastDraftContent.current = content;
    return content;
  };
  const {
    capture: captureLocalDraft,
    clear: clearLocalDraft,
    flush: flushDraft,
    saveError: draftSaveError,
  } = useReplyDraftPersistence({
    identity: localDraftIdentity,
    initialRevision: savedDraft?.revision,
    loadError: draftLoadError,
    getContent: getDraftContent,
  });
  // Signing out mid-sentence would take the composer away, so an expired
  // session waits for the user. The draft is already kept on this device.
  useEffect(
    () =>
      holdSessionExpiredRedirect({
        beforeRedirect: flushDraft,
        prompt: (signIn) => {
          toastError({
            id: SESSION_EXPIRED_TOAST_ID,
            description: SESSION_EXPIRED_MESSAGE,
            duration: Number.POSITIVE_INFINITY,
            action: { label: "Sign in again", onClick: signIn },
          });
        },
      }),
    [flushDraft],
  );
  const getProviderDraftContent = () => {
    const content = getDraftContent();
    if (!content) return;
    const blocks = new Set(content.preservedBlocks.map((block) => block.id));
    return {
      subject: content.values.subject ?? "",
      to: content.values.to ?? "",
      cc: content.values.cc ?? "",
      bcc: content.values.bcc ?? "",
      messageHtml: combineEmailHtml({
        editableHtml: finalizeEditableEmailHtml({
          html: content.draft.editableHtml,
          inlineAttachments: getEditorInlineAttachments(attachmentsRef.current),
          mode: content.draft.mode,
        }),
        signatureHtml: blocks.has("signature")
          ? content.draft.signatureHtml
          : "",
        quotedHtml: blocks.has("quote") ? content.draft.quotedHtml : "",
      }),
    };
  };

  const [bodyHtml, setBodyHtml] = useState(initialDraft.editableHtml);
  const suggestedReply = suggestion?.reply;
  // Cue's suggestion this reply opened with, kept in the local draft: a
  // composer opened again (popped out, reloaded, or after the suggestion is
  // no longer offered) still knows the reply is Cue's untouched text.
  const startedFrom = useRef<ReplySuggestionOrigin | undefined>(
    storedDraft
      ? storedDraft.content?.startedFrom
      : suggestion && initialBodyHtml && !movedDraft
        ? {
            reply: suggestion.reply,
            executedActionId: suggestion.executedActionId,
            decoded: true,
            files: suggestion.files?.length ? suggestion.files : undefined,
            values: {
              to: replyingToEmail?.to ?? "",
              cc: replyingToEmail?.cc ?? "",
              bcc: replyingToEmail?.bcc ?? "",
              subject: replyingToEmail?.subject ?? "",
            },
          }
        : undefined,
  );
  // The draft funnel's "opened" stage: this composer opened with the rule's
  // suggestion, rather than with a draft it already left.
  const [openedRuleSuggestionId] = useState(() =>
    storedDraft ? undefined : startedFrom.current?.executedActionId,
  );
  useEffect(() => {
    if (!openedRuleSuggestionId) return;
    recordReplySuggestionStageAction(selectedEmailAccountId, {
      executedActionId: openedRuleSuggestionId,
      stage: "opened",
    }).catch(() => {
      // Only the funnel's count is lost.
    });
  }, [openedRuleSuggestionId, selectedEmailAccountId]);
  const isCueSuggestion = useMemo(
    () =>
      suggestedReply !== undefined &&
      isUneditedSuggestion(bodyHtml, suggestedReply),
    [bodyHtml, suggestedReply],
  );
  // Editing Cue's text keeps the credit, and the evidence, visible.
  const editedSuggestion =
    suggestedReply !== undefined &&
    Boolean(initialBodyHtml) &&
    !storedDraft &&
    !isCueSuggestion;
  const startedFromSuggestion = isCueSuggestion || editedSuggestion;
  const noteSuggestedReplySent = useFirstSuggestedReplySent(
    selectedEmailAccountId,
  );
  // A reply reads as a draft once the mailbox holds a copy of it.
  const [isMailboxDraft, setIsMailboxDraft] = useState(
    Boolean(providerDraftMessageId || providerDraftId.current),
  );
  const followDraftMessage = (messageId: string | null) => {
    setIsMailboxDraft(true);
    return followProviderDraftMessage({
      client,
      emailAccountId: selectedEmailAccountId,
      messageId,
      openedDraftMessageId: providerDraftMessageId,
      localDraft: localDraftIdentity && {
        identity: localDraftIdentity,
        requestId,
      },
    });
  };

  // Every compose with files needs a mailbox draft to hold them. New messages
  // also get one from autosave; replies and forwards get one on first attach.
  const ensureProviderDraft = async () => {
    if (providerDraftId.current) return providerDraftId.current;
    if (providerDraftMessageId) {
      const draftId = await resolveDraftId({
        emailAccountId: selectedEmailAccountId,
        messageId: providerDraftMessageId,
      });
      if (!draftId)
        throw new Error(
          "Could not find this draft in your mailbox. Reopen it and try again.",
        );
      providerDraftId.current = draftId;
      return draftId;
    }
    if (!localDraftIdentity)
      throw new Error("Local draft storage is required to save attachments.");
    const deletedDraftId = storedDraft?.content?.providerDraftId;
    if (initialDraftMissing && deletedDraftId)
      await forgetReplyDraftProvider(localDraftIdentity, deletedDraftId);
    captureLocalDraft();
    await flushDraft();
    let draftId = await updateReplyDraftProviderState(
      localDraftIdentity,
      requestId,
    );
    let createdMessageId: string | null = null;
    if (!draftId) {
      const content = getProviderDraftContent();
      if (!content) throw new Error("This draft is not ready to save yet.");
      const created = await saveComposeDraftAction(selectedEmailAccountId, {
        content: {
          ...content,
          replyToEmail: getReplyToEmailPayload(getValues("replyToEmail")),
        },
        ...(ruleFiles.length && startedFrom.current?.executedActionId
          ? {
              ruleSuggestionId: startedFrom.current.executedActionId,
              ruleSuggestionFiles: ruleFiles,
            }
          : {}),
      });
      if (created?.serverError) throw new Error(created.serverError);
      if (!created?.data)
        throw new Error(
          "Mailbox draft creation could not be confirmed. Check Drafts in Gmail or Outlook; your message is still saved on this device.",
        );
      draftId = created.data.draftId;
      createdMessageId = created.data.messageId;
      if ("attachments" in created.data && created.data.attachments?.length) {
        setSavedToMailbox(true);
        reconcileDraftAttachments(created.data.attachments);
      }
    }
    // Keep the reference durable if the composer closes during mailbox sync.
    providerDraftId.current = draftId;
    await updateReplyDraftProviderState(localDraftIdentity, requestId, draftId);
    if (createdMessageId) await followDraftMessage(createdMessageId);
    if (createdMessageId) rememberSuggestionDraft(draftId);
    return draftId;
  };
  // The draft an edited suggestion became, so sending it teaches reply
  // memories what the user changed. Only the first save, and only once: the
  // origin then leaves the local draft, as the mailbox draft now leads.
  const rememberSuggestionDraft = (draftId: string) => {
    const origin = startedFrom.current;
    const threadId = replyingToEmail?.threadId;
    const messageId = draftKeyMessageId ?? replyingToEmail?.messageId;
    startedFrom.current = undefined;
    if (!origin || !threadId || !messageId) return;
    recordSuggestedReplyDraftAction(selectedEmailAccountId, {
      threadId,
      messageId,
      draftId,
      ...(origin.executedActionId
        ? { executedActionId: origin.executedActionId }
        : { suggested: origin.reply }),
    }).catch(() => {
      // The draft is saved; only learning from its edits is lost.
    });
  };

  // A moved draft whose old copy couldn't go yet, because the new mailbox
  // hadn't saved it. The next save that lands finishes it, once.
  const unfinishedMove = useRef<MoveToFinish | undefined>(undefined);
  const completeMove = async (move: MoveToFinish) => {
    const result = await finishComposeDraftMove({
      from: move.from,
      newMailboxDraftId: providerDraftId.current,
      filesMoved: move.filesMoved,
    });
    if (result !== "moved") return false;
    toastSuccess({ description: `Draft moved to ${sendingAddress}` });
    await client?.requestSync([move.from.emailAccountId]);
    return true;
  };

  // Replies and forwards sync their text even before any files are attached.
  const providerAutosave = useProviderDraftAutosave({
    onSaved: () => {
      const move = unfinishedMove.current;
      if (!move) return;
      unfinishedMove.current = undefined;
      completeMove(move).catch((error: unknown) => {
        toastError({ description: getMoveErrorMessage(error) });
      });
    },
    enabled: Boolean(providerDraftMessageId) || Boolean(localDraftIdentity),
    sessionKey: providerDraftMessageId ? undefined : draftQueueKey,
    minIntervalMs: isGoogleProvider(accountProvider)
      ? getGmailAttachmentDraftSaveIntervalMs(attachmentTotalBytes)
      : 0,
    getContent: getProviderDraftContent,
    save: (content) =>
      enqueueDraftOperation(draftQueueKey, async () => {
        if (!providerDraftMessageId) {
          const draftId = await ensureProviderDraft();
          const result = await saveComposeDraftAction(selectedEmailAccountId, {
            draftId,
            content,
          });
          if (!result?.data) throw new Error(getDraftSyncErrorMessage(result));
          await followDraftMessage(result.data.messageId);
          return;
        }
        const result = await updateDraftAction(selectedEmailAccountId, {
          ...content,
          draftMessageId: providerDraftMessageId,
          draftId: providerDraftId.current,
        });
        if (!result?.data) throw new Error(getDraftSyncErrorMessage(result));
        if (result.data.status === "missing")
          throw new DraftAutosaveHaltedError(
            "This draft was sent, deleted, or changed elsewhere, so edits here are no longer saved to your mailbox.",
          );
        providerDraftId.current = result.data.draftId;
        captureLocalDraft();
        await flushDraft();
        await followDraftMessage(result.data.messageId);
      }),
  });
  const { stop: stopProviderAutosave, resume: resumeProviderAutosave } =
    providerAutosave;
  // Cue's suggestion stays in Cue until the user changes it: only then does
  // the reply become a mailbox draft. Sending it as it is needs no draft.
  // Until the reply is a mailbox draft, the rule's files are only named.
  const [ruleFiles, setRuleFiles] = useState<string[]>(
    () => startedFrom.current?.files ?? [],
  );
  // A rule's file the user doesn't want goes before the draft holds it.
  const removeRuleFile = (name: string) => {
    const next = ruleFiles.filter((file) => file !== name);
    setRuleFiles(next);
    if (startedFrom.current)
      startedFrom.current = {
        ...startedFrom.current,
        files: next.length ? next : undefined,
      };
    captureLocalDraft();
  };
  // A reply already in the mailbox keeps saving, even typed back to Cue's text.
  const isUntouchedSuggestion = useCallback(() => {
    const origin = startedFrom.current;
    if (!origin || providerDraftId.current || providerDraftMessageId)
      return false;
    if (attachmentsRef.current.length) return false;
    const bodyHtml =
      editorRef.current?.getValue().editableHtml ??
      storedDraft?.content?.draft.editableHtml ??
      initialBodyHtml ??
      "";
    if (!isUneditedSuggestion(bodyHtml, origin.reply)) return false;
    const values = getValues();
    return (["to", "cc", "bcc", "subject"] as const).every(
      (field) => (values[field] ?? "") === (origin.values?.[field] ?? ""),
    );
  }, [providerDraftMessageId, storedDraft, initialBodyHtml, getValues]);
  const captureDraft = useCallback(
    (options?: { sendAt?: string; remindAt?: string }) => {
      captureLocalDraft(options);
      if (!options && isUntouchedSuggestion()) return;
      providerAutosave.capture();
    },
    [captureLocalDraft, providerAutosave.capture, isUntouchedSuggestion],
  );
  useEffect(() => {
    if (storedDraft?.content) captureDraft();
  }, [storedDraft, captureDraft]);
  // Opened with text and no saved draft: that text is the draft, and must
  // reach the mailbox even if the user sends nothing else.
  const startedFromBody = useRef(Boolean(initialBodyHtml && !storedDraft));
  useEffect(() => {
    if (!startedFromBody.current) return;
    startedFromBody.current = false;
    captureDraft();
  }, [captureDraft]);
  // A moved draft is saved to its new account, files included, right away.
  const pendingMove = useRef(movedDraft);
  useEffect(() => {
    const subscription = watch(() => captureDraft());
    return () => subscription.unsubscribe();
  }, [captureDraft, watch]);

  const updateAttachments = useCallback(
    (next: ComposeAttachment[]) => {
      attachmentsRef.current = next;
      setAttachments(next);
      captureDraft();
    },
    [captureDraft],
  );

  // After each change the mailbox's list is the truth for files on the draft.
  // This keeps running after the composer closes, so the local draft still
  // records uploads that finish later.
  const reconcileDraftAttachments = (
    listed: DraftAttachment[],
    current = attachmentsRef.current,
  ) => updateAttachments(mergeDraftAttachments(current, listed));

  const uploadComposeAttachment = (file: Blob, attachment: ComposeAttachment) =>
    enqueueDraftOperation(draftQueueKey, async () => {
      const isAttached = () =>
        attachmentsRef.current.some((item) => item.id === attachment.id);
      if (!isAttached()) return;
      const draftId = await ensureProviderDraft();
      const result = await uploadDraftAttachment({
        emailAccountId: selectedEmailAccountId,
        draftId,
        file,
        attachment: toAttachmentMetadata(attachment),
      });
      await followDraftMessage(result.messageId);
      if (isAttached()) return result;
      // Removed while uploading: take it back off the draft.
      const removed = await removeDraftAttachment({
        emailAccountId: selectedEmailAccountId,
        draftId,
        attachmentId: result.attachmentId,
      });
      await followDraftMessage(removed.messageId);
    }).then(
      (result) => {
        if (!result) return;
        setSavedToMailbox(true);
        reconcileDraftAttachments(
          result.attachments,
          attachmentsRef.current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  status: "uploaded",
                  draftAttachmentId: result.attachmentId,
                }
              : item,
          ),
        );
      },
      (error: unknown) => {
        const description =
          error instanceof Error
            ? error.message
            : `Could not attach ${attachment.filename}.`;
        toastError({ description });
        updateAttachments(
          attachmentsRef.current.map((item) =>
            item.id === attachment.id
              ? { ...item, status: "failed", error: description }
              : item,
          ),
        );
      },
    );

  const detachAttachment = (attachment: ComposeAttachment) => {
    revokePreview(attachment);
    updateAttachments(
      attachmentsRef.current.filter(
        (candidate) => candidate.id !== attachment.id,
      ),
    );
    forgetAttachedFiles(selectedEmailAccountId, [attachment.id]);
    const draftId = providerDraftId.current;
    const { draftAttachmentId } = attachment;
    // Uploads still running take the file back off the draft when they end.
    if (attachment.status !== "uploaded" || !draftAttachmentId || !draftId)
      return;
    enqueueDraftOperation(draftQueueKey, () =>
      removeDraftAttachment({
        emailAccountId: selectedEmailAccountId,
        draftId,
        attachmentId: draftAttachmentId,
      }),
    ).then(
      async (result) => {
        await followDraftMessage(result.messageId);
        reconcileDraftAttachments(result.attachments);
      },
      (error: unknown) => {
        toastError({
          description:
            error instanceof Error
              ? error.message
              : `Could not remove ${attachment.filename}.`,
        });
        updateAttachments([
          ...attachmentsRef.current,
          { ...attachment, previewUrl: undefined, managed: false },
        ]);
      },
    );
  };

  const removeUnusedInlineAttachments = (contentIds: string[]) => {
    const referencedIds = new Set(contentIds);
    for (const attachment of attachmentsRef.current) {
      if (
        attachment.managed &&
        attachment.disposition === "inline" &&
        attachment.contentId &&
        !referencedIds.has(attachment.contentId)
      )
        detachAttachment(attachment);
    }
  };

  const handleEditorStateChange = (state: EmailEditorState) => {
    setBodyHtml(editorRef.current?.getValue().editableHtml ?? "");
    removeUnusedInlineAttachments(state.inlineContentIds);
    if (!editorInitialized.current) {
      completeRumAction("compose_open");
      queueMicrotask(() => {
        editorInitialized.current = true;
      });
      return;
    }
    captureDraft();
  };

  const addFiles = async ({
    inline = [],
    attachments: attached = [],
  }: {
    inline?: File[];
    attachments?: File[];
  }) => {
    if (isSubmitting) return;
    // A file named like an image that holds something else is attached as is.
    const inlineContent = await Promise.all(inline.map(isInlineImageContent));
    if (!isMountedRef.current) return;
    const created = [
      ...inline.map((file, index) => ({
        file,
        disposition: inlineContent[index]
          ? ("inline" as const)
          : ("attachment" as const),
      })),
      ...attached.map((file) => ({ file, disposition: "attachment" as const })),
    ].map(({ file, disposition }) => {
      const attachment: ComposeAttachment = {
        ...createComposeAttachmentMetadata(file, disposition),
        status: "uploading",
      };
      return { file, attachment };
    });
    if (!created.length) return;
    const fit = fitComposeAttachments({
      existing: [
        ...forwardedAttachments.map((attachment) => ({
          ...attachment,
          disposition: "attachment" as const,
        })),
        ...attachmentsRef.current.filter((item) => item.status !== "failed"),
      ],
      candidates: created.map(({ attachment }) => attachment),
      maxTotalBytes: attachmentLimitBytes,
    });
    if (fit.error)
      toastError({
        description: describeUnattachedFiles(fit.rejected, fit.error),
      });
    const fitting = created.filter(({ attachment }) =>
      fit.accepted.includes(attachment),
    );
    if (!fitting.length) return;

    const accepted = fitting.filter(({ file, attachment }) => {
      if (attachment.disposition !== "inline" || !attachment.contentId)
        return true;
      attachment.previewUrl = URL.createObjectURL(file);
      attachment.managed = true;
      const inserted = editorRef.current?.insertInlineImage({
        alt: attachment.filename,
        contentId: attachment.contentId,
        previewUrl: attachment.previewUrl,
      });
      if (inserted) return true;
      revokePreview(attachment);
      return false;
    });
    if (accepted.length !== fitting.length) {
      toastError({
        description: "One of the inline images could not be inserted.",
      });
    }
    if (!accepted.length) return;
    updateAttachments([
      ...attachmentsRef.current,
      ...accepted.map(({ attachment }) => attachment),
    ]);
    await Promise.all(
      accepted.map(({ file, attachment }) =>
        uploadComposeAttachment(file, attachment),
      ),
    );
  };

  const addDroppedFiles = (files: File[], into: "body" | "window") => {
    const inlineCount = attachmentsRef.current.filter(
      (attachment) =>
        attachment.disposition === "inline" && attachment.status !== "failed",
    ).length;
    addFiles(routeComposeFiles(files, { into, inlineCount })).catch(() =>
      toastError({ description: "One of the files could not be read." }),
    );
  };
  const fileDrop = useFileDropTarget({
    enabled: !isSubmitting,
    onDrop: (files) => addDroppedFiles(files, "window"),
  });

  const removeAttachment = (attachment: ComposeAttachment) => {
    // Detached first, so the editor change this causes finds nothing to remove.
    detachAttachment(attachment);
    if (attachment.contentId && attachment.managed) {
      editorRef.current?.removeInlineImage(attachment.contentId);
    }
  };

  // A draft moved to another account takes its image previews along.
  const previewsMoved = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      const previews = [...attachmentsRef.current];
      setTimeout(() => {
        if (!isMountedRef.current && !previewsMoved.current)
          for (const attachment of previews) revokePreview(attachment);
      }, 0);
    };
  }, []);

  useEffect(() => {
    const moved = pendingMove.current;
    if (!moved) return;
    pendingMove.current = undefined;
    onMovedDraftApplied();
    captureDraft();
    const uploads = moved.files.map(({ file, attachment }) =>
      uploadComposeAttachment(file, attachment),
    );
    const finishMove = async () => {
      await Promise.all(uploads);
      // The old account's copy goes only once the new mailbox holds this one.
      const savedToMailbox = await providerAutosave.saveNow();
      // A file that didn't attach here already said so when its upload failed.
      const filesMoved = moved.files.every(({ attachment }) =>
        attachmentsRef.current.some(
          (item) => item.id === attachment.id && item.status === "uploaded",
        ),
      );
      const move = { from: moved.from, filesMoved };
      if (!savedToMailbox) {
        unfinishedMove.current = move;
        return;
      }
      await completeMove(move);
    };
    finishMove().catch((error: unknown) => {
      toastError({ description: getMoveErrorMessage(error) });
    });
  });

  const forgetAttachedComposeFiles = useCallback(
    () =>
      forgetAttachedFiles(
        selectedEmailAccountId,
        attachmentsRef.current.map((attachment) => attachment.id),
      ),
    [selectedEmailAccountId],
  );

  const onSubmit: SubmitHandler<ComposeFormValues> = useCallback(
    async (data, event) => {
      // Cue's suggestion is never sent unseen: it has to be accepted or
      // discarded first.
      if (assistIsOpen) {
        focusAssist();
        toastError({
          description: "Accept or discard Cue's suggestion before sending.",
        });
        return;
      }
      const submitter = (event?.nativeEvent as SubmitEvent | undefined)
        ?.submitter;
      const markDoneAfterSend = submitter === sendAndMarkDoneButtonRef.current;
      const recipients = resolveComposeRecipientFields({
        selectedRecipients: {
          to: data.to,
          cc: data.cc,
          bcc: data.bcc,
        },
        pendingRecipients: pendingRecipientsRef.current,
      });
      if (!recipients.to) {
        toastError({ description: "Enter a valid recipient email address." });
        return;
      }

      // Files go to the mailbox draft as they are attached, so a send waits
      // for them and never carries their bytes itself.
      await waitForDraftOperations(draftQueueKey);
      const failedAttachment = attachmentsRef.current.find(
        (attachment) => attachment.status !== "uploaded",
      );
      if (failedAttachment) {
        toastError({
          description: `${failedAttachment.filename} isn't attached. Remove it or attach it again before sending.`,
        });
        return;
      }

      const editorValue = editorRef.current?.getValue() ?? {
        editableHtml: initialDraft.editableHtml,
        inlineContentIds: [],
        mode: initialDraft.mode,
        preservedBlockIds: preservedBlocks.map((block) => block.id),
      };
      const preservedBlockIds = new Set(editorValue.preservedBlockIds);
      const editableHtml = finalizeEditableEmailHtml({
        html: editorValue.editableHtml,
        inlineAttachments: getEditorInlineAttachments(attachmentsRef.current),
        mode: editorValue.mode,
      });
      const enrichedData: SendEmailBody = {
        ...data,
        ...recipients,
        replyToEmail: getReplyToEmailPayload(data.replyToEmail),
        messageHtml: combineEmailHtml({
          editableHtml,
          signatureHtml: preservedBlockIds.has("signature")
            ? initialDraft.signatureHtml
            : "",
          quotedHtml: preservedBlockIds.has("quote")
            ? initialDraft.quotedHtml
            : "",
        }),
      };
      const payloadValidation = validateSendEmailPayloadSize(enrichedData);
      if (!payloadValidation.valid) {
        toastError({ description: payloadValidation.error });
        return;
      }

      const deliveryTimes = parseDeliveryTimes(sendAt, remindAt);
      if (!deliveryTimes.valid) {
        setSubmissionError(deliveryTimes.error);
        return;
      }
      setSubmissionError("");
      await stopProviderAutosave();
      let deliveryAccepted = false;
      try {
        // The rule's files are sent from the draft that carries them. One
        // that can't be attached stops the send: the user was told it goes.
        if (ruleFiles.length && !providerDraftId.current) {
          try {
            await ensureProviderDraft();
          } catch (error) {
            const message =
              error instanceof Error ? error.message : SEND_UNCONFIRMED_MESSAGE;
            setSubmissionError(message);
            toastError({ description: message });
            return;
          }
        }
        // Autosave can replace a draft's message ID; its provider draft ID survives.
        enrichedData.providerDraftId = await resolveSendDraftId(
          providerDraftId.current,
          localDraftIdentity,
        );
        // The mailbox draft is what carries the files to the recipient.
        if (attachmentsRef.current.length && !enrichedData.providerDraftId) {
          toastError({
            description:
              "Could not find this draft in your mailbox to send its attachments. Reopen it and try again.",
          });
          return;
        }
        // Only a send time takes the scheduled path. A reminder alone goes
        // with the send through the outbox, so the reply shows in its
        // conversation at once and the server keeps the reminder on it.
        if (isInlineReply) {
          if (deliveryPath.current === "outbox" && sendAt) {
            setSubmissionError(
              "This reply was already submitted to the outbox. Check its delivery status before scheduling a new reply.",
            );
            return;
          }
          deliveryPath.current ??= sendAt ? "scheduled" : "outbox";
        }
        captureDraft();
        await flushDraft();
        const draftMessageIds = providerDraftMessageId
          ? getDraftSessionMessageIds(
              selectedEmailAccountId,
              providerDraftMessageId,
            )
          : localDraftIdentity
            ? ((await getReplyDraft(localDraftIdentity))?.content
                ?.providerDraftMessageIds ?? [])
            : [];
        const isScheduled = isInlineReply
          ? deliveryPath.current === "scheduled"
          : canScheduleDelivery && Boolean(sendAt);
        if (isScheduled) {
          const scheduledThreadId = replyingToEmail?.threadId ?? null;
          const result = await scheduleEmailAction(selectedEmailAccountId, {
            clientMutationId: requestId,
            threadId: scheduledThreadId,
            messageIds: draftKeyMessageId ? [draftKeyMessageId] : [],
            email: enrichedData,
            draftMessageIds: draftMessageIds.slice(-50),
            sendAt: deliveryTimes.sendAt,
            remindAt: deliveryTimes.remindAt,
          });
          if (!result?.data) {
            setSubmissionError(
              getActionErrorMessage(result ?? {}, {
                prefix: scheduledThreadId
                  ? "Could not schedule this reply"
                  : "Could not schedule this email",
              }),
            );
            return;
          }
          deliveryAccepted = true;
          forgetAttachedComposeFiles();
          try {
            await clearLocalDraft();
          } catch {
            toastError({
              description:
                "Reply scheduled, but its local draft copy could not be cleared.",
            });
          }
          if (markDoneAfterSend) onMarkDone?.();
          // The Scheduled view stops polling once nothing is pending, so it
          // needs the new send pushed to it rather than waiting for a refresh.
          // The email is already scheduled by now, so a refresh that fails must
          // not reach the catch below and report the send itself as failed.
          await refreshScheduledEmails(
            mutate,
            selectedEmailAccountId,
            scheduledThreadId,
          );
          if (!scheduledThreadId) {
            toastSuccess({ description: "Email scheduled." });
          }
          onClose?.();
          refetch?.();
          return;
        }
        const readerThreadId =
          replyingToEmail?.threadId?.trim() ||
          localDraftIdentity?.threadId ||
          requestId;
        const readerMessageId =
          (isInlineReply ? draftKeyMessageId : replyingToEmail?.messageId) ??
          localDraftIdentity?.messageId ??
          requestId;
        const online = navigator.onLine;
        const remindAtMs =
          canScheduleDelivery && deliveryTimes.remindAt
            ? Date.parse(deliveryTimes.remindAt)
            : undefined;
        if (!client) {
          setSubmissionError(
            "Mail is still starting. Try sending again in a moment.",
          );
          toastError({
            description:
              "Mail is still starting. Try sending again in a moment.",
          });
          return;
        }
        let outcome: Awaited<ReturnType<typeof queueReaderEmail>>;
        let showDraftAgain = () => {};
        try {
          outcome = await queueReaderEmail({
            client,
            email: enrichedData,
            mutationId: requestId,
            emailAccountId: selectedEmailAccountId,
            holdForUndo: online,
            remindAtMs,
            messageIds: isNewCompose ? [] : [readerMessageId],
            providerDraftMessageIds: draftMessageIds,
            attachments: attachmentsRef.current.flatMap(toAttachmentReference),
            online,
            threadId: readerThreadId,
            onQueued: async () => {
              deliveryAccepted = true;
              showDraftAgain = hideSendingDraftMessages(
                selectedEmailAccountId,
                draftMessageIds,
              );
              if (replyingToEmail?.threadId?.trim()) {
                await mutate([
                  "thread-deliveries",
                  selectedEmailAccountId,
                  readerThreadId,
                ]).catch(() => {});
              }
              onClose?.();
            },
          });
        } catch (error) {
          console.error(error);
          const description =
            error instanceof Error
              ? error.message
              : "Could not confirm this reply was queued. Check the thread delivery status before retrying.";
          showDraftAgain();
          setSubmissionError(description);
          toastError({ description });
          return;
        }
        const discardLocalDraft = async () => {
          forgetAttachedComposeFiles();
          try {
            await clearLocalDraft();
          } catch {
            toastError({
              description: isInlineReply
                ? "Reply queued, but its local draft copy could not be cleared."
                : "Email queued, but its local draft copy could not be cleared.",
            });
          }
        };
        if (outcome.status === "held") {
          beginUndoSend({
            client,
            operationId: outcome.mutationId,
            emailAccountId: selectedEmailAccountId,
            holdUntil: outcome.holdUntil,
            restoreComposer: () => onRestore?.(),
          });
          waitForReaderEmailSettlement({
            client,
            accountId: selectedEmailAccountId,
            mutationId: outcome.mutationId,
            settlementTimeoutMs:
              UNDO_SEND_DELAY_MS + READER_EMAIL_SETTLEMENT_TIMEOUT_MS,
            threadId: outcome.threadId,
          })
            .then(async (settled) => {
              if (settled.status === "cancelled" || settled.status === "failed")
                showDraftAgain();
              if (settled.status === "cancelled") return;
              await discardLocalDraft();
              if (settled.status === "sent") {
                if (startedFromSuggestion)
                  noteSuggestedReplySent({ edited: editedSuggestion });
                if (markDoneAfterSend) onMarkDone?.();
                onSuccess?.(settled.messageId, settled.threadId);
                refetch?.();
                // The reminder rides on the send's hold, listed once sent.
                if (remindAtMs !== undefined)
                  await refreshScheduledEmails(
                    mutate,
                    selectedEmailAccountId,
                    settled.threadId,
                  );
                return;
              }
              if (settled.status === "failed" && settled.ownsNotification) {
                toastError({ description: settled.error });
              } else if (
                settled.status === "uncertain" &&
                settled.ownsNotification
              ) {
                toastError({ description: SEND_UNCONFIRMED_MESSAGE });
              }
            })
            .catch(() => {});
          return;
        }
        if (outcome.status === "failed" || outcome.status === "cancelled")
          showDraftAgain();
        await discardLocalDraft();
        if (outcome.status === "sent") {
          if (
            !(
              startedFromSuggestion &&
              noteSuggestedReplySent({ edited: editedSuggestion })
            )
          )
            toastSuccess({
              description: isInlineReply ? "Reply sent" : "Email sent",
            });
          if (markDoneAfterSend) onMarkDone?.();
          onSuccess?.(outcome.messageId, outcome.threadId);
          refetch?.();
          if (remindAtMs !== undefined)
            await refreshScheduledEmails(
              mutate,
              selectedEmailAccountId,
              outcome.threadId,
            );
        } else if (outcome.status === "queued") {
          // A queued reply's delivery status in the thread already says so.
          if (!isInlineReply)
            toastSuccess({
              description: getQueuedEmailDescription(outcome.reason),
            });
          if (markDoneAfterSend) onMarkDone?.();
          onClose?.();
        } else if (outcome.status === "uncertain") {
          if (outcome.ownsNotification) {
            toastError({ description: SEND_UNCONFIRMED_MESSAGE });
          }
          onClose?.();
        } else if (outcome.status === "failed" && outcome.ownsNotification) {
          toastError({ description: outcome.error });
        }
      } catch (error) {
        console.error(error);
        setSubmissionError(SEND_UNCONFIRMED_MESSAGE);
        toastError({ description: SEND_UNCONFIRMED_MESSAGE });
      } finally {
        if (!deliveryAccepted) resumeProviderAutosave();
      }

      refetch?.();
    },
    [
      assistIsOpen,
      ruleFiles,
      focusAssist,
      stopProviderAutosave,
      resumeProviderAutosave,
      canScheduleDelivery,
      initialDraft,
      isInlineReply,
      isNewCompose,
      localDraftIdentity,
      sendAt,
      remindAt,
      requestId,
      draftKeyMessageId,
      draftQueueKey,
      captureDraft,
      clearLocalDraft,
      client,
      flushDraft,
      forgetAttachedComposeFiles,
      mutate,
      onClose,
      onRestore,
      onMarkDone,
      onSuccess,
      noteSuggestedReplySent,
      preservedBlocks,
      providerDraftMessageId,
      refetch,
      replyingToEmail,
      selectedEmailAccountId,
      startedFromSuggestion,
      editedSuggestion,
    ],
  );

  const reconnectContacts = async () => {
    setIsReconnectingContacts(true);

    try {
      const oauthProvider = isMicrosoftProvider(accountProvider)
        ? "microsoft"
        : "google";
      const url = await getAccountLinkingUrl(oauthProvider, {
        reconnectEmailAccountId: selectedEmailAccountId,
      });
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      toastError({
        title: "Error initiating reconnection",
        description:
          error instanceof Error
            ? error.message
            : "Please try again or contact support.",
      });
      setIsReconnectingContacts(false);
    }
  };

  const updatePendingRecipient = useCallback(
    (field: ComposeRecipientField, query: string) => {
      pendingRecipientsRef.current[field] = query;
      queueMicrotask(() => {
        if (isMountedRef.current) captureDraft();
      });
    },
    [captureDraft],
  );

  const recipientFieldProps = {
    emailAccountId: selectedEmailAccountId,
    ownAddresses: [sendingAddress],
    isReconnectingContacts,
    onActivate: setActiveRecipientField,
    onReconnectContacts: reconnectContacts,
    onReconnectRequired: () => setContactsReconnectRequired(true),
    onSearchQueryChange: updatePendingRecipient,
    onSelectedRecipientsChange: (
      field: ComposeRecipientField,
      recipients: string,
    ) => setValue(field, recipients),
    reconnectRequired: contactsReconnectRequired,
  };

  const handleFileInput =
    (disposition: ComposeAttachment["disposition"]) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length) {
        addFiles(
          disposition === "inline" ? { inline: files } : { attachments: files },
        ).catch(() =>
          toastError({ description: "One of the files could not be read." }),
        );
      }
    };
  const canCollapseInlineReplyFields =
    isInlineReply && Boolean(replyingToEmail?.to);
  const showInlineReplySummary = canCollapseInlineReplyFields && !editReply;
  const openInlineReplyFields = () => {
    setEditReply(true);
    requestAnimationFrame(() =>
      collapseInlineReplyFieldsButtonRef.current?.focus(),
    );
  };
  const closeInlineReplyFields = () => {
    setEditReply(false);
    requestAnimationFrame(() => inlineReplySummaryButtonRef.current?.focus());
  };
  const handleSendAtChange = (value: string) => {
    const nextRemindAt = getReminderAfterSendTimeChange(value, remindAt);
    setSubmissionError("");
    setSendAt(value);
    setRemindAt(nextRemindAt);
    captureDraft({ sendAt: value, remindAt: nextRemindAt });
  };
  const handleRemindAtChange = (value: string) => {
    setSubmissionError("");
    setRemindAt(value);
    captureDraft({ remindAt: value });
  };
  const handleDiscard = useCallback(async () => {
    if (!onDiscard || isSubmitting) return;
    try {
      await stopProviderAutosave();
      await waitForDraftOperations(draftQueueKey);
      // A draft opened from the mailbox is discarded by its owner; any other
      // compose discards the mailbox draft it saved.
      if (!providerDraftMessageId) {
        const local = localDraftIdentity
          ? await getReplyDraft(localDraftIdentity)
          : undefined;
        providerDraftId.current =
          local?.content?.providerDraftId ?? providerDraftId.current;
        if (providerDraftId.current) {
          const result = await discardComposeDraftAction(
            selectedEmailAccountId,
            {
              draftId: providerDraftId.current,
            },
          );
          if (!result?.data)
            throw new Error(getActionErrorMessage(result ?? {}));
          // The local draft hid its mailbox copy; once it is cleared, that
          // copy would open again as a draft, even after a reload, until sync
          // drops it.
          const discardedMessageIds = [
            ...(local?.content?.providerDraftMessageIds ?? []),
            ...(result.data.deletedMessageId
              ? [result.data.deletedMessageId]
              : []),
          ];
          hideSendingDraftMessages(selectedEmailAccountId, discardedMessageIds);
          await forgetDeletedDrafts(
            client,
            selectedEmailAccountId,
            discardedMessageIds,
          );
          await client?.requestSync([selectedEmailAccountId]);
        }
        if (
          !providerDraftId.current &&
          local?.content?.providerDraftCreationUnconfirmed
        )
          toastError({
            description:
              "The local draft will be discarded. A mailbox draft may still exist; check Drafts in Gmail or Outlook.",
          });
      }
      if ((await onDiscard(providerDraftId.current)) === false) {
        resumeProviderAutosave();
        return;
      }
      forgetAttachedComposeFiles();
      await clearLocalDraft();
    } catch (error) {
      resumeProviderAutosave();
      toastError({
        description:
          error instanceof Error
            ? error.message
            : "Could not discard this draft.",
      });
    }
  }, [
    clearLocalDraft,
    client,
    draftQueueKey,
    forgetAttachedComposeFiles,
    isSubmitting,
    providerDraftMessageId,
    selectedEmailAccountId,
    localDraftIdentity,
    onDiscard,
    stopProviderAutosave,
    resumeProviderAutosave,
  ]);

  // Changing From moves the draft: its text, recipients and files go to the
  // new account. The old account's drafts stay until the new one holds it.
  const [isMovingDraft, setIsMovingDraft] = useState(false);
  // While the draft moves, From is inert and then replaced along with this
  // composer, so focus can't return to it and would drop to the page, where
  // keys still being typed reach mailbox shortcuts. Compose itself holds focus
  // until the moved draft's composer takes it. This runs once the From menu
  // has closed and stopped holding focus itself.
  useEffect(() => {
    if (!isMovingDraft) return;
    formRef.current
      ?.closest<HTMLElement>(`[${TYPING_SURFACE_ATTRIBUTE}]`)
      ?.focus();
  }, [isMovingDraft]);
  const moveDraftToAccount = async (nextEmailAccountId: string) => {
    if (nextEmailAccountId === selectedEmailAccountId || isMovingDraft) return;
    setIsMovingDraft(true);
    try {
      await stopProviderAutosave();
      await waitForDraftOperations(draftQueueKey);
      // The old account keeps an up-to-date copy in case the move fails.
      captureLocalDraft();
      await flushDraft();
      const local = localDraftIdentity
        ? await getReplyDraft(localDraftIdentity)
        : undefined;
      const draftId =
        local?.content?.providerDraftId ?? providerDraftId.current;
      const uploaded = attachmentsRef.current.flatMap((attachment) =>
        attachment.status === "uploaded" && attachment.draftAttachmentId
          ? [{ ...attachment, draftAttachmentId: attachment.draftAttachmentId }]
          : [],
      );
      const files =
        draftId && uploaded.length
          ? await readDraftAttachmentFiles({
              emailAccountId: selectedEmailAccountId,
              draftId,
              attachments: uploaded.map((attachment) => ({
                ...toAttachmentMetadata(attachment),
                draftAttachmentId: attachment.draftAttachmentId,
              })),
            })
          : [];
      for (const attachment of attachmentsRef.current)
        if (!uploaded.some((item) => item.id === attachment.id))
          toastError({
            description: `Could not attach ${attachment.filename}.`,
          });
      // Read last, so nothing in the message is older than the hand-off.
      const content = getDraftContent();
      previewsMoved.current = true;
      onSelectEmailAccount(nextEmailAccountId, {
        values: content?.values ?? getValues(),
        editableHtml: removeComposerSignature(
          content?.draft.editableHtml ?? initialDraft.editableHtml,
        ),
        mode: content?.draft.mode ?? initialDraft.mode,
        files: uploaded.flatMap(
          ({ draftAttachmentId: _draftAttachmentId, ...attachment }, index) => {
            const file = files[index];
            return file
              ? [{ attachment: { ...attachment, status: "uploading" }, file }]
              : [];
          },
        ),
        from: {
          emailAccountId: selectedEmailAccountId,
          localDraft: localDraftIdentity,
          draftId,
          attachmentIds: attachmentsRef.current.map(({ id }) => id),
        },
      });
    } catch (error) {
      resumeProviderAutosave();
      setIsMovingDraft(false);
      toastError({ description: getMoveErrorMessage(error) });
    }
  };

  // The popped-out composer reopens from the local draft, so keep writing
  // here if the latest edits could not be saved.
  const handlePopOut = async () => {
    if (!onPopOut || isSubmitting) return;
    if (await flushDraft()) onPopOut();
  };
  const popOutButton = onPopOut && (
    <Tooltip shortcuts={["popOutDraft"]}>
      <Button
        aria-label="Pop out draft"
        className="ml-auto size-7 shrink-0 hover:bg-transparent"
        disabled={isSubmitting}
        onClick={handlePopOut}
        size="icon"
        type="button"
        variant="ghostMuted"
      >
        <PictureInPicture2Icon className="size-4" />
      </Button>
    </Tooltip>
  );

  useShortcuts({
    send: (event) => {
      if (
        !isShortcutForForm(event, formRef.current, shortcutOwnerId) ||
        isSubmitting
      )
        return;
      if (assist.interceptSend()) return;
      formRef.current?.requestSubmit();
    },
    sendAndMarkDone: onMarkDone
      ? (event) => {
          if (
            !isShortcutForForm(event, formRef.current, shortcutOwnerId) ||
            isSubmitting
          )
            return;
          if (assist.interceptSend()) return;
          const submitter = sendAndMarkDoneButtonRef.current;
          if (submitter) formRef.current?.requestSubmit(submitter);
        }
      : undefined,
    sendLater:
      canScheduleDelivery && !isSubmitting
        ? (event) => {
            if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
              deliveryOptionsRef.current?.open("sendLater");
          }
        : undefined,
    remindMe:
      canScheduleDelivery && !isSubmitting
        ? (event) => {
            if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
              deliveryOptionsRef.current?.open("remindMe");
          }
        : undefined,
    saveDraft: async (event) => {
      if (!isShortcutForForm(event, formRef.current, shortcutOwnerId)) return;
      if (await flushDraft()) toastSuccess({ description: "Draft saved" });
    },
    addCc: (event) => {
      if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
        showRecipientRow("cc");
    },
    addBcc: (event) => {
      if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
        showRecipientRow("bcc");
    },
    askCue: (event) => {
      if (
        !isShortcutForForm(event, formRef.current, shortcutOwnerId) ||
        isSubmitting
      )
        return;
      event?.preventDefault();
      assist.open();
    },
    attachFiles: (event) => {
      if (
        !isShortcutForForm(event, formRef.current, shortcutOwnerId) ||
        isSubmitting
      )
        return;
      attachmentInputRef.current?.click();
    },
    popOutDraft: onPopOut
      ? (event) => {
          if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
            handlePopOut();
        }
      : undefined,
    discardDraft: onDiscard
      ? (event) => {
          if (isShortcutForForm(event, formRef.current, shortcutOwnerId))
            handleDiscard();
        }
      : undefined,
  });

  return (
    <form
      data-inline-reply={isInlineReply || undefined}
      // Nothing can change while the draft moves, so nothing typed is lost.
      inert={isMovingDraft}
      ref={formRef}
      style={
        isInlineReply && !isComposeWindow
          ? ({
              "--email-editor-content-min-height": "56px",
              "--email-editor-content-padding": "0.25rem 0",
            } as CSSProperties)
          : undefined
      }
      onSubmit={handleSubmit(onSubmit)}
      {...fileDrop.handlers}
      className={cn(
        "relative",
        isComposeWindow
          ? "flex h-full min-h-0 flex-col overflow-hidden [&_[data-email-editor-root]]:min-h-0 [&_[data-email-editor-root]]:flex-1"
          : "space-y-2",
        isInlineReply &&
          "[&_[data-email-editor-root]]:text-neutral-900 dark:[&_[data-email-editor-root]]:text-neutral-100",
        isInlineReply &&
          !isComposeWindow &&
          "space-y-2 border-t border-border pt-4",
      )}
    >
      <div
        className={cn(
          isComposeWindow
            ? "shrink-0 border-border border-b px-4 pt-3 pb-2"
            : "contents",
        )}
      >
        {!!fromAccounts?.length && !replyingToEmail && (
          <div className="flex min-h-7 items-center gap-2">
            <ComposeFieldLabel htmlFor="from-account" label="From" />
            <Select
              disabled={isMovingDraft}
              value={selectedEmailAccountId}
              onValueChange={moveDraftToAccount}
            >
              <SelectTrigger
                aria-label="From"
                className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-sm shadow-none focus:ring-0 focus:ring-offset-0"
                id="from-account"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fromAccounts.map((account) => (
                  <SelectItem
                    disabled={Boolean(account.account.disconnectedAt)}
                    key={account.id}
                    value={account.id}
                  >
                    {account.name
                      ? `${account.name} (${account.email})`
                      : account.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {showInlineReplySummary ? (
          <div className="flex min-h-7 items-center gap-2">
            <button
              type="button"
              aria-expanded={false}
              ref={inlineReplySummaryButtonRef}
              onClick={openInlineReplyFields}
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-sm font-medium leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ReplyStatus
                isCueSuggestion={isCueSuggestion}
                isMailboxDraft={isMailboxDraft}
              />
              <span className="min-w-0 truncate">
                {isCueSuggestion ? "for" : "to"}{" "}
                {formatRecipientNames(
                  [
                    ...splitRecipientList(
                      watch("to") ?? replyingToEmail?.to ?? "",
                    ),
                    ...splitRecipientList(
                      watch("cc") ?? replyingToEmail?.cc ?? "",
                    ),
                  ],
                  ownEmails,
                ) || "recipients"}
              </span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </button>
            {isCueSuggestion ? (
              <span className="shrink-0 text-muted-foreground text-xs">
                · {suggestion?.label ?? "Suggested by Cue"}
              </span>
            ) : null}
            {editedSuggestion ? (
              <span className="shrink-0 text-muted-foreground text-xs">
                · Started from Cue's suggestion
              </span>
            ) : null}
            {popOutButton}
          </div>
        ) : (
          <div className="space-y-1 [&_input]:bg-transparent">
            {(["to", "cc", "bcc"] as const)
              .filter(isRecipientRowShown)
              .map((field) => (
                <div key={field} className="flex min-h-7 items-center gap-2">
                  <ComposeFieldLabel
                    htmlFor={field}
                    label={RECIPIENT_LABELS[field]}
                  />
                  <div className="min-w-0 flex-1">
                    {env.NEXT_PUBLIC_CONTACTS_ENABLED ||
                    client?.queryContactSuggestions ? (
                      <ComposeContactRecipientField
                        {...recipientFieldProps}
                        active={activeRecipientField === field}
                        autoFocus={
                          autoFocus && field === "to" && focusRecipientField
                        }
                        className="min-h-8"
                        name={field}
                        selectedRecipients={watch(field) ?? ""}
                      />
                    ) : (
                      <Input
                        type="text"
                        name={field}
                        registerProps={{
                          ...register(field, { required: field === "to" }),
                          autoFocus:
                            autoFocus && field === "to" && focusRecipientField,
                        }}
                        error={errors[field]}
                        className="h-7 rounded-none border-0 bg-transparent p-0 text-sm leading-5 shadow-none focus:border-transparent focus:ring-0 sm:text-sm"
                      />
                    )}
                  </div>
                  {field === "to" &&
                    (["cc", "bcc"] as const)
                      .filter((hidden) => !isRecipientRowShown(hidden))
                      .map((hidden) => (
                        <button
                          aria-label={`Add ${RECIPIENT_LABELS[hidden]} recipients`}
                          className="shrink-0 rounded-sm px-1 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          key={hidden}
                          onClick={() => showRecipientRow(hidden)}
                          type="button"
                        >
                          {RECIPIENT_LABELS[hidden]}
                        </button>
                      ))}
                  {field === "to" && canCollapseInlineReplyFields && (
                    <button
                      type="button"
                      aria-label="Hide recipients"
                      ref={collapseInlineReplyFieldsButtonRef}
                      onClick={closeInlineReplyFields}
                      className="rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronDownIcon className="size-3 rotate-180" />
                    </button>
                  )}
                  {field === "to" && popOutButton}
                </div>
              ))}
            <div className="pt-3">
              <Input
                type="text"
                name="subject"
                registerProps={{
                  ...register("subject", { required: true }),
                  "aria-label": "Subject",
                }}
                error={errors.subject}
                placeholder="Subject"
                // Borderless like the rest of the header, with a hairline in
                // the focus colour so keyboard focus stays visible.
                className="h-8 rounded-none border-0 border-transparent border-b bg-transparent p-0 text-base font-medium text-foreground shadow-none focus:border-ring focus:ring-0 sm:text-base md:text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <EmailEditor
        placeholder={isInlineReply ? "" : undefined}
        appearance={isComposeWindow || isInlineReply ? "seamless" : "contained"}
        autofocus={autoFocus && !focusRecipientField}
        // Cue's reply is full of course codes and times a dictionary flags.
        // Checking comes back with the user's first edit.
        spellCheck={!isCueSuggestion}
        onAssist={assist.open}
        onSlashKeyDown={onSlashKeyDown}
        onSlashTrigger={onSlashTrigger}
        ref={editorRef}
        initialHtml={initialDraft.editableHtml}
        mode={initialDraft.mode}
        onStateChange={handleEditorStateChange}
        onFiles={(files) => {
          // The editor takes the drop itself, so the form never sees it end.
          fileDrop.reset();
          addDroppedFiles(files, "body");
        }}
        preservedBlocks={preservedBlocks}
        resolveRemoteImages={resolveRemoteImages}
      />

      {submissionError && (
        <p
          role="alert"
          className={cn(
            "text-destructive text-sm",
            isComposeWindow && "shrink-0 px-4",
          )}
        >
          {submissionError}
        </p>
      )}
      {!!(attachments.length || forwardedAttachments.length) && (
        <div
          className={cn("space-y-1.5", isComposeWindow && "shrink-0 px-4 py-2")}
        >
          <ul aria-label="Attachments" className="flex flex-wrap gap-2">
            {forwardedAttachments.map((attachment) => (
              <li
                className="flex max-w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                key={attachment.id}
                title="Included from the message you are forwarding"
              >
                <PaperclipIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="max-w-52 truncate">{attachment.filename}</span>
                <span className="text-muted-foreground">
                  {formatAttachmentSize(attachment.size)}
                </span>
              </li>
            ))}
            {attachments.map((attachment) => (
              <li
                aria-busy={attachment.status === "uploading" || undefined}
                className={cn(
                  "flex max-w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs",
                  attachment.status === "failed" &&
                    "border-destructive/50 text-destructive",
                )}
                key={attachment.id}
                title={attachment.error}
              >
                <AttachmentIcon attachment={attachment} />
                <span className="max-w-52 truncate">{attachment.filename}</span>
                <span className="text-muted-foreground">
                  {ATTACHMENT_STATUS_LABELS[attachment.status] ??
                    formatAttachmentSize(attachment.size)}
                </span>
                <button
                  aria-label={`Remove ${attachment.filename}`}
                  className="rounded-sm p-0.5 hover:bg-muted"
                  onClick={() => removeAttachment(attachment)}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
          <p
            className={cn(
              "text-muted-foreground text-xs tabular-nums",
              attachmentTotalBytes > attachmentLimitBytes && "text-destructive",
            )}
          >
            {formatAttachmentSize(attachmentTotalBytes)} of{" "}
            {formatAttachmentSize(attachmentLimitBytes)}
          </p>
        </div>
      )}

      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          isComposeWindow &&
            "shrink-0 px-4 py-2 max-sm:pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        )}
      >
        <div className="flex flex-wrap items-center gap-1">
          <Tooltip
            shortcuts={onMarkDone ? ["send", "sendAndMarkDone"] : ["send"]}
          >
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting && <ButtonLoader />}
              Send
            </Button>
          </Tooltip>
          <button
            aria-hidden
            hidden
            ref={sendAndMarkDoneButtonRef}
            tabIndex={-1}
            type="submit"
          />
          {canScheduleDelivery && (
            <DeliveryOptions
              ref={deliveryOptionsRef}
              sendAt={sendAt}
              remindAt={remindAt}
              disabled={isSubmitting}
              onSendAtChange={handleSendAtChange}
              onRemindAtChange={handleRemindAtChange}
              shortcutOwnerId={shortcutOwnerId}
            />
          )}
        </div>

        <div className="flex items-center gap-0.5 text-muted-foreground">
          {assist.panel}
          {/* Phones have no shortcut keys and a cramped selection bubble. */}
          <Button
            aria-label="Ask Cue"
            className="hover:bg-transparent sm:hidden"
            disabled={isSubmitting}
            onClick={assist.open}
            onPointerDown={(event) => event.preventDefault()}
            size="icon"
            type="button"
            variant="ghostMuted"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ✦
            </span>
          </Button>
          {snippetToolbar}
          <VoiceInput
            onInsert={(text) => {
              editorRef.current?.insertText(
                text.endsWith(" ") ? text : `${text} `,
              );
            }}
            onSend={(text) => {
              editorRef.current?.insertText(
                text.endsWith(" ") ? text : `${text} `,
              );
            }}
          />
          <input
            className="hidden"
            data-testid="compose-attachments-input"
            multiple
            onChange={handleFileInput("attachment")}
            ref={attachmentInputRef}
            type="file"
          />
          <Tooltip shortcuts={["attachFiles"]}>
            <Button
              aria-label="Attach files"
              className="hover:bg-transparent"
              disabled={isSubmitting}
              onClick={() => attachmentInputRef.current?.click()}
              size="icon"
              type="button"
              variant="ghostMuted"
            >
              <PaperclipIcon className="size-4" />
            </Button>
          </Tooltip>
          <input
            accept={EMAIL_INLINE_IMAGE_MIME_TYPES.join(",")}
            className="hidden"
            data-testid="compose-inline-image-input"
            multiple
            onChange={handleFileInput("inline")}
            ref={inlineImageInputRef}
            type="file"
          />
          <Button
            aria-label="Insert inline images"
            className="hover:bg-transparent"
            disabled={isSubmitting}
            onClick={() => inlineImageInputRef.current?.click()}
            size="icon"
            type="button"
            variant="ghostMuted"
          >
            <ImageIcon className="size-4" />
          </Button>
          {onDiscard && (
            <Tooltip shortcuts={["discardDraft"]}>
              <Button
                aria-label="Discard draft"
                className="hover:bg-transparent"
                disabled={isSubmitting}
                onClick={handleDiscard}
                size="icon"
                type="button"
                variant="ghostMuted"
              >
                <TrashIcon className="size-4" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {(isCueSuggestion || editedSuggestion) && suggestion?.evidence}
      {ruleFiles.length && !savedToMailbox ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <span>Attaches</span>
          {ruleFiles.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5"
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => removeRuleFile(name)}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {/* Inline replies say "Draft" in their header instead. */}
      {isComposeWindow && isMailboxDraft && !providerAutosave.error && (
        <p
          className="shrink-0 px-4 pb-2 text-muted-foreground text-xs"
          role="status"
        >
          Saved to Drafts
        </p>
      )}
      {providerAutosave.error && (
        <p role="alert" className="text-xs text-destructive">
          {providerAutosave.error}
        </p>
      )}
      {localDraftIdentity && draftSaveError && (
        <p role="alert" className="text-xs text-destructive">
          {draftSaveError}
        </p>
      )}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-20 !mt-0 flex flex-col items-center justify-center gap-1.5 rounded-[inherit] border-2 border-primary/60 border-dashed bg-background/90 text-center",
          // Fades in place for reduced motion; otherwise also settles from
          // slightly smaller, as the surface rises to meet the file.
          "opacity-0 transition-opacity duration-150 ease-out motion-safe:scale-[0.98] motion-safe:transition-[opacity,transform]",
          fileDrop.active && "opacity-100 motion-safe:scale-100",
        )}
      >
        <PaperclipIcon className="size-5 text-primary" />
        <p className="font-medium text-foreground text-sm">
          Drop files to attach
        </p>
        <p className="text-muted-foreground text-xs">
          Images dropped in the message appear inline
        </p>
      </div>
    </form>
  );
}

const ATTACHMENT_STATUS_LABELS: Partial<
  Record<ComposeAttachment["status"], string>
> = {
  uploading: "Uploading…",
  failed: "Not attached",
};

const DRAFT_SYNC_FAILED_MESSAGE =
  "Couldn't sync this draft to your mailbox. It's saved on this device and we'll keep trying.";

const RECIPIENT_LABELS: Record<ComposeRecipientField, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
};

function createComposeAttachmentMetadata(
  file: File,
  disposition: ComposeAttachment["disposition"],
): EmailAttachmentMetadata {
  const id = randomUuid();
  return {
    id,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    disposition,
    ...(disposition === "inline"
      ? {
          contentId: `${id}@inboxzero.local`,
        }
      : {}),
  };
}

async function isInlineImageContent(file: File) {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let binary = "";
  for (const byte of header) binary += String.fromCharCode(byte);
  return detectInlineImageMimeType(btoa(binary)) === file.type;
}

function revokePreview(attachment: ComposeAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function AttachmentIcon({ attachment }: { attachment: ComposeAttachment }) {
  if (attachment.status === "uploading")
    return (
      <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
    );
  if (attachment.status === "failed")
    return <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />;
  if (attachment.disposition === "inline")
    return <ImageIcon aria-hidden className="size-3.5 shrink-0" />;
  return <PaperclipIcon aria-hidden className="size-3.5 shrink-0" />;
}

function ComposeFieldLabel({
  htmlFor,
  label,
}: {
  htmlFor: string;
  label: string;
}) {
  return (
    <label
      className="w-12 shrink-0 text-sm font-medium leading-5 text-foreground"
      htmlFor={htmlFor}
    >
      {label}
    </label>
  );
}

const SESSION_EXPIRED_TOAST_ID = "session-expired";

const SEND_UNCONFIRMED_MESSAGE =
  "We couldn't confirm this was sent. Check Sent before trying again.";

function getQueuedEmailDescription(
  reason: "offline" | "pending" | "blocked_auth",
) {
  if (reason === "offline") {
    return "Email queued. It will send when you're back online.";
  }
  if (reason === "blocked_auth") {
    return "Email queued. Reconnect this account to send it.";
  }
  return "Email queued and will keep sending in the background.";
}

function isShortcutForForm(
  event: KeyboardEvent | undefined,
  form: HTMLFormElement | null,
  shortcutOwnerId: string,
) {
  if (!(event?.target instanceof Node)) return false;
  if (form?.contains(event.target)) return true;
  if (!(event.target instanceof Element)) return false;

  return (
    event.target
      .closest("[data-compose-shortcut-owner]")
      ?.getAttribute("data-compose-shortcut-owner") === shortcutOwnerId
  );
}

/**
 * SWR's `mutate` rejects when the revalidation request fails. These refreshes
 * run after the send is already scheduled, so a failure is stale data, not a
 * failed send, and must never surface as one.
 */
async function refreshScheduledEmails(
  mutate: ScopedMutator,
  emailAccountId: string,
  threadId: string | null,
) {
  const keys = [
    upcomingScheduledEmailsKey(emailAccountId),
    ...(threadId ? [threadScheduledEmailsKey(emailAccountId, threadId)] : []),
  ];
  await Promise.all(keys.map((key) => mutate(key).catch(() => {})));
}

// Unexpected server failures are usually transient and the autosave retries
// them, so they get reassuring copy. Specific rejections (a draft that was
// sent or deleted elsewhere, an expired session) are shown as-is.
function getDraftSyncErrorMessage(
  result: { serverError?: string } | undefined,
) {
  const message = getActionErrorMessage(
    result ?? {},
    DRAFT_SYNC_FAILED_MESSAGE,
  );
  return message === UNEXPECTED_ACTION_ERROR_MESSAGE
    ? DRAFT_SYNC_FAILED_MESSAGE
    : message;
}

// The footer inside the composer's signature belongs to it; only branding
// elsewhere in the body is removed.
function stripBrandingOutsideSignature(body: HTMLElement) {
  const signature = body.querySelector(":scope > [data-smartmail]");
  if (!signature) return stripBrandingSignatures(body.innerHTML);
  const placeholder = document.createComment("signature");
  signature.replaceWith(placeholder);
  const html = stripBrandingSignatures(body.innerHTML);
  // A function replacer keeps "$" sequences in the signature literal.
  return html.replace("<!--signature-->", () => signature.outerHTML);
}

// Once edited, a draft holds its signature inline; a moved draft takes the
// new account's signature instead.
function removeComposerSignature(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  // Only a top-level container is the composer's own signature.
  for (const element of [...template.content.children])
    if (element.hasAttribute("data-smartmail")) element.remove();
  return template.innerHTML;
}

function ReplyStatus({
  isCueSuggestion,
  isMailboxDraft,
}: {
  isCueSuggestion: boolean;
  isMailboxDraft: boolean;
}) {
  // Red marks words the user wrote and hasn't sent. Cue's untouched reply is
  // waiting on a decision, not on unfinished writing.
  if (isCueSuggestion)
    return <span className="text-muted-foreground">Draft ready</span>;
  if (isMailboxDraft)
    return <span className="text-red-600 dark:text-red-400">Draft</span>;
  return <span>Reply</span>;
}

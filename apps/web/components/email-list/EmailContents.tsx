import { startTransition, useEffect, useMemo, useState } from "react";
import {
  BufferedMailHtmlFrame,
  MailPlainTextBody,
  buildMailHtmlDocument,
  getMailDarkTreatment,
  getMailHtmlDocumentKey,
} from "@inboxzero/mail-ui/MailBody";
import { useTheme } from "next-themes";
import { EllipsisIcon } from "lucide-react";
import { decodeHtmlEntities } from "@/utils/gmail/decode";
import {
  getPreparedEmailHtml,
  IMAGE_PROXY_BASE_URL,
  IMAGE_PROXY_ORIGIN,
  prepareSanitizedEmailHtml,
  sanitizeEmailHtml,
} from "@/utils/email/prepare-html.client";
import type { ParsedMessage } from "@/utils/types";
import {
  getInlineImageContentIds,
  normalizeContentId,
  rewriteInlineImageSources,
} from "@/utils/email/inline-images";
import { linkifyPlainText } from "@inboxzero/mail-ui/linkify";
import { splitEmailContent } from "@/utils/email/split-email-content.client";
import {
  fetchAttachment,
  getAttachmentUrl,
} from "@/utils/attachments/download";
import { queueAttachmentDownload } from "@/utils/attachments/download-queue";
import { getAttachmentImagePreview } from "@/utils/attachments/attachment-preview";
import { useDarkEmailMode } from "@/hooks/useDarkEmailMode";

const NO_INLINE_ATTACHMENTS: ParsedMessage["inline"] = [];
const INLINE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export function HtmlEmail({
  html,
  messageId,
  emailAccountId,
  sender,
  inlineAttachments = NO_INLINE_ATTACHMENTS,
  onReplyMessage,
  onForwardMessage,
  onNavigateMessage,
  onFocusMessage,
  label,
}: {
  /** Names the message's frame for screen readers, e.g. sender and date. */
  label?: string;
  html: string;
  messageId: string;
  emailAccountId?: string;
  /** The sender's address, whose remembered dark-mode choice applies. */
  sender?: string;
  inlineAttachments?: ParsedMessage["inline"];
  onReplyMessage?: () => void;
  onForwardMessage?: () => void;
  onNavigateMessage?: (direction: -1 | 1) => void;
  onFocusMessage?: () => void;
}) {
  const sanitizedHtml = useMemo(() => sanitizeEmailHtml(html), [html]);
  // Message objects are rebuilt whenever the conversation republishes, so the
  // effect keys on the attachments' identity rather than the array or its
  // order. Re-running it would mint new object URLs and remount the frame
  // without its images.
  const inlineImageIds = useMemo(
    () => serializeInlineImageIds(inlineAttachments),
    [inlineAttachments],
  );
  const [showReplies, setShowReplies] = useState(false);
  const [renderHtml, setRenderHtml] = useState(
    () =>
      getPreparedEmailHtml({ messageId, sourceHtml: sanitizedHtml }) ??
      sanitizedHtml,
  );
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === "dark";
  const { mode: darkEmailMode } = useDarkEmailMode(emailAccountId, sender);
  const adaptDesignedEmails = darkEmailMode === "adapt";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const objectUrls: string[] = [];
    setRenderHtml(
      getPreparedEmailHtml({ messageId, sourceHtml: sanitizedHtml }) ??
        sanitizedHtml,
    );

    Promise.all([
      prepareSanitizedEmailHtml({ messageId, sourceHtml: sanitizedHtml }),
      loadInlineImageSources({
        emailAccountId,
        signal: controller.signal,
        html: sanitizedHtml,
        inlineImageIds,
        messageId,
      }),
    ]).then(
      ([rewrittenHtml, inlineImages]) => {
        const loadedObjectUrls = Object.values(inlineImages);
        if (cancelled) {
          for (const objectUrl of loadedObjectUrls) {
            URL.revokeObjectURL(objectUrl);
          }
          return;
        }
        objectUrls.push(...loadedObjectUrls);
        startTransition(() =>
          setRenderHtml(rewriteInlineImageSources(rewrittenHtml, inlineImages)),
        );
      },
      () => {
        if (cancelled) return;
        startTransition(() => setRenderHtml(sanitizedHtml));
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    };
  }, [emailAccountId, inlineImageIds, messageId, sanitizedHtml]);

  const { mainContent, quotedContent, hasQuotedContent } = useMemo(
    () => splitEmailContent(renderHtml),
    [renderHtml],
  );
  const darkTreatment = useMemo(
    () =>
      getMailDarkTreatment(mainContent, { isDarkMode, adaptDesignedEmails }),
    [mainContent, isDarkMode, adaptDesignedEmails],
  );
  const quotedDarkTreatment = useMemo(
    () =>
      getMailDarkTreatment(quotedContent, { isDarkMode, adaptDesignedEmails }),
    [quotedContent, isDarkMode, adaptDesignedEmails],
  );

  const documentKey = useMemo(
    () => getMailHtmlDocumentKey(mainContent, darkTreatment),
    [mainContent, darkTreatment],
  );
  const srcDoc = useMemo(
    () =>
      buildMailHtmlDocument({
        html: mainContent,
        darkTreatment,
        imageProxyBaseUrl: IMAGE_PROXY_BASE_URL,
        imageProxyOrigin: IMAGE_PROXY_ORIGIN,
        documentKey,
      }),
    [mainContent, darkTreatment, documentKey],
  );

  const quotedDocumentKey = useMemo(
    () => getMailHtmlDocumentKey(quotedContent, quotedDarkTreatment),
    [quotedContent, quotedDarkTreatment],
  );
  const quotedSrcDoc = useMemo(
    () =>
      buildMailHtmlDocument({
        html: quotedContent,
        darkTreatment: quotedDarkTreatment,
        imageProxyBaseUrl: IMAGE_PROXY_BASE_URL,
        imageProxyOrigin: IMAGE_PROXY_ORIGIN,
        documentKey: quotedDocumentKey,
      }),
    [quotedContent, quotedDarkTreatment, quotedDocumentKey],
  );
  const callbacks = {
    onForwardMessage,
    onNavigateMessage,
    onReplyMessage,
    onFocusMessage,
  };

  return (
    <div className="relative min-w-0 overflow-x-hidden">
      <BufferedMailHtmlFrame
        srcDoc={srcDoc}
        documentKey={documentKey}
        darkTreatment={darkTreatment}
        callbacks={callbacks}
        label={label}
      />
      {hasQuotedContent && (
        <button
          type="button"
          aria-expanded={showReplies}
          aria-label={
            showReplies ? "Hide quoted content" : "Show quoted content"
          }
          className="mt-1 inline-flex h-5 items-center rounded-full bg-muted px-2 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          onClick={() => setShowReplies(!showReplies)}
        >
          <EllipsisIcon className="size-4" />
        </button>
      )}
      {hasQuotedContent && showReplies && (
        <BufferedMailHtmlFrame
          srcDoc={quotedSrcDoc}
          documentKey={quotedDocumentKey}
          darkTreatment={quotedDarkTreatment}
          callbacks={callbacks}
          label={label && `Quoted text in ${label}`}
        />
      )}
    </div>
  );
}

export function PlainEmail({ text }: { text: string }) {
  const segments = useMemo(
    () => linkifyPlainText(decodeHtmlEntities(text)),
    [text],
  );

  return <MailPlainTextBody segments={segments} />;
}

async function loadInlineImageSources({
  emailAccountId,
  signal,
  html,
  inlineImageIds,
  messageId,
}: {
  emailAccountId: string | undefined;
  signal: AbortSignal;
  html: string;
  inlineImageIds: string;
  messageId: string;
}): Promise<Record<string, string>> {
  const attachmentIdByContentId = new Map<string, string>(
    JSON.parse(inlineImageIds),
  );
  if (!emailAccountId || !attachmentIdByContentId.size) return {};

  const entries = await Promise.all(
    getInlineImageContentIds(html).map(async (contentId) => {
      const attachmentId = attachmentIdByContentId.get(contentId);
      if (!attachmentId) return;

      try {
        // Body images are content the user opened, so they skip the
        // speculative attachment-preview budget.
        const blob = await queueAttachmentDownload({
          priority: "requested",
          signal,
          download: (transferSignal) =>
            fetchAttachment({
              url: getAttachmentUrl({
                accountId: emailAccountId,
                messageId,
                attachmentId,
              }),
              emailAccountId,
              maxBytes: INLINE_IMAGE_MAX_BYTES,
              signal: transferSignal,
            }),
        }).then(getAttachmentImagePreview);
        if (!blob || signal.aborted) return;
        return [contentId, URL.createObjectURL(blob)] as const;
      } catch {
        return;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

function serializeInlineImageIds(inlineAttachments: ParsedMessage["inline"]) {
  const entries: [contentId: string, attachmentId: string][] = [];
  for (const attachment of inlineAttachments) {
    const contentId = normalizeContentId(attachment.headers["content-id"]);
    if (contentId && attachment.attachmentId)
      entries.push([contentId, attachment.attachmentId]);
  }
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

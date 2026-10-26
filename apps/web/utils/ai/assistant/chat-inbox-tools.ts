import { type InferUITool, type JSONValue, tool } from "ai";
import { z } from "zod";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";
import { posthogCaptureEvent } from "@/utils/posthog";
import { createEmailProvider } from "@/utils/email/provider";
import { describeProviderRateLimitError } from "@/utils/email/rate-limit";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import {
  extractEmailAddress,
  extractUniqueEmailAddresses,
  isValidEmail,
  splitRecipientList,
} from "@/utils/email";
import { getRuleLabel } from "@/utils/rule/consts";
import { SystemType } from "@/generated/prisma/enums";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { getFormattedSenderAddress } from "@/utils/email/get-formatted-sender-address";
import { runWithBoundedConcurrency } from "@/utils/async";
import { findNestedLabelMatches } from "@/utils/label/find-nested-label-matches";
import { normalizeLabelName } from "@/utils/label/normalize-label-name";
import { resolveLabelNameAndId } from "@/utils/label/resolve-label";
import {
  buildMicrosoftSearchErrorResult,
  getOutlookFieldScopeCandidate,
  getOutlookLocalSearch,
  normalizeOutlookSearchInput,
  runOutlookSearch,
} from "@/utils/outlook/assistant-search";
import { sleep } from "@/utils/sleep";
import {
  isLocalPageToken,
  SEARCH_INBOX_MAX_RESULTS,
} from "@/utils/actions/assistant-local-search.validation";
import type {
  LocalMailSearch,
  LocalMailSearchAnswer,
} from "@/utils/ai/assistant/local-mail-search";
import { archiveCategory } from "@/utils/categorize/senders/archive-category";
import { getCategoryOverview } from "@/utils/categorize/senders/get-category-overview";
import { startBulkCategorization } from "@/utils/categorize/senders/start-bulk-categorization";
import {
  type ManageInboxAction,
  manageInboxActions,
  requiresSenderEmails,
} from "@/utils/ai/assistant/manage-inbox-actions";
import { hideToolErrorFromUser } from "@/utils/ai/assistant/tool-error-visibility";
import { previewMatchingQueryAction } from "@/utils/ai/assistant/chat-matching-actions";
import { withoutConfirmToken } from "@/utils/ai/assistant/matching-query-actions";
import {
  getMatchingQueryActions,
  toMatchingBulkAction,
} from "@/utils/ai/assistant/matching-query-actions";
import {
  type AutomaticUnsubscribeResult,
  unsubscribeSenderAndMark,
} from "@/utils/senders/unsubscribe";
import { getSenderUnsubscribeSource } from "@/utils/senders/source";
import {
  getCategorizationProgress,
  getCategorizationStatusSnapshot,
} from "@/utils/redis/categorization-progress";
import {
  extractErrorInfo as extractGmailErrorInfo,
  isRetryableError as isGmailRetryableError,
} from "@/utils/gmail/retry";
import { microsoftGraphPageTokenSchema } from "@/utils/outlook/page-token";
import { validateUserAndAiAccess } from "@/utils/user/validate";
import { SafeError } from "@/utils/error";
import { getEmailUrlForMessage } from "@/utils/url";
import {
  type OtherAccountResult,
  resolveEmailAccountForId,
  runOnOtherAccounts,
} from "@/utils/ai/assistant/chat-other-accounts";
import { toOtherAccountEmailId } from "@/utils/ai/assistant/other-account-email-id";
import { toSearchInboxModelValue } from "@/utils/ai/assistant/search-inbox-model-output";
import {
  type AccountSearch,
  translateAccountSearch,
} from "@/utils/ai/assistant/cross-provider-search";

const MAX_SENDER_CATEGORIZATION_WAIT_MS = 1500;
const recipientListSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (recipientList) => hasOnlyValidRecipients(recipientList),
    "must include valid email address(es)",
  );
const toRecipientFieldSchema = recipientListSchema.describe(
  'Recipient email list. Must include valid email addresses (for example "Name <person@domain.com>" or "person@domain.com"). If the user only gives a name, resolve the address first (for example using searchInbox).',
);
const ccRecipientFieldSchema = recipientListSchema
  .nullish()
  .describe(
    "CC recipients. Only include if the user explicitly asks to CC someone. Do not add CC on your own.",
  );
const bccRecipientFieldSchema = recipientListSchema
  .nullish()
  .describe(
    "BCC recipients. Only include if the user explicitly asks to BCC someone. Do not add BCC on your own.",
  );
const recipientFieldsSchema = {
  to: toRecipientFieldSchema,
  cc: ccRecipientFieldSchema,
  bcc: bccRecipientFieldSchema,
};
const sendEmailToolInputSchema = z
  .object({
    ...recipientFieldsSchema,
    subject: z.string().trim().min(1).max(300).describe("Email subject line."),
    messageHtml: z
      .string()
      .trim()
      .min(1)
      .describe("HTML body content for the email draft."),
  })
  .strict();
const replyEmailToolInputSchema = z
  .object({
    messageId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Message ID to reply to. Use a messageId returned by searchInbox.",
      ),
    content: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .describe("Reply body content to include in the draft."),
  })
  .strict();
const forwardEmailToolInputSchema = z
  .object({
    messageId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Message ID to forward. Use a messageId returned by searchInbox.",
      ),
    ...recipientFieldsSchema,
    content: z
      .string()
      .trim()
      .max(5000)
      .nullish()
      .describe("Optional note to add above the forwarded message."),
  })
  .strict();

type InboxToolOptions = {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
  /** The signed-in user, whose other accounts searchInbox may also search. */
  userId: string;
  /** The chat's browser, when it can answer searches from its local mail. */
  localMailSearch?: LocalMailSearch;
  /** The chat a manageInbox preview's Confirm button belongs to. */
  chatId?: string;
  /** Where the reply shows: only the web chat has confirm buttons. */
  responseSurface?: "web" | "messaging";
};

type ProviderToolFactory = (options: InboxToolOptions) => unknown;

function resolveProviderToolFactory<
  TFactories extends Record<string, ProviderToolFactory> & {
    google: ProviderToolFactory;
  },
>(provider: string, factories: TFactories): TFactories[keyof TFactories] {
  return (factories[provider] ??
    factories.google) as TFactories[keyof TFactories];
}

const outlookAccountOverviewTool = (options: InboxToolOptions) =>
  accountOverviewTool({
    ...options,
    taxonomyKey: "categories",
    description:
      "Get account context for inbox operations such as provider details, category context, meeting-brief settings, and attachment-filing folder settings.",
  });

const gmailAccountOverviewTool = (options: InboxToolOptions) =>
  accountOverviewTool({
    ...options,
    taxonomyKey: "labels",
    description:
      "Get account context for inbox operations such as provider details, label context, meeting-brief settings, and attachment-filing settings.",
  });

const accountOverviewTools = {
  google: gmailAccountOverviewTool,
  microsoft: outlookAccountOverviewTool,
};

export const getAccountOverviewTool = (options: InboxToolOptions) =>
  resolveProviderToolFactory(options.provider, accountOverviewTools)(options);

const accountOverviewTool = ({
  email,
  emailAccountId,
  provider,
  logger,
  taxonomyKey,
  description,
}: InboxToolOptions & {
  taxonomyKey: "categories" | "labels";
  description: string;
}) =>
  tool({
    description,
    inputSchema: z.object({}),
    execute: async () => {
      trackToolCall({ tool: "get_account_overview", email, logger });
      try {
        const [emailAccount, labelNames, connectedDrives] = await Promise.all([
          prisma.emailAccount.findUnique({
            where: { id: emailAccountId },
            select: {
              email: true,
              timezone: true,
              meetingBriefingsEnabled: true,
              meetingBriefingsMinutesBefore: true,
              meetingBriefsSendEmail: true,
              filingEnabled: true,
              filingPrompt: true,
              filingFolders: {
                select: {
                  folderName: true,
                  folderPath: true,
                },
                take: 50,
              },
            },
          }),
          listLabelNames({
            emailAccountId,
            provider,
            logger,
          }),
          prisma.driveConnection.count({
            where: ownedBySameUser(emailAccountId),
          }),
        ]);

        if (!emailAccount) {
          return { error: "Email account not found" };
        }

        return {
          account: {
            email: emailAccount.email,
            provider,
            timezone: emailAccount.timezone,
          },
          meetingBriefs: {
            enabled: emailAccount.meetingBriefingsEnabled,
            minutesBefore: emailAccount.meetingBriefingsMinutesBefore,
            sendEmail: emailAccount.meetingBriefsSendEmail,
          },
          attachmentFiling: {
            enabled: emailAccount.filingEnabled,
            promptConfigured: Boolean(emailAccount.filingPrompt),
            driveConnected: connectedDrives > 0,
            folders: emailAccount.filingFolders.map((folder) => ({
              name: folder.folderName,
              path: folder.folderPath,
            })),
          },
          [taxonomyKey]: {
            count: labelNames.length,
            names: labelNames.slice(0, 200),
          },
        };
      } catch (error) {
        logger.error("Failed to load account overview", { error });
        return {
          error: "Failed to load account overview",
        };
      }
    },
  });

export type GetAccountOverviewTool = InferUITool<
  ReturnType<typeof getAccountOverviewTool>
>;

const getSenderCategorizationStatusInputSchema = z.object({
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_SENDER_CATEGORIZATION_WAIT_MS)
    .default(0)
    .describe(
      "Optional server-side wait before reading progress. Use for short bounded polling only.",
    ),
});

const manageSenderCategoryInputSchema = z
  .object({
    action: z
      .literal("archive_category")
      .describe("Category cleanup action. Only archive_category is supported."),
    categoryId: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe(
        "Exact category ID from getSenderCategoryOverview. Prefer this when available.",
      ),
    categoryName: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe(
        'Exact category name from getSenderCategoryOverview. Supports the special name "Uncategorized".',
      ),
  })
  .refine((value) => Boolean(value.categoryId || value.categoryName), {
    message: "categoryId or categoryName is required",
  });

export const getSenderCategoryOverviewTool = ({
  email,
  emailAccountId,
  logger,
}: {
  email: string;
  emailAccountId: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Inspect sender categories for the current account. Returns exact category names, sender counts, sample senders, uncategorized sender count, and current categorization progress. Use this before any category-based cleanup, and prefer it over searchInbox when the user asks to clean up by category. If the user only wants the threads already shown or a small explicit set of emails, stay with searchInbox and manageInbox instead.",
    inputSchema: z.object({}),
    execute: async () => {
      trackToolCall({ tool: "get_sender_category_overview", email, logger });

      try {
        return await getCategoryOverview({ emailAccountId });
      } catch (error) {
        logger.error("Failed to load sender category overview", { error });
        return {
          error: "Failed to load sender category overview",
        };
      }
    },
  });

export type GetSenderCategoryOverviewTool = InferUITool<
  ReturnType<typeof getSenderCategoryOverviewTool>
>;

export const startSenderCategorizationTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Start sender categorization for the current account. This creates default categories if needed, enables automatic sender categorization, queues uncategorized senders for AI categorization, and returns current progress. Use this only when category cleanup is needed and getSenderCategoryOverview shows category coverage is not ready. After starting, poll getSenderCategorizationStatus only briefly before deciding whether cleanup can continue. Safe to call again: if a run is already active, it returns the existing run instead of starting a duplicate job.",
    inputSchema: z.object({}),
    execute: async () => {
      trackToolCall({ tool: "start_sender_categorization", email, logger });

      try {
        await validateUserAndAiAccess({ emailAccountId });

        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });

        return await startBulkCategorization({
          emailAccountId,
          emailProvider,
          logger,
        });
      } catch (error) {
        if (error instanceof SafeError) {
          logger.warn("Unable to start sender categorization", { error });
          return { error: error.message };
        }

        logger.error("Failed to start sender categorization", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to start sender categorization",
        };
      }
    },
  });

export type StartSenderCategorizationTool = InferUITool<
  ReturnType<typeof startSenderCategorizationTool>
>;

export const getSenderCategorizationStatusTool = ({
  email,
  emailAccountId,
  logger,
}: {
  email: string;
  emailAccountId: string;
  logger: Logger;
}) =>
  tool({
    description: `Check sender categorization progress. Use this after startSenderCategorization to show progress in chat or to poll briefly before deciding whether category cleanup can continue. Keep polling bounded to short waits only, with at most 3 polls and waitMs no higher than ${MAX_SENDER_CATEGORIZATION_WAIT_MS} per poll. If categorization is still running after that bounded polling, stop and report the progress instead of falling back to manual searchInbox pagination. waitMs optionally delays the read server-side. This does not change inbox state.`,
    inputSchema: getSenderCategorizationStatusInputSchema,
    execute: async ({ waitMs }) => {
      trackToolCall({
        tool: "get_sender_categorization_status",
        email,
        logger,
      });

      try {
        const boundedWaitMs = Math.min(
          waitMs,
          MAX_SENDER_CATEGORIZATION_WAIT_MS,
        );

        if (boundedWaitMs > 0) {
          await sleep(boundedWaitMs);
        }

        const progress = await getCategorizationProgress({ emailAccountId });
        return getCategorizationStatusSnapshot(progress);
      } catch (error) {
        logger.error("Failed to load sender categorization status", { error });
        return {
          error: "Failed to load sender categorization status",
        };
      }
    },
  });

export type GetSenderCategorizationStatusTool = InferUITool<
  ReturnType<typeof getSenderCategorizationStatusTool>
>;

export const manageSenderCategoryTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      'Archive all mail from senders currently assigned to one sender category. Use this only after getSenderCategoryOverview confirmed the exact category ID or exact category name the user wants. Prefer categoryId when available. Supports the special category name "Uncategorized". If the requested category name does not exactly exist, do not guess; list the available category names and ask a brief clarification question instead. Do not use this for thread-level cleanup or arbitrary search results; use manageInbox instead.',
    inputSchema: manageSenderCategoryInputSchema,
    execute: async ({ categoryId, categoryName }) => {
      trackToolCall({ tool: "manage_sender_category", email, logger });

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });

        return await archiveCategory({
          email,
          emailAccountId,
          emailProvider,
          logger,
          categoryId,
          categoryName,
        });
      } catch (error) {
        logger.error("Failed to manage sender category", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to manage sender category",
        };
      }
    },
  });

export type ManageSenderCategoryTool = InferUITool<
  ReturnType<typeof manageSenderCategoryTool>
>;

const searchInboxBaseFields = {
  limit: z
    .number()
    .int()
    .default(SEARCH_INBOX_MAX_RESULTS)
    .transform((value) =>
      Math.min(Math.max(value, 1), SEARCH_INBOX_MAX_RESULTS),
    )
    .describe(
      `Maximum number of messages to return, up to ${SEARCH_INBOX_MAX_RESULTS}. Larger values are clamped; use pagination for more results.`,
    ),
  pageToken: microsoftGraphPageTokenSchema.describe(
    "Use the page token returned from a prior search to paginate.",
  ),
  allAccounts: z
    .boolean()
    .nullish()
    .describe(
      "Optional. Set to true to also search the user's other connected email accounts, such as when the user asks about all their accounts or the email may be in another one. Every message then names its account. Other accounts return only their first few matches, and their emails can be read but not acted on from this chat.",
    ),
};

const gmailSearchInboxInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "Gmail search query. Gmail search syntax is supported. Use from:person@example.com for an exact sender search. Dates: after:YYYY/MM/DD, before:YYYY/MM/DD; relative: newer_than:2d, older_than:1y.",
    ),
  ...searchInboxBaseFields,
});

const outlookSearchInboxInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(500)
      .default("")
      .describe(
        "Outlook search for a sender name or brand, recipient, subject, message content, or date/age filters. Use to:person@example.com for an exact recipient. Do not put an exact sender address, mailbox category, folder, mail class, or read/unread state here.",
      ),
    ...searchInboxBaseFields,
    fromEmail: z
      .string()
      .trim()
      .refine(isValidEmail, "Invalid email address")
      .nullish()
      .describe(
        "Exact sender email address. Use this instead of query when the sender address is known.",
      ),
    readState: z
      .enum(["read", "unread"])
      .nullish()
      .describe(
        "Structured read-state filter. For mark-as-read requests use unread; for mark-as-unread requests use read.",
      ),
    categoryName: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe(
        "Exact Outlook category name or category ID. Filters by category membership; use folderName for mail folders.",
      ),
    folderName: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe(
        "Exact Outlook mail folder name, folder path, or folder ID from listFolders. Filters messages in that folder, independently of categories. Use a path or ID when folder names are ambiguous.",
      ),
  })
  .refine(
    (value) =>
      Boolean(
        value.query ||
          value.fromEmail ||
          value.readState ||
          value.categoryName ||
          value.folderName,
      ),
    {
      message:
        "query, fromEmail, readState, categoryName, or folderName is required",
    },
  );

type GmailSearchInboxInput = z.infer<typeof gmailSearchInboxInputSchema>;
type OutlookSearchInboxInput = z.infer<typeof outlookSearchInboxInputSchema>;

const gmailSearchInboxTool = (options: InboxToolOptions) =>
  tool({
    description:
      "Search inbox messages and return concise message metadata. Returns at most 20 messages per call. If hasMore=true, more matches remain; call again with nextPageToken for the next page. To count matches use countEmails, and to act on every match use manageInbox with query, rather than paging through them. totalReturned is only the number of messages returned by this call, so do not present it or a single search page as an exact mailbox, folder, or label count. If the tool returns an error or provider search feedback instead of messages, treat the lookup as inconclusive rather than evidence that the email is absent.",
    inputSchema: gmailSearchInboxInputSchema,
    execute: async (input, callOptions) => {
      const { email, logger } = options;
      trackToolCall({ tool: "search_inbox", email, logger });

      const otherAccounts = startOtherAccountSearch({
        options,
        input,
        abortSignal: callOptions?.abortSignal,
      });
      return withOtherAccountResults({
        result: await searchGmailChatAccount({ options, input }),
        chatEmail: email,
        otherAccounts,
      });
    },
    toModelOutput: searchInboxModelOutput,
  });

const outlookSearchInboxTool = (options: InboxToolOptions) =>
  tool({
    description:
      "Search inbox messages and return concise message metadata. Returns at most 20 messages per call. If hasMore=true, more matches remain; call again with nextPageToken for the next page, even when the current page has zero messages. To count matches use countEmails, and to act on every match use manageInbox with query, rather than paging through them. Outlook filtered searches can return an empty page before later matching pages. For folder/category count questions, use only folderName/categoryName with no query or other filters and report exactCount, the full-scope message count including drafts. If countError is returned, the exact total is unavailable. totalReturned is only this page size and is never an exact mailbox, folder, or category total. If the tool returns an error or provider search feedback instead of messages, treat the lookup as inconclusive rather than evidence that the email is absent.",
    inputSchema: outlookSearchInboxInputSchema,
    execute: async (input, callOptions) => {
      const { email, logger } = options;
      trackToolCall({ tool: "search_inbox", email, logger });

      const otherAccounts = startOtherAccountSearch({
        options,
        input,
        abortSignal: callOptions?.abortSignal,
      });
      return withOtherAccountResults({
        result: await searchOutlookChatAccount({ options, input }),
        chatEmail: email,
        otherAccounts,
      });
    },
    toModelOutput: searchInboxModelOutput,
  });

const searchInboxTools = {
  google: gmailSearchInboxTool,
  microsoft: outlookSearchInboxTool,
};

export const searchInboxTool = (options: InboxToolOptions) =>
  resolveProviderToolFactory(options.provider, searchInboxTools)(options);

export type SearchInboxTool = InferUITool<ReturnType<typeof searchInboxTool>>;

const readEmailInputSchema = z.object({
  messageId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The message ID to read. Use a messageId returned by searchInbox.",
    ),
});

export const readEmailTool = ({
  email,
  emailAccountId,
  userId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  /** The signed-in user, whose other accounts' emails it may also read. */
  userId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Read the full content of an email by message ID, up to 4000 characters with HTML converted to plain text. Use this whenever the user asks for the full text, body, or details of a specific email: locate the email with searchInbox first, then call this with the messageId from the search results. Search results only include short snippets, not the full content.",
    inputSchema: readEmailInputSchema,
    execute: async ({ messageId }) => {
      trackToolCall({ tool: "read_email", email, logger });

      let target: Awaited<ReturnType<typeof resolveEmailAccountForId>> = null;
      try {
        target = await resolveEmailAccountForId({
          id: messageId,
          userId,
          emailAccountId,
          provider,
        });
        if (!target) return { error: OTHER_ACCOUNT_EMAIL_NOT_FOUND };

        const emailProvider = await createEmailProvider({
          emailAccountId: target.emailAccountId,
          provider: target.provider,
          logger,
        });

        const message = await emailProvider.getMessage(target.id);
        const emailForLLM = getEmailForLLM(message, { maxLength: 4000 });

        return {
          ...(target.otherAccount
            ? {
                ...otherAccountEmailFields(target.otherAccount, message),
                // Its link opens in this provider, not the chat's.
                provider: target.provider,
              }
            : {
                messageId: message.id,
                threadId: message.threadId,
                externalUrl: message.externalUrl,
              }),
          from: emailForLLM.from,
          to: emailForLLM.to,
          cc: emailForLLM.cc,
          replyTo: emailForLLM.replyTo,
          subject: emailForLLM.subject,
          content: emailForLLM.content,
          date: emailForLLM.date?.toISOString() ?? message.date,
          attachments: emailForLLM.attachments,
        };
      } catch (error) {
        logger.error("Failed to read email", { error });
        return {
          error:
            describeProviderRateLimitError(
              error,
              target?.provider ?? provider,
            ) ?? "Failed to read email",
        };
      }
    },
  });

export type ReadEmailTool = InferUITool<ReturnType<typeof readEmailTool>>;

const readAttachmentInputSchema = z.object({
  messageId: z
    .string()
    .describe(
      "The message ID containing the attachment (from readEmail results)",
    ),
  attachmentId: z
    .string()
    .describe("The attachment ID from readEmail attachment metadata"),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type from readEmail attachment metadata"),
  filename: z
    .string()
    .optional()
    .describe("Filename from readEmail attachment metadata"),
});

export const readAttachmentTool = ({
  email,
  emailAccountId,
  userId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  /** The signed-in user, whose other accounts' attachments it may also read. */
  userId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Read the text content of an email attachment. First call readEmail for the message and use its attachment metadata; do not guess attachment IDs. Supports PDF, DOCX, plain text, CSV, and HTML. Returns metadata only for binary files (images, etc.).",
    inputSchema: readAttachmentInputSchema,
    execute: async ({
      messageId,
      attachmentId,
      mimeType: inputMimeType,
      filename: inputFilename,
    }) => {
      trackToolCall({ tool: "read_attachment", email, logger });

      let target: Awaited<ReturnType<typeof resolveEmailAccountForId>> = null;
      try {
        target = await resolveEmailAccountForId({
          id: messageId,
          userId,
          emailAccountId,
          provider,
        });
        if (!target) return { error: OTHER_ACCOUNT_EMAIL_NOT_FOUND };

        const emailProvider = await createEmailProvider({
          emailAccountId: target.emailAccountId,
          provider: target.provider,
          logger,
        });

        let resolvedMimeType = inputMimeType;
        let resolvedFilename = inputFilename;

        if (!resolvedMimeType || !resolvedFilename) {
          try {
            const message = await emailProvider.getMessage(target.id);
            const matchedAttachment = message.attachments?.find(
              (attachment) => attachment.attachmentId === attachmentId,
            );

            resolvedMimeType ??= matchedAttachment?.mimeType ?? undefined;
            resolvedFilename ??= matchedAttachment?.filename ?? undefined;
          } catch (error) {
            logger.warn("Failed to load attachment metadata from message", {
              error,
            });
          }
        }

        resolvedMimeType ??= "application/octet-stream";
        resolvedFilename ??= "unknown";

        if (!isExtractableMimeType(resolvedMimeType)) {
          return {
            filename: resolvedFilename,
            mimeType: resolvedMimeType,
            contentAvailable: false,
            message:
              "This attachment type cannot be read as text. Only PDF, DOCX, plain text, CSV, and HTML are supported.",
          };
        }

        const attachment = await emailProvider.getAttachment(
          target.id,
          attachmentId,
        );

        const buffer = Buffer.from(attachment.data, "base64");

        const extracted = await extractAttachmentText(
          buffer,
          resolvedMimeType,
          logger,
        );

        if (!extracted) {
          return {
            filename: resolvedFilename,
            mimeType: resolvedMimeType,
            size: attachment.size,
            contentAvailable: false,
            message: "Failed to extract text from this attachment.",
          };
        }

        return {
          filename: resolvedFilename,
          mimeType: resolvedMimeType,
          size: attachment.size,
          contentAvailable: true,
          content: extracted.text,
          truncated: extracted.truncated,
        };
      } catch (error) {
        logger.error("Failed to read attachment", { error });
        return {
          error:
            describeProviderRateLimitError(
              error,
              target?.provider ?? provider,
            ) ?? "Failed to read attachment",
        };
      }
    },
  });

export type ReadAttachmentTool = InferUITool<
  ReturnType<typeof readAttachmentTool>
>;

const threadIdsSchema = z
  .array(z.string())
  .min(1)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

const senderEmailsSchema = z
  .array(z.string().trim().min(3))
  .min(1)
  .max(100)
  .transform((emails) => [...new Set(emails)]);

const matchingQuerySchema = z.string().trim().min(1).max(500).optional();

const outlookManageInboxActions = [
  "archive_threads",
  "trash_threads",
  "categorize_threads",
  "remove_category_threads",
  "mark_read_threads",
  "bulk_archive_senders",
  "unsubscribe_senders",
] as const;

const outlookManageInboxInputSchema = z
  .strictObject({
    action: z
      .enum(outlookManageInboxActions)
      .describe(
        "Outlook inbox action. archive_threads archives selected threads; trash_threads moves selected threads to trash; categorize_threads applies an existing category; remove_category_threads removes one; mark_read_threads sets read state; bulk_archive_senders archives all mail from senders; unsubscribe_senders unsubscribes and archives.",
      ),
    threadIds: threadIdsSchema
      .optional()
      .describe(
        "Required for thread actions unless query is set. Use IDs from searchInbox results or IDs the user already provided; omit for sender-wide actions.",
      ),
    query: matchingQuerySchema.describe(
      "Instead of threadIds, an Outlook search in searchInbox's query syntax, with an exact sender written as from:person@example.com: archive_threads, mark_read_threads or categorize_threads then applies to every email it matches. This changes nothing: it returns how many conversations would change, and the user starts the change with the Confirm button on the result. Tell them the count; calling again does not start it.",
    ),
    categoryName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Exact Outlook category name. Required for categorize_threads and remove_category_threads; optional for archive_threads; omit for other actions.",
      ),
    read: z
      .boolean()
      .optional()
      .describe(
        "Required for mark_read_threads: true marks read and false marks unread. Omit for other actions.",
      ),
    fromEmails: senderEmailsSchema
      .optional()
      .describe(
        "Required for bulk_archive_senders and unsubscribe_senders. These actions affect all mail from each sender; omit for thread actions.",
      ),
  })
  .superRefine((input, context) =>
    validateManageInboxInput(input, context, {
      taxonomyField: "categoryName",
      taxonomyActions: ["categorize_threads", "remove_category_threads"],
      queryActions: getMatchingQueryActions("microsoft"),
    }),
  )
  .describe("Outlook inbox action input.");

const gmailManageInboxInputSchema = z
  .strictObject({
    action: z
      .enum(manageInboxActions)
      .describe(
        "Gmail inbox action. archive_threads archives selected threads; trash_threads moves selected threads to trash; label_threads applies an existing label; remove_label_threads removes one; mark_read_threads sets read state; bulk_archive_senders archives all mail from senders; unsubscribe_senders unsubscribes and archives.",
      ),
    threadIds: threadIdsSchema
      .optional()
      .describe(
        "Required for thread actions unless query is set. Use IDs from searchInbox results or IDs the user already provided; omit for sender-wide actions.",
      ),
    query: matchingQuerySchema.describe(
      "Instead of threadIds, a Gmail search in searchInbox's syntax: archive_threads, mark_read_threads or label_threads then applies to every email it matches. This changes nothing: it returns how many conversations would change, and the user starts the change with the Confirm button on the result. Tell them the count; calling again does not start it.",
    ),
    labelName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Exact Gmail label name. Required for label_threads and remove_label_threads; optional for archive_threads; omit for other actions.",
      ),
    read: z
      .boolean()
      .optional()
      .describe(
        "Required for mark_read_threads: true marks read and false marks unread. Omit for other actions.",
      ),
    fromEmails: senderEmailsSchema
      .optional()
      .describe(
        "Required for bulk_archive_senders and unsubscribe_senders. These actions affect all mail from each sender; omit for thread actions.",
      ),
  })
  .superRefine((input, context) =>
    validateManageInboxInput(input, context, {
      taxonomyField: "labelName",
      taxonomyActions: ["label_threads", "remove_label_threads"],
      queryActions: getMatchingQueryActions("google"),
    }),
  )
  .describe("Gmail inbox action input.");

type ManageInboxTaxonomyConfig = {
  labelResolutionFallbackError: string;
  missingLabelError: (name: string, action: ManageInboxAction) => string;
  resultKeys: {
    id: "categoryId" | "labelId";
    name: "categoryName" | "labelName";
  };
};

const outlookManageInboxTool = (options: InboxToolOptions) =>
  buildManageInboxTool({
    options,
    inputSchema: outlookManageInboxInputSchema,
    normalizeInput: normalizeOutlookManageInboxInput,
    taxonomy: {
      labelResolutionFallbackError: "Failed to resolve category",
      missingLabelError: (name, action) =>
        action === "remove_label_threads"
          ? `Category "${name}" does not exist, so no category was removed.`
          : `Category "${name}" does not exist. Use createOrGetCategory first if you want to create it.`,
      resultKeys: {
        id: "categoryId",
        name: "categoryName",
      },
    },
  });

const gmailManageInboxTool = (options: InboxToolOptions) =>
  buildManageInboxTool({
    options,
    inputSchema: gmailManageInboxInputSchema,
    normalizeInput: normalizeGmailManageInboxInput,
    taxonomy: {
      labelResolutionFallbackError: "Failed to resolve label",
      missingLabelError: (name, action) =>
        action === "remove_label_threads"
          ? `Label "${name}" does not exist, so no label was removed.`
          : `Label "${name}" does not exist. Use createOrGetLabel first if you want to create it.`,
      resultKeys: {
        id: "labelId",
        name: "labelName",
      },
    },
  });

const manageInboxTools = {
  google: gmailManageInboxTool,
  microsoft: outlookManageInboxTool,
};

export const manageInboxTool = (options: InboxToolOptions) =>
  resolveProviderToolFactory(options.provider, manageInboxTools)(options);

const buildManageInboxTool = ({
  options,
  inputSchema,
  normalizeInput,
  taxonomy,
}: {
  options: InboxToolOptions;
  inputSchema: z.ZodType;
  normalizeInput: (
    input: Record<string, unknown>,
  ) => NormalizedManageInboxInput;
  taxonomy: ManageInboxTaxonomyConfig;
}) => {
  const { email, emailAccountId, provider, logger } = options;

  return tool({
    description:
      "Run inbox actions on threads or senders. For emails already shown or found in this turn, prefer thread actions with threadIds. To act on everything a search matches, use query instead of collecting threadIds page by page. Use archive_threads for ordinary inbox cleanup; only use trash_threads when the user explicitly asks to delete or trash. Do not widen a limited thread-level request into sender-wide cleanup. Only use sender-wide cleanup with fromEmails when the user clearly wants all mail from that sender, and get confirmation before doing broad sender-wide cleanup. Only use unsubscribe_senders for an explicit unsubscribe request.",
    inputSchema,
    toModelOutput: manageInboxModelOutput,
    execute: async (input, callOptions) => {
      trackToolCall({ tool: "manage_inbox", email, logger });

      const parsedInputResult = inputSchema.safeParse(input);
      if (!parsedInputResult.success) {
        const errorMessage = getManageInboxValidationError(
          parsedInputResult.error,
        );
        logger.warn("Invalid manageInbox input", {
          issues: parsedInputResult.error.issues,
        });
        return { error: errorMessage };
      }

      const parsedInput = normalizeInput(
        parsedInputResult.data as Record<string, unknown>,
      );
      const { action, labelName, originalAction } = parsedInput;
      const isSenderAction = requiresSenderEmails(action);

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });

        if (isSenderAction) {
          const normalizedFromEmails = normalizeSenderEmails(
            parsedInput.fromEmails ?? [],
          );
          if (!normalizedFromEmails.length) {
            return {
              error:
                'No sender-level action was taken. "fromEmails" is required for bulk_archive_senders and unsubscribe_senders. If you only meant the emails already shown, use archive_threads with threadIds instead.',
            };
          }

          if (action === "unsubscribe_senders") {
            const unsubscribeResults = await runSenderUnsubscribeActions({
              fromEmails: normalizedFromEmails,
              emailProvider,
              emailAccountId,
              logger,
            });
            const successfulSenders = unsubscribeResults
              .filter((result) => result.success)
              .map((result) => result.senderEmail);
            const failedSenders = unsubscribeResults
              .filter((result) => !result.success)
              .map((result) => result.senderEmail);
            const successCount = successfulSenders.length;
            const autoUnsubscribeCount = unsubscribeResults.filter(
              (result) => result.success && result.unsubscribe.success,
            ).length;
            const autoUnsubscribeAttemptedCount = unsubscribeResults.filter(
              (result) => result.unsubscribe.attempted,
            ).length;

            await emailProvider.bulkArchiveFromSenders(
              normalizedFromEmails,
              email,
              emailAccountId,
            );

            return {
              success: failedSenders.length === 0,
              action: originalAction,
              sendersCount: normalizedFromEmails.length,
              senders: normalizedFromEmails,
              successCount,
              failedCount: failedSenders.length,
              failedSenders,
              autoUnsubscribeCount,
              autoUnsubscribeAttemptedCount,
            };
          }

          await emailProvider.bulkArchiveFromSenders(
            normalizedFromEmails,
            email,
            emailAccountId,
          );

          return {
            success: true,
            action: originalAction,
            sendersCount: normalizedFromEmails.length,
            senders: normalizedFromEmails,
          };
        }

        if (parsedInput.query) {
          return await runManageInboxQuery({
            parsedInput: { ...parsedInput, query: parsedInput.query },
            emailProvider,
            emailAccountId,
            provider,
            taxonomy,
            // Only the web chat shows the card a confirmation is pressed on.
            confirmation:
              options.responseSurface === "web" &&
              options.chatId &&
              callOptions?.toolCallId
                ? { chatId: options.chatId, toolCallId: callOptions.toolCallId }
                : undefined,
            abortSignal: callOptions?.abortSignal,
            logger,
          });
        }

        const threadIds = parsedInput.threadIds!;

        const resolvedArchiveLabel =
          action === "archive_threads"
            ? await resolveLabelNameAndId({ emailProvider, label: labelName })
            : null;
        const resolvedArchiveLabelId =
          resolvedArchiveLabel?.labelId ?? undefined;
        let resolvedThreadLabel: Awaited<
          ReturnType<typeof resolveThreadLabel>
        > | null = null;

        if (isThreadLabelAction(action)) {
          try {
            resolvedThreadLabel = await resolveThreadLabel({
              emailProvider,
              labelName: labelName!,
              action,
              matchNestedLabels: isGoogleProvider(provider),
              missingLabelError: taxonomy.missingLabelError,
            });
          } catch (error) {
            logger.warn("Failed to resolve label for thread action", {
              error,
              labelName,
            });
            return hideToolErrorFromUser({
              error:
                error instanceof Error
                  ? error.message
                  : taxonomy.labelResolutionFallbackError,
            });
          }
        }

        const threadActionResults = await runThreadActionsInParallel({
          threadIds,
          concurrency: THREAD_ACTION_CONCURRENCY,
          runAction: async (threadId) => {
            if (action === "archive_threads") {
              await emailProvider.archiveThreadWithLabel(
                threadId,
                email,
                resolvedArchiveLabelId,
              );
            } else if (action === "trash_threads") {
              await emailProvider.trashThread(threadId, email, "user");
            } else if (action === "label_threads") {
              await applyLabelToThread({
                emailProvider,
                threadId,
                labelId: resolvedThreadLabel!.labelId,
                labelName: resolvedThreadLabel!.labelName,
              });
            } else if (action === "remove_label_threads") {
              await emailProvider.removeThreadLabel(
                threadId,
                resolvedThreadLabel!.labelId,
              );
            } else {
              await emailProvider.markReadThread(
                threadId,
                parsedInput.read ?? true,
              );
            }
          },
        });

        const failedThreadIds = threadActionResults
          .filter((result) => !result.success)
          .map((result) => result.threadId);
        const successCount =
          threadActionResults.length - failedThreadIds.length;

        return {
          success: failedThreadIds.length === 0,
          action: originalAction,
          requestedCount: threadIds.length,
          successCount,
          failedCount: failedThreadIds.length,
          failedThreadIds,
          ...(resolvedThreadLabel && {
            [taxonomy.resultKeys.id]: resolvedThreadLabel.labelId,
            [taxonomy.resultKeys.name]: resolvedThreadLabel.labelName,
          }),
        };
      } catch (error) {
        logger.error("Failed to run inbox action", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to update emails",
        };
      }
    },
  });
};

export type ManageInboxTool = InferUITool<ReturnType<typeof manageInboxTool>>;

export const sendEmailTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Prepare a new email to send. This does NOT send immediately — it returns a confirmation payload for the user to approve.",
    inputSchema: sendEmailToolInputSchema,
    execute: async (input) => {
      trackToolCall({ tool: "send_email", email, logger });

      const parsedInput = sendEmailToolInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return { error: getSendEmailValidationError(parsedInput.error) };
      }

      try {
        const from =
          (await getFormattedSenderAddress({
            emailAccountId,
            fallbackEmail: email,
          })) || email;
        return createPendingSendEmailOutput(
          parsedInput.data,
          from || null,
          provider,
          emailAccountId,
        );
      } catch (error) {
        logger.error("Failed to prepare email from chat", { error });
        return { error: "Failed to prepare email" };
      }
    },
  });

export type SendEmailTool = InferUITool<ReturnType<typeof sendEmailTool>>;

export const replyEmailTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Prepare a reply to an existing email by message ID. This does NOT send immediately — it returns a confirmation payload for the user to approve. Use the language of the email being replied to (new body, not quoted history), not the chat language, unless the user explicitly requests another language. Do not recreate replies with sendEmail.",
    inputSchema: replyEmailToolInputSchema,
    execute: async (input) => {
      trackToolCall({ tool: "reply_email", email, logger });

      const parsedInput = replyEmailToolInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return { error: getReplyEmailValidationError(parsedInput.error) };
      }

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        const message = await emailProvider.getMessage(
          parsedInput.data.messageId,
        );

        return createPendingReplyEmailOutput(
          parsedInput.data,
          message,
          emailAccountId,
        );
      } catch (error) {
        logger.error("Failed to prepare reply from chat", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to prepare reply",
        };
      }
    },
  });

export type ReplyEmailTool = InferUITool<ReturnType<typeof replyEmailTool>>;

export const forwardEmailTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Prepare a forward for an existing email by message ID. This does NOT send immediately — it returns a confirmation payload for the user to approve. Use the forwarded email's language (new body, not quoted history) for any added note, not the chat language, unless the user explicitly requests another language. Do not recreate forwards with sendEmail.",
    inputSchema: forwardEmailToolInputSchema,
    execute: async (input) => {
      trackToolCall({ tool: "forward_email", email, logger });

      const parsedInput = forwardEmailToolInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return { error: getForwardEmailValidationError(parsedInput.error) };
      }

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        const message = await emailProvider.getMessage(
          parsedInput.data.messageId,
        );
        return createPendingForwardEmailOutput(
          parsedInput.data,
          message,
          emailAccountId,
        );
      } catch (error) {
        logger.error("Failed to prepare email forward from chat", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to prepare email forward",
        };
      }
    },
  });

export type ForwardEmailTool = InferUITool<ReturnType<typeof forwardEmailTool>>;

async function trackToolCall({
  tool,
  email,
  logger,
}: {
  tool: string;
  email: string;
  logger: Logger;
}) {
  logger.info("Tracking tool call", { tool, email });
  return posthogCaptureEvent(email, "AI Assistant Chat Tool Call", { tool });
}

async function listLabelNames({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  try {
    const emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    const labels = await emailProvider.getLabels();
    return labels.map((label) => label.name).filter(Boolean);
  } catch (error) {
    logger.warn("Failed to load label names", { error });
    return [];
  }
}

type PendingEmailActionType = "send_email" | "reply_email" | "forward_email";

function createPendingSendEmailOutput(
  input: z.infer<typeof sendEmailToolInputSchema>,
  from: string | null,
  provider: string,
  emailAccountId: string,
) {
  return {
    success: true,
    emailAccountId,
    actionType: "send_email" as PendingEmailActionType,
    requiresConfirmation: true,
    confirmationState: "pending" as const,
    provider,
    pendingAction: {
      to: input.to,
      cc: input.cc || null,
      bcc: input.bcc || null,
      subject: input.subject,
      messageHtml: input.messageHtml,
      from,
    },
  };
}

function createPendingReplyEmailOutput(
  input: z.infer<typeof replyEmailToolInputSchema>,
  message: ParsedMessage,
  emailAccountId: string,
) {
  return {
    success: true,
    emailAccountId,
    actionType: "reply_email" as PendingEmailActionType,
    requiresConfirmation: true,
    confirmationState: "pending" as const,
    pendingAction: {
      messageId: input.messageId,
      content: input.content,
    },
    reference: {
      messageId: message.id,
      threadId: message.threadId,
      from: message.headers.from,
      subject: message.subject || message.headers.subject,
    },
  };
}

function createPendingForwardEmailOutput(
  input: z.infer<typeof forwardEmailToolInputSchema>,
  message: ParsedMessage,
  emailAccountId: string,
) {
  return {
    success: true,
    emailAccountId,
    actionType: "forward_email" as PendingEmailActionType,
    requiresConfirmation: true,
    confirmationState: "pending" as const,
    pendingAction: {
      messageId: input.messageId,
      to: input.to,
      cc: input.cc || null,
      bcc: input.bcc || null,
      content: input.content || null,
    },
    reference: {
      messageId: message.id,
      threadId: message.threadId,
      from: message.headers.from,
      subject: message.subject || message.headers.subject,
    },
  };
}

async function getLabelsForSearchResults({
  emailProvider,
  logger,
}: {
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  return emailProvider.getLabels().catch((error) => {
    logger.warn("Failed to load labels for search results", { error });
    return [] as Array<{ id: string; name: string }>;
  });
}

type SearchResultSource = {
  id: string;
  threadId: string;
  externalUrl?: string;
  subject: string;
  from: string;
  to: string;
  snippet: string;
  date: string;
  labelIds: string[];
  hasAttachments: boolean;
};

type SearchMessagesResult = {
  messages: SearchResultSource[];
  nextPageToken?: string;
  unloadedMessages?: number;
};

function localPageUnavailable(query: string) {
  return {
    queryUsed: query,
    error:
      "The next page of this search is no longer available; run the search again without pageToken.",
    searchFeedback: {
      message: "Local search page unavailable",
      retryable: true,
    },
  };
}

/**
 * The messages the browser's local store matched, read from the provider in
 * its order: only their ids came back through Redis (RD-3).
 */
async function readLocalMatches(
  emailProvider: EmailProvider,
  local: LocalMailSearchAnswer,
) {
  if (!local.messages.length) return [];
  const byId = new Map(
    (await emailProvider.getMessagesBatch(local.messages.map((m) => m.id))).map(
      (message) => [message.id, message],
    ),
  );
  return local.messages.flatMap(({ id }) => {
    const message = byId.get(id);
    return message ? [searchSourceFromMessage(message)] : [];
  });
}

function searchSourceFromMessage(message: ParsedMessage): SearchResultSource {
  return {
    id: message.id,
    threadId: message.threadId,
    externalUrl: message.externalUrl,
    subject: message.subject,
    from: message.headers.from,
    to: message.headers.to,
    snippet: message.snippet,
    date: message.date,
    labelIds: message.labelIds || [],
    hasAttachments: Boolean(message.attachments?.length),
  };
}

function formatSearchInboxResult({
  searchResult,
  queryUsed,
  labels,
  taxonomyNamesKey,
}: {
  searchResult: SearchMessagesResult;
  queryUsed: string;
  labels: Array<{ id: string; name: string }>;
  taxonomyNamesKey: "categoryNames" | "labelNames";
}) {
  const labelsById = createLabelLookupMap(labels);
  const items = searchResult.messages.map((message) =>
    mapMessageForSearchResult(message, labelsById, taxonomyNamesKey),
  );

  return {
    queryUsed,
    totalReturned: items.length,
    nextPageToken: searchResult.nextPageToken,
    hasMore: Boolean(searchResult.nextPageToken),
    ...(searchResult.unloadedMessages
      ? { incomplete: { unloadedMessages: searchResult.unloadedMessages } }
      : {}),
    summary: summarizeSearchResults(items),
    messages: items,
  };
}

function mapMessageForSearchResult(
  message: SearchResultSource,
  labelsById: Map<string, string>,
  taxonomyNamesKey: "categoryNames" | "labelNames",
) {
  const labelIds = message.labelIds;
  const labelNames = labelIds.map(
    (labelId) => labelsById.get(labelId.toLowerCase()) || labelId,
  );
  const category = inferConversationCategory(labelNames);
  const isUnread = labelIds.some(
    (labelId) => labelId.toLowerCase() === "unread",
  );

  return {
    messageId: message.id,
    threadId: message.threadId,
    externalUrl: message.externalUrl,
    subject: message.subject,
    from: message.from,
    to: message.to,
    snippet: message.snippet,
    date: message.date,
    [taxonomyNamesKey]: labelNames,
    category,
    isUnread,
    hasAttachments: message.hasAttachments,
  };
}

type ConversationCategory =
  | "to_reply"
  | "awaiting_reply"
  | "fyi"
  | "actioned"
  | "uncategorized";

function inferConversationCategory(labelNames: string[]): ConversationCategory {
  const normalized = new Set(
    labelNames.map((labelName) => labelName.trim().toLowerCase()),
  );

  if (normalized.has(getRuleLabel(SystemType.TO_REPLY).toLowerCase()))
    return "to_reply";
  if (normalized.has(getRuleLabel(SystemType.AWAITING_REPLY).toLowerCase()))
    return "awaiting_reply";
  if (normalized.has(getRuleLabel(SystemType.FYI).toLowerCase())) return "fyi";
  if (normalized.has(getRuleLabel(SystemType.ACTIONED).toLowerCase()))
    return "actioned";
  return "uncategorized";
}

function summarizeSearchResults(
  items: Array<{
    category: ConversationCategory;
    isUnread: boolean;
  }>,
) {
  return items.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.isUnread) acc.unread += 1;
      acc.byCategory[item.category] += 1;
      return acc;
    },
    {
      total: 0,
      unread: 0,
      byCategory: {
        to_reply: 0,
        awaiting_reply: 0,
        fyi: 0,
        actioned: 0,
        uncategorized: 0,
      },
    },
  );
}

async function searchGmailChatAccount({
  options: { emailAccountId, provider, logger, localMailSearch },
  input,
}: {
  options: InboxToolOptions;
  input: GmailSearchInboxInput;
}) {
  const { query, limit, pageToken } = input;
  const maxResults = limit ?? SEARCH_INBOX_MAX_RESULTS;
  const localPage = isLocalPageToken(pageToken);

  try {
    const emailProviderPromise = createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    // Awaited below; this only keeps a failure during the local search
    // from counting as unhandled.
    emailProviderPromise.catch(() => undefined);
    // A Gmail page walk stays on Gmail; a local one stays local.
    const local =
      localMailSearch && (!pageToken || localPage)
        ? await localMailSearch.search({
            query,
            limit: maxResults,
            pageToken: pageToken ?? undefined,
          })
        : null;
    if (localPage && !local) return localPageUnavailable(query);

    const emailProvider = await emailProviderPromise;
    const labelsPromise = getLabelsForSearchResults({
      emailProvider,
      logger,
    });
    const searchResult = local
      ? {
          messages: await readLocalMatches(emailProvider, local),
          nextPageToken: local.nextPageToken,
        }
      : await emailProvider
          .searchMessages({
            query,
            maxResults,
            pageToken: pageToken ?? undefined,
            allowPartial: true,
          })
          .then((result) => ({
            ...result,
            messages: result.messages.map(searchSourceFromMessage),
          }));

    return formatSearchInboxResult({
      searchResult,
      queryUsed: query,
      labels: await labelsPromise,
      taxonomyNamesKey: "labelNames",
    });
  } catch (error) {
    // Provider failures are logged and flushed at the provider boundary.
    const errorInfo = extractGmailErrorInfo(error);
    const { retryable } = isGmailRetryableError(errorInfo);
    return {
      queryUsed: query,
      error:
        describeProviderRateLimitError(error, provider) ??
        "Failed to search inbox",
      searchFeedback: {
        status: errorInfo.status,
        message: (
          errorInfo.errorMessage || "Gmail search request failed"
        ).slice(0, 300),
        retryable,
      },
    };
  }
}

async function searchOutlookChatAccount({
  options: { emailAccountId, provider, logger, localMailSearch },
  input,
}: {
  options: InboxToolOptions;
  input: OutlookSearchInboxInput;
}) {
  const {
    query = "",
    fromEmail,
    limit,
    pageToken,
    readState,
    categoryName,
    folderName,
  } = input;

  try {
    const normalizedInput = normalizeOutlookSearchInput({
      query,
      fromEmail,
      readState,
      categoryName,
      folderName,
    });
    const emailProviderPromise = createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    // Awaited below; this only keeps a failure during the local search
    // from counting as unhandled.
    emailProviderPromise.catch(() => undefined);
    // A Graph page walk stays on Graph; a local one stays local.
    const localPage = isLocalPageToken(pageToken);
    const localSearch =
      localMailSearch && (!pageToken || localPage)
        ? getOutlookLocalSearch(normalizedInput)
        : null;
    const local =
      localMailSearch && localSearch
        ? await localMailSearch.search({
            ...localSearch.request,
            limit,
            pageToken: pageToken ?? undefined,
          })
        : null;
    if (localPage && !local) return localPageUnavailable(query);

    const emailProvider = await emailProviderPromise;
    const labelsPromise = getLabelsForSearchResults({
      emailProvider,
      logger,
    });
    if (local && localSearch)
      return formatSearchInboxResult({
        searchResult: {
          messages: await readLocalMatches(emailProvider, local),
          nextPageToken: local.nextPageToken,
        },
        queryUsed: localSearch.queryUsed,
        labels: await labelsPromise,
        taxonomyNamesKey: "categoryNames",
      });

    const searchResult = await runOutlookSearch({
      emailProvider,
      normalizedInput,
      limit,
      pageToken,
      logger,
    });

    if (!searchResult.result) {
      return buildMicrosoftSearchErrorResult({
        query,
        failures: searchResult.failures,
      });
    }

    const labels = await labelsPromise;

    return {
      ...formatSearchInboxResult({
        searchResult: {
          ...searchResult.result,
          messages: searchResult.result.messages.map(searchSourceFromMessage),
        },
        queryUsed: searchResult.queryUsed,
        labels,
        taxonomyNamesKey: "categoryNames",
      }),
      ...(searchResult.exactCount !== undefined && {
        exactCount: searchResult.exactCount,
      }),
      ...(searchResult.countError && {
        countError: searchResult.countError,
      }),
    };
  } catch (error) {
    return buildMicrosoftSearchErrorResult({
      query,
      failures: [{ query, error }],
    });
  }
}

// Other accounts answer with a first look, not a page walk: enough to find
// the email, at a few Gmail or Graph calls per account.
const OTHER_ACCOUNT_MAX_RESULTS = 10;
const OTHER_ACCOUNT_EMAIL_NOT_FOUND =
  "That email is not in any of the user's connected accounts.";

type SearchResultItem = ReturnType<typeof mapMessageForSearchResult>;

type OtherAccountSearchResult =
  | {
      messages: Array<SearchResultItem & { account: string }>;
      hasMore: boolean;
      /** The other provider could only search the chat's search's keywords. */
      keywordsOnly: boolean;
    }
  | { nothingToSearch: true };

type OtherAccount = { id: string; email: string; provider: string };

type OtherAccountSearch = Promise<{
  results: OtherAccountResult<OtherAccountSearchResult>[];
  notSearchedCount: number;
  /** Why the other accounts were not searched at all. */
  skipped?: string;
} | null> | null;

/**
 * Starts the search in the user's other accounts, alongside the chat
 * account's own, when the model asked for all accounts.
 */
function startOtherAccountSearch({
  options: { userId, emailAccountId, provider, logger },
  abortSignal,
  input,
}: {
  options: InboxToolOptions;
  // Either provider's input: a Gmail search has no Outlook-only fields.
  input: GmailSearchInboxInput &
    Partial<
      Pick<
        OutlookSearchInboxInput,
        "fromEmail" | "readState" | "folderName" | "categoryName"
      >
    >;
  abortSignal?: AbortSignal;
}): OtherAccountSearch {
  if (!input.allAccounts) return null;
  // A page walk continues the chat account's search, and folders and
  // categories are the chat account's own, so those stay in it.
  if (input.pageToken) {
    return Promise.resolve({
      results: [],
      notSearchedCount: 0,
      skipped: "Later pages search only this chat's account.",
    });
  }
  if (
    input.folderName ||
    input.categoryName ||
    // An Outlook query can name its folder or category itself.
    (isMicrosoftProvider(provider) &&
      getOutlookFieldScopeCandidate(input.query))
  ) {
    return Promise.resolve({
      results: [],
      notSearchedCount: 0,
      skipped: "Folder and category filters apply only to this chat's account.",
    });
  }

  const search: AccountSearch = {
    query: input.query,
    fromEmail: input.fromEmail,
    readState: input.readState,
  };
  return runOnOtherAccounts({
    userId,
    emailAccountId,
    logger,
    abortSignal,
    run: (account, signal) =>
      searchOtherAccount({
        account,
        chatProvider: provider,
        search,
        signal,
        logger: logger.with({ otherEmailAccountId: account.id }),
      }),
  }).catch((error) => {
    logger.warn("Search across other accounts failed", { error });
    return null;
  });
}

async function searchOtherAccount({
  account,
  chatProvider,
  search: chatSearch,
  signal,
  logger,
}: {
  account: OtherAccount;
  chatProvider: string;
  search: AccountSearch;
  signal: AbortSignal;
  logger: Logger;
}): Promise<OtherAccountSearchResult> {
  const translated = translateAccountSearch({
    search: chatSearch,
    from: chatProvider,
    to: account.provider,
  });
  if (!translated) return { nothingToSearch: true };
  const { search, keywordsOnly } = translated;

  const emailProvider = await createEmailProvider({
    emailAccountId: account.id,
    provider: account.provider,
    logger,
  });
  signal.throwIfAborted();
  const labelsPromise = getLabelsForSearchResults({ emailProvider, logger });
  const isOutlook = isMicrosoftProvider(account.provider);
  const result = isOutlook
    ? await searchOtherOutlookAccount({ emailProvider, search, signal, logger })
    : await emailProvider.searchMessages({
        query: search.query,
        maxResults: OTHER_ACCOUNT_MAX_RESULTS,
        allowPartial: true,
        signal,
      });
  const labelsById = createLabelLookupMap(await labelsPromise);

  return {
    keywordsOnly,
    hasMore: Boolean(result.nextPageToken),
    messages: result.messages.map((message) => ({
      ...mapMessageForSearchResult(
        searchSourceFromMessage(message),
        labelsById,
        isOutlook ? "categoryNames" : "labelNames",
      ),
      ...otherAccountEmailFields(account, message),
    })),
  };
}

async function searchOtherOutlookAccount({
  emailProvider,
  search,
  signal,
  logger,
}: {
  emailProvider: EmailProvider;
  search: AccountSearch;
  signal: AbortSignal;
  logger: Logger;
}) {
  const { result, lastError } = await runOutlookSearch({
    emailProvider,
    normalizedInput: normalizeOutlookSearchInput({
      query: search.query,
      fromEmail: search.fromEmail,
      readState: search.readState,
    }),
    limit: OTHER_ACCOUNT_MAX_RESULTS,
    logger,
    signal,
  });
  if (!result) throw lastError ?? new Error("Outlook search failed");
  return result;
}

function otherAccountEmailFields(
  account: OtherAccount,
  message: { id: string; threadId: string; externalUrl?: string },
) {
  return {
    messageId: toOtherAccountEmailId(account.id, message.id),
    threadId: toOtherAccountEmailId(account.id, message.threadId),
    externalUrl:
      message.externalUrl ??
      getEmailUrlForMessage(
        message.id,
        message.threadId,
        account.email,
        account.provider,
      ),
    account: account.email,
  };
}

/** The chat account's result, with the other accounts' merged in. */
async function withOtherAccountResults<
  T extends {
    messages?: SearchResultItem[];
    error?: unknown;
    hasMore?: unknown;
  },
>({
  result,
  chatEmail,
  otherAccounts: otherAccountSearch,
}: {
  result: T;
  chatEmail: string;
  otherAccounts: OtherAccountSearch;
}) {
  if (!otherAccountSearch) return result;
  const otherSearch = await otherAccountSearch;
  const otherAccounts = otherSearch?.results;

  const chatMessages = (result.messages ?? []).map((message) => ({
    ...message,
    account: chatEmail,
  }));
  const otherMessages = (otherAccounts ?? []).flatMap((entry) =>
    "result" in entry && "messages" in entry.result
      ? entry.result.messages
      : [],
  );
  const messages = [...chatMessages, ...otherMessages];
  // With mail found elsewhere, the chat account's failure is that account's
  // alone, not the result's.
  const { error: _chatAccountError, ...resultWithoutError } = result;
  const merged = otherMessages.length > 0 ? resultWithoutError : result;

  return {
    ...merged,
    totalReturned: messages.length,
    summary: summarizeSearchResults(messages),
    messages,
    accounts: [
      typeof result.error === "string"
        ? { account: chatEmail, error: result.error }
        : {
            account: chatEmail,
            returned: chatMessages.length,
            hasMore: Boolean(result.hasMore),
          },
      ...(otherAccounts ?? []).map(describeOtherAccount),
    ],
    ...(otherSearch?.notSearchedCount && {
      accountsNotSearched: otherSearch.notSearchedCount,
    }),
    ...(otherSearch?.skipped && { otherAccountsSkipped: otherSearch.skipped }),
    ...(otherSearch
      ? {}
      : {
          otherAccountsError:
            "The user's other accounts could not be searched.",
        }),
  };
}

function describeOtherAccount(
  entry: OtherAccountResult<OtherAccountSearchResult>,
) {
  const account = entry.account.email;
  if ("error" in entry) return { account, error: entry.error };
  if ("nothingToSearch" in entry.result) {
    return {
      account,
      error: "Nothing in this search applies to this account.",
    };
  }
  return {
    account,
    returned: entry.result.messages.length,
    hasMore: entry.result.hasMore,
    ...(entry.result.keywordsOnly && { keywordsOnly: true }),
  };
}

function createLabelLookupMap(labels: Array<{ id: string; name: string }>) {
  const labelsById = new Map(
    labels.map((label) => [label.id.toLowerCase(), label.name]),
  );

  if (labelsById.size > 0) return labelsById;

  const toReplyLabel = getRuleLabel(SystemType.TO_REPLY);
  const awaitingReplyLabel = getRuleLabel(SystemType.AWAITING_REPLY);
  const fyiLabel = getRuleLabel(SystemType.FYI);
  const actionedLabel = getRuleLabel(SystemType.ACTIONED);

  return new Map([
    [toReplyLabel.toLowerCase(), toReplyLabel],
    [awaitingReplyLabel.toLowerCase(), awaitingReplyLabel],
    [fyiLabel.toLowerCase(), fyiLabel],
    [actionedLabel.toLowerCase(), actionedLabel],
    ["to_reply", toReplyLabel],
    ["awaiting_reply", awaitingReplyLabel],
    ["fyi", fyiLabel],
    ["actioned", actionedLabel],
    ["inbox", "Inbox"],
    ["unread", "Unread"],
  ] as const);
}

async function runThreadActionsInParallel({
  threadIds,
  concurrency,
  runAction,
}: {
  threadIds: string[];
  concurrency: number;
  runAction: (threadId: string) => Promise<void>;
}) {
  const results = await runWithBoundedConcurrency({
    items: threadIds,
    concurrency,
    run: async (threadId) => {
      await runAction(threadId);
    },
  });

  return results.map(({ item: threadId, result }) => ({
    threadId,
    success: result.status === "fulfilled",
  }));
}

async function applyLabelToThread({
  emailProvider,
  threadId,
  labelId,
  labelName,
}: {
  emailProvider: EmailProvider;
  threadId: string;
  labelId: string;
  labelName: string | null;
}) {
  const messages = await emailProvider.getThreadMessages(threadId);
  const results = await runWithBoundedConcurrency({
    items: messages,
    concurrency: LABEL_MESSAGE_CONCURRENCY,
    run: async (message) => {
      await emailProvider.labelMessage({
        messageId: message.id,
        labelId,
        labelName,
      });
    },
  });

  const failedCount = results.filter(
    ({ result }) => result.status === "rejected",
  ).length;

  if (failedCount > 0) {
    throw new Error(`Failed to label ${failedCount} messages in thread`);
  }
}

async function resolveThreadLabel({
  emailProvider,
  labelName,
  action,
  matchNestedLabels,
  missingLabelError,
}: {
  emailProvider: EmailProvider;
  labelName: string;
  action: ManageInboxAction;
  matchNestedLabels: boolean;
  missingLabelError: (name: string, action: ManageInboxAction) => string;
}) {
  const existingLabel = await emailProvider.getLabelByName(labelName);

  if (existingLabel) {
    return {
      labelId: existingLabel.id,
      labelName: existingLabel.name,
    };
  }

  if (matchNestedLabels) {
    const labels = await emailProvider.getLabels({ includeHidden: true });
    const nestedMatches = findNestedLabelMatches({
      labels,
      name: labelName,
      getLabelName: (label) => label.name,
      normalize: normalizeLabelName,
    });

    if (nestedMatches.length === 1) {
      return {
        labelId: nestedMatches[0].id,
        labelName: nestedMatches[0].name,
      };
    }

    if (nestedMatches.length > 1) {
      const paths = nestedMatches
        .map((label) => JSON.stringify(label.name))
        .join(", ");
      throw new Error(
        `Multiple Gmail labels match "${labelName}": ${paths}. Use the full label path.`,
      );
    }
  }

  throw new Error(missingLabelError(labelName, action));
}

async function runSenderUnsubscribeActions({
  fromEmails,
  emailProvider,
  emailAccountId,
  logger,
}: {
  fromEmails: string[];
  emailProvider: EmailProvider;
  emailAccountId: string;
  logger: Logger;
}) {
  const BATCH_SIZE = 5;
  const results = await runWithBoundedConcurrency({
    items: fromEmails,
    concurrency: BATCH_SIZE,
    run: async (senderEmail) => {
      const { listUnsubscribeHeader, unsubscribeLink } =
        await getSenderUnsubscribeSource({
          senderEmail,
          emailProvider,
          logger,
        });

      return unsubscribeSenderAndMark({
        emailAccountId,
        senderEmail: senderEmail,
        listUnsubscribeHeader,
        unsubscribeLink,
        logger,
      });
    },
  });

  return results.map(({ item: senderEmail, result }) => {
    if (result.status === "fulfilled") {
      const unsubscribeSuccess = result.value.unsubscribe.success;
      return {
        senderEmail,
        success: unsubscribeSuccess,
        unsubscribe: result.value.unsubscribe,
      };
    }

    return {
      senderEmail,
      success: false,
      unsubscribe: {
        attempted: false,
        success: false,
        reason: "request_failed",
      } as AutomaticUnsubscribeResult,
    };
  });
}

function validateManageInboxInput(
  input: { action: string } & Partial<
    Record<
      | "threadIds"
      | "labelName"
      | "categoryName"
      | "read"
      | "fromEmails"
      | "query",
      string | boolean | string[]
    >
  >,
  context: z.RefinementCtx,
  options: {
    taxonomyField: "labelName" | "categoryName";
    taxonomyActions: readonly string[];
    queryActions: readonly string[];
  },
) {
  const { action } = input;
  const isSenderAction =
    action === "bulk_archive_senders" || action === "unsubscribe_senders";
  const hasQuery = input.query !== undefined;
  if (hasQuery) {
    if (
      !options.queryActions.includes(action) ||
      input.threadIds !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: `works only with ${options.queryActions.join(", ")}, and without threadIds`,
      });
      return;
    }
  }
  const requiredFields = new Set<
    "threadIds" | "labelName" | "categoryName" | "read" | "fromEmails"
  >(isSenderAction ? ["fromEmails"] : hasQuery ? [] : ["threadIds"]);
  if (options.taxonomyActions.includes(action)) {
    requiredFields.add(options.taxonomyField);
  }
  if (action === "mark_read_threads") requiredFields.add("read");

  for (const field of requiredFields) {
    if (input[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `is required for ${action}`,
      });
    }
  }
}

function getManageInboxValidationError(error: z.ZodError) {
  const firstIssue = error.issues[0];
  if (!firstIssue) return "Invalid manageInbox input";

  if (firstIssue.path[0] === "fromEmails") {
    return 'No sender-level action was taken. "fromEmails" is required for bulk_archive_senders and unsubscribe_senders. If you only meant the emails already shown, use archive_threads with threadIds instead.';
  }

  if (firstIssue.code === "too_small" && firstIssue.path[0] === "threadIds") {
    return "Invalid manageInbox input: threadIds must include at least one thread ID";
  }

  const field = firstIssue.path.map(String).join(".");
  if (!field) return `Invalid manageInbox input: ${firstIssue.message}`;

  return `Invalid manageInbox input: ${field} ${firstIssue.message}`;
}

function getSendEmailValidationError(error: z.ZodError) {
  return getValidationErrorMessage("sendEmail", error);
}

function getForwardEmailValidationError(error: z.ZodError) {
  return getValidationErrorMessage("forwardEmail", error);
}

function getReplyEmailValidationError(error: z.ZodError) {
  return getValidationErrorMessage("replyEmail", error);
}

function hasOnlyValidRecipients(recipientList: string) {
  const recipients = splitRecipientList(recipientList);
  if (recipients.length === 0) return false;

  return recipients.every((recipient) =>
    Boolean(extractEmailAddress(recipient)),
  );
}

function normalizeSenderEmails(fromEmails: string[]) {
  return extractUniqueEmailAddresses(fromEmails);
}

type NormalizedManageInboxInput = {
  action: ManageInboxAction;
  originalAction: string;
  threadIds?: string[] | null;
  query?: string | null;
  labelName?: string | null;
  read?: boolean | null;
  fromEmails?: string[] | null;
};

function normalizeGmailManageInboxInput(
  parsed: Record<string, unknown>,
): NormalizedManageInboxInput {
  const originalAction = parsed.action as string;
  return {
    action: originalAction as ManageInboxAction,
    originalAction,
    threadIds: parsed.threadIds as string[] | null | undefined,
    query: parsed.query as string | null | undefined,
    labelName: parsed.labelName as string | null | undefined,
    read: parsed.read as boolean | null | undefined,
    fromEmails: parsed.fromEmails as string[] | null | undefined,
  };
}

function normalizeOutlookManageInboxInput(
  parsed: Record<string, unknown>,
): NormalizedManageInboxInput {
  const originalAction = parsed.action as string;
  const action: ManageInboxAction =
    originalAction === "categorize_threads"
      ? "label_threads"
      : originalAction === "remove_category_threads"
        ? "remove_label_threads"
        : (originalAction as ManageInboxAction);

  return {
    action,
    originalAction,
    threadIds: parsed.threadIds as string[] | null | undefined,
    query: parsed.query as string | null | undefined,
    labelName: parsed.categoryName as string | null | undefined,
    read: parsed.read as boolean | null | undefined,
    fromEmails: parsed.fromEmails as string[] | null | undefined,
  };
}

/**
 * manageInbox over every email a search matches: a count the user confirms
 * on the card, which then starts the inbox's own select-all job.
 */
async function runManageInboxQuery({
  parsedInput,
  emailProvider,
  emailAccountId,
  provider,
  taxonomy,
  confirmation,
  abortSignal,
  logger,
}: {
  parsedInput: NormalizedManageInboxInput & { query: string };
  emailProvider: EmailProvider;
  emailAccountId: string;
  provider: string;
  taxonomy: ManageInboxTaxonomyConfig;
  confirmation?: { chatId: string; toolCallId: string };
  abortSignal?: AbortSignal;
  logger: Logger;
}) {
  const { action, labelName, read, query, originalAction } = parsedInput;
  const bulkAction = toMatchingBulkAction(action, read);
  if (!bulkAction) return { error: "This action can't run over a search." };

  let labelId: string | undefined;
  if (action === "label_threads") {
    try {
      const resolved = await resolveThreadLabel({
        emailProvider,
        labelName: labelName!,
        action,
        matchNestedLabels: isGoogleProvider(provider),
        missingLabelError: taxonomy.missingLabelError,
      });
      labelId = resolved.labelId;
    } catch (error) {
      logger.warn("Failed to resolve label for a search-wide action", {
        error,
      });
      return hideToolErrorFromUser({
        error:
          error instanceof Error
            ? error.message
            : taxonomy.labelResolutionFallbackError,
      });
    }
  }

  return previewMatchingQueryAction({
    originalAction,
    query,
    bulkAction,
    labelId,
    emailProvider,
    emailAccountId,
    provider,
    confirmation,
    abortSignal,
  });
}

function isThreadLabelAction(
  action: ManageInboxAction | undefined,
): action is "label_threads" | "remove_label_threads" {
  return action === "label_threads" || action === "remove_label_threads";
}

const LABEL_MESSAGE_CONCURRENCY = 1;
const THREAD_ACTION_CONCURRENCY = 3;

function getValidationErrorMessage(toolName: string, error: z.ZodError) {
  const firstIssue = error.issues[0];
  if (!firstIssue) return `Invalid ${toolName} input`;

  if (firstIssue.code === "unrecognized_keys") {
    const firstKey = firstIssue.keys[0];
    if (firstKey) {
      return `Invalid ${toolName} input: unsupported field "${firstKey}"`;
    }
    return `Invalid ${toolName} input: unsupported fields`;
  }

  const field = firstIssue.path.map(String).join(".");
  if (!field) return `Invalid ${toolName} input: ${firstIssue.message}`;

  return `Invalid ${toolName} input: ${field} ${firstIssue.message}`;
}

const MAX_ATTACHMENT_TEXT_LENGTH = 8000;

const EXTRACTABLE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "text/html",
]);

function isExtractableMimeType(mimeType: string): boolean {
  return EXTRACTABLE_MIME_TYPES.has(mimeType);
}

async function extractAttachmentText(
  buffer: Buffer,
  mimeType: string,
  logger: Logger,
): Promise<{ text: string; truncated: boolean } | null> {
  if (
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "text/plain"
  ) {
    const { extractTextFromDocument } = await import(
      "@/utils/drive/document-extraction"
    );
    const result = await extractTextFromDocument(buffer, mimeType, {
      maxLength: MAX_ATTACHMENT_TEXT_LENGTH,
      logger,
    });
    if (!result) return null;
    return { text: result.text, truncated: result.truncated };
  }

  if (mimeType === "text/csv") {
    const text = buffer.toString("utf-8");
    const truncated = text.length > MAX_ATTACHMENT_TEXT_LENGTH;
    return {
      text: truncated
        ? `${text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)}... (truncated)`
        : text,
      truncated,
    };
  }

  if (mimeType === "text/html") {
    const { htmlToText } = await import("html-to-text");
    const text = htmlToText(buffer.toString("utf-8"), {
      wordwrap: false,
      selectors: [{ selector: "img", format: "skip" }],
    });
    const truncated = text.length > MAX_ATTACHMENT_TEXT_LENGTH;
    return {
      text: truncated
        ? `${text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)}... (truncated)`
        : text,
      truncated,
    };
  }

  return { text: "", truncated: false };
}

// The confirm token is for the card's button; the model has no use for it.
function manageInboxModelOutput({ output }: { output: unknown }) {
  return {
    type: "json" as const,
    value: withoutConfirmToken(output) as JSONValue,
  };
}

function searchInboxModelOutput({ output }: { output: unknown }) {
  return {
    type: "json" as const,
    value: toSearchInboxModelValue(JSON.parse(JSON.stringify(output))),
  };
}

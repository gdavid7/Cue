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
import { mapWithConcurrency, runWithBoundedConcurrency } from "@/utils/async";
import { findNestedLabelMatches } from "@/utils/label/find-nested-label-matches";
import { normalizeLabelName } from "@/utils/label/normalize-label-name";
import { resolveLabelNameAndId } from "@/utils/label/resolve-label";
import {
  buildMicrosoftSearchErrorResult,
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
import {
  countMatchingInAccount,
  type OtherAccountMatchingPreview,
  previewMatchingQueryAction,
  searchForAccount,
} from "@/utils/ai/assistant/chat-matching-actions";
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
import { searchPageTokenSchema } from "@/utils/ai/assistant/all-accounts-page-token";
import { validateUserAndAiAccess } from "@/utils/user/validate";
import { SafeError } from "@/utils/error";
import { getEmailUrlForMessage } from "@/utils/url";
import {
  ACCOUNT_SEARCH_FAILED,
  type OtherAccountResult,
  resolveEmailAccountForId,
  runOnOtherAccounts,
  selectOtherAccounts,
} from "@/utils/ai/assistant/chat-other-accounts";
import {
  parseAllAccountsPageToken,
  toAllAccountsPageToken,
} from "@/utils/ai/assistant/all-accounts-page-token";
import { resolveOutlookFolderId } from "@/utils/outlook/search-scope";
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
  pageToken: searchPageTokenSchema.describe(
    "Use the page token returned from a prior search to paginate.",
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
      "Search inbox messages and return concise message metadata. It searches all of the user's connected accounts, and each message names its account. Returns at most 20 messages per call. If hasMore=true, more matches remain; call again with nextPageToken for the next page. To count matches use countEmails, and to act on every match use manageInbox with query, rather than paging through them. totalReturned is only the number of messages returned by this call, so do not present it or a single search page as an exact mailbox, folder, or label count. If the tool returns an error or provider search feedback instead of messages, treat the lookup as inconclusive rather than evidence that the email is absent.",
    inputSchema: gmailSearchInboxInputSchema,
    execute: async (input, callOptions) => {
      const { email, logger } = options;
      trackToolCall({ tool: "search_inbox", email, logger });

      return searchAllAccounts({
        options,
        input,
        abortSignal: callOptions?.abortSignal,
        searchChatAccount: (chatInput) =>
          searchGmailChatAccount({ options, input: chatInput }),
      });
    },
    toModelOutput: searchInboxModelOutput,
  });

const outlookSearchInboxTool = (options: InboxToolOptions) =>
  tool({
    description:
      "Search inbox messages and return concise message metadata. It searches all of the user's connected accounts, and each message names its account. Returns at most 20 messages per call. If hasMore=true, more matches remain; call again with nextPageToken for the next page, even when the current page has zero messages. To count matches use countEmails, and to act on every match use manageInbox with query, rather than paging through them. Outlook filtered searches can return an empty page before later matching pages. For folder/category count questions, use only folderName/categoryName with no query or other filters and report exactCount, the full-scope message count including drafts. If countError is returned, the exact total is unavailable. totalReturned is only this page size and is never an exact mailbox, folder, or category total. If the tool returns an error or provider search feedback instead of messages, treat the lookup as inconclusive rather than evidence that the email is absent.",
    inputSchema: outlookSearchInboxInputSchema,
    execute: async (input, callOptions) => {
      const { email, logger } = options;
      trackToolCall({ tool: "search_inbox", email, logger });

      return searchAllAccounts({
        options,
        input,
        abortSignal: callOptions?.abortSignal,
        searchChatAccount: (chatInput) =>
          searchOutlookChatAccount({ options, input: chatInput }),
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
      "Instead of threadIds, an Outlook search in searchInbox's query syntax, with an exact sender written as from:person@example.com: archive_threads, mark_read_threads or categorize_threads then applies to every email it matches, in all of the user's connected accounts, once the user presses Confirm. Tell them how many conversations would change in each account; calling again does not start it.",
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
      "Instead of threadIds, a Gmail search in searchInbox's syntax: archive_threads, mark_read_threads or label_threads then applies to every email it matches, in all of the user's connected accounts, once the user presses Confirm. Tell them how many conversations would change in each account; calling again does not start it.",
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

const OUTLOOK_TAXONOMY: ManageInboxTaxonomyConfig = {
  labelResolutionFallbackError: "Failed to resolve category",
  missingLabelError: (name, action) =>
    action === "remove_label_threads"
      ? `Category "${name}" does not exist, so no category was removed.`
      : `Category "${name}" does not exist. Use createOrGetCategory first if you want to create it.`,
  resultKeys: {
    id: "categoryId",
    name: "categoryName",
  },
};

const GMAIL_TAXONOMY: ManageInboxTaxonomyConfig = {
  labelResolutionFallbackError: "Failed to resolve label",
  missingLabelError: (name, action) =>
    action === "remove_label_threads"
      ? `Label "${name}" does not exist, so no label was removed.`
      : `Label "${name}" does not exist. Use createOrGetLabel first if you want to create it.`,
  resultKeys: {
    id: "labelId",
    name: "labelName",
  },
};

const outlookManageInboxTool = (options: InboxToolOptions) =>
  buildManageInboxTool({
    options,
    inputSchema: outlookManageInboxInputSchema,
    normalizeInput: normalizeOutlookManageInboxInput,
    taxonomy: OUTLOOK_TAXONOMY,
  });

const gmailManageInboxTool = (options: InboxToolOptions) =>
  buildManageInboxTool({
    options,
    inputSchema: gmailManageInboxInputSchema,
    normalizeInput: normalizeGmailManageInboxInput,
    taxonomy: GMAIL_TAXONOMY,
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
  const { email, provider, logger } = options;

  return tool({
    description:
      "Run inbox actions on threads or senders. Each email is changed in the account it is in. For emails already shown or found in this turn, prefer thread actions with threadIds. To act on everything a search matches, call it with query directly instead of searching, counting or collecting threadIds first: a query call changes nothing and shows the user the count with a Confirm button. Use archive_threads for ordinary inbox cleanup; only use trash_threads when the user explicitly asks to delete or trash. Do not widen a limited thread-level request into sender-wide cleanup. Only use sender-wide cleanup with fromEmails when the user clearly wants all mail from that sender, and get confirmation before doing broad sender-wide cleanup. Only use unsubscribe_senders for an explicit unsubscribe request.",
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
      const { action, originalAction } = parsedInput;
      const isSenderAction = requiresSenderEmails(action);

      try {
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

          return await runSenderActionsAcrossAccounts({
            options,
            action,
            originalAction,
            fromEmails: normalizedFromEmails,
          });
        }

        if (parsedInput.query) {
          const startedAt = Date.now();
          const result = await runManageInboxQuery({
            parsedInput: { ...parsedInput, query: parsedInput.query },
            options,
            taxonomy,
            // Only the web chat shows the card a confirmation is pressed on.
            confirmation:
              options.responseSurface === "web" &&
              options.chatId &&
              callOptions?.toolCallId
                ? { chatId: options.chatId, toolCallId: callOptions.toolCallId }
                : undefined,
            abortSignal: callOptions?.abortSignal,
          });
          logger.info("manageInbox query ran", {
            action: originalAction,
            result: "status" in result ? result.status : "error",
            conversations:
              "conversations" in result ? result.conversations : undefined,
            durationMs: Date.now() - startedAt,
          });
          return result;
        }

        return await runThreadActionsAcrossAccounts({
          options,
          parsedInput,
          taxonomy,
        });
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
  userId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  /** The signed-in user, whose other accounts' emails it may reply to. */
  userId: string;
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

      let target: Awaited<ReturnType<typeof resolveEmailAccountForId>> = null;
      try {
        // The reply sends from the account the email is in.
        target = await resolveEmailAccountForId({
          id: parsedInput.data.messageId,
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

        return createPendingReplyEmailOutput(
          { ...parsedInput.data, messageId: target.id },
          message,
          target.emailAccountId,
        );
      } catch (error) {
        logger.error("Failed to prepare reply from chat", { error });
        return {
          error:
            describeProviderRateLimitError(
              error,
              target?.provider ?? provider,
            ) ?? "Failed to prepare reply",
        };
      }
    },
  });

export type ReplyEmailTool = InferUITool<ReturnType<typeof replyEmailTool>>;

export const forwardEmailTool = ({
  email,
  emailAccountId,
  userId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  /** The signed-in user, whose other accounts' emails it may forward. */
  userId: string;
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

      let target: Awaited<ReturnType<typeof resolveEmailAccountForId>> = null;
      try {
        // The forward sends from the account the email is in.
        target = await resolveEmailAccountForId({
          id: parsedInput.data.messageId,
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
        return createPendingForwardEmailOutput(
          { ...parsedInput.data, messageId: target.id },
          message,
          target.emailAccountId,
        );
      } catch (error) {
        logger.error("Failed to prepare email forward from chat", { error });
        return {
          error:
            describeProviderRateLimitError(
              error,
              target?.provider ?? provider,
            ) ?? "Failed to prepare email forward",
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

// Each account gets a share of the page, at least a few matches, so the page
// stays about one page long however many accounts there are.
const MIN_ACCOUNT_PAGE_SHARE = 5;
const OTHER_ACCOUNT_EMAIL_NOT_FOUND =
  "That email is not in any of the user's connected accounts.";
const NO_SUCH_SCOPE_IN_ACCOUNT =
  "No folder or category with this name in this account.";

type SearchResultItem = ReturnType<typeof mapMessageForSearchResult>;

type OtherAccountSearchResult =
  | {
      messages: Array<SearchResultItem & { account: string }>;
      nextPageToken?: string;
      /** The other provider could only search the chat's search's keywords. */
      keywordsOnly: boolean;
      exactCount?: number;
      countError?: string;
    }
  | { nothingToSearch: true }
  | { noSuchScope: true };

type OtherAccount = { id: string; email: string; provider: string };

/** Either provider's searchInbox input: a Gmail search has no Outlook-only fields. */
type AnySearchInboxInput = {
  query: string;
  limit: number;
  pageToken?: string | null;
  fromEmail?: string | null;
  readState?: "read" | "unread" | null;
  folderName?: string | null;
  categoryName?: string | null;
};

type ChatAccountSearchResult = {
  messages?: SearchResultItem[];
  error?: unknown;
  nextPageToken?: string;
  exactCount?: number;
  countError?: string;
};

/** A chat search as each other account is asked it, its folder or category apart. */
type OtherAccountsSearch = {
  search: AccountSearch;
  folderName?: string | null;
  categoryName?: string | null;
};

/**
 * Searches the chat's account and the user's other covered accounts
 * together. Each takes a share of the page, the results merge newest first,
 * and every message names its account. A user with only one covered account
 * gets that account's result as it is.
 */
async function searchAllAccounts<
  TInput extends AnySearchInboxInput,
  TResult extends ChatAccountSearchResult,
>({
  options,
  input,
  abortSignal,
  searchChatAccount,
}: {
  options: InboxToolOptions;
  input: TInput;
  abortSignal?: AbortSignal;
  searchChatAccount: (input: TInput) => Promise<TResult>;
}) {
  const { userId, emailAccountId, email, provider, logger } = options;
  const selection = await selectOtherAccounts({ userId, emailAccountId }).catch(
    (error) => {
      logger.warn("Could not list the user's accounts to search", { error });
      return null;
    },
  );
  const pageTokens = parseAllAccountsPageToken(input.pageToken);
  const searchesAccount = (accountId: string) =>
    pageTokens
      ? accountId in pageTokens
      : !input.pageToken || accountId === emailAccountId;
  const pageTokenFor = (accountId: string) =>
    pageTokens
      ? pageTokens[accountId]
      : accountId === emailAccountId
        ? input.pageToken
        : undefined;

  if (!pageTokens && !selection?.accounts.length) {
    const result = await searchChatAccount(input);
    return selection?.notSearchedCount
      ? { ...result, accountsNotSearched: selection.notSearchedCount }
      : result;
  }

  const accountCount = 1 + (selection?.accounts.length ?? 0);
  const limit = Math.min(
    input.limit,
    Math.max(MIN_ACCOUNT_PAGE_SHARE, Math.ceil(input.limit / accountCount)),
  );
  const otherSearch = getOtherAccountsSearch(input, provider);
  const others = (selection?.accounts ?? []).filter((account) =>
    searchesAccount(account.id),
  );
  const otherResultsPromise =
    selection && otherSearch && others.length
      ? runOnOtherAccounts({
          userId,
          emailAccountId,
          logger,
          abortSignal,
          selection: {
            accounts: others,
            notSearchedCount: selection.notSearchedCount,
          },
          run: (account, signal) =>
            searchOtherAccount({
              account,
              chatProvider: provider,
              search: otherSearch,
              limit,
              pageToken: pageTokenFor(account.id),
              signal,
              logger: logger.with({ otherEmailAccountId: account.id }),
            }),
        }).catch((error) => {
          logger.warn("Search across other accounts failed", { error });
          return null;
        })
      : Promise.resolve({
          results: [],
          notSearchedCount: selection?.notSearchedCount ?? 0,
        });

  const chatResult = searchesAccount(emailAccountId)
    ? await searchChatAccount({
        ...input,
        limit,
        pageToken: pageTokenFor(emailAccountId) ?? null,
      })
    : null;
  const otherSearchResult = await otherResultsPromise;
  const otherAccounts = otherSearchResult?.results ?? [];

  const chatMessages = (chatResult?.messages ?? []).map((message) => ({
    ...message,
    account: email,
  }));
  const otherMessages = otherAccounts.flatMap((entry) =>
    "result" in entry && "messages" in entry.result
      ? entry.result.messages
      : [],
  );
  const messages = [...chatMessages, ...otherMessages].sort(
    (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
  );

  const nextPageTokens: Record<string, string> = {};
  if (chatResult?.nextPageToken)
    nextPageTokens[emailAccountId] = chatResult.nextPageToken;
  for (const entry of otherAccounts) {
    if ("result" in entry && "messages" in entry.result) {
      const next = entry.result.nextPageToken;
      if (next) nextPageTokens[entry.account.id] = next;
    }
  }
  const nextPageToken = Object.keys(nextPageTokens).length
    ? toAllAccountsPageToken(nextPageTokens)
    : undefined;

  const {
    error: chatError,
    nextPageToken: _chatNextPageToken,
    hasMore: _chatHasMore,
    exactCount: chatExactCount,
    countError: chatCountError,
    messages: _chatMessages,
    totalReturned: _chatTotalReturned,
    summary: _chatSummary,
    ...chatRest
  } = (chatResult ?? { queryUsed: input.query }) as ChatAccountSearchResult &
    Record<string, unknown>;
  const accounts = [
    describeChatAccount({
      email,
      result: chatResult,
      error: chatError,
      exactCount: chatExactCount,
      countError: chatCountError,
    }),
    ...otherAccounts.map(describeOtherAccount),
  ];
  const answered = accounts.filter((entry) => !("error" in entry));
  const exactCounts = answered.map((entry) =>
    "exactCount" in entry ? entry.exactCount : undefined,
  );

  return {
    ...chatRest,
    // With mail found elsewhere, the chat account's failure is that
    // account's alone, not the result's.
    ...(typeof chatError === "string" && otherMessages.length === 0
      ? { error: chatError }
      : {}),
    totalReturned: messages.length,
    nextPageToken,
    hasMore: Boolean(nextPageToken),
    summary: summarizeSearchResults(messages),
    messages,
    accounts,
    ...(exactCounts.length > 0 &&
    exactCounts.every((count) => count !== undefined)
      ? {
          exactCount: exactCounts.reduce<number>(
            (sum, count) => sum + (count ?? 0),
            0,
          ),
        }
      : {}),
    ...(otherSearchResult?.notSearchedCount
      ? { accountsNotSearched: otherSearchResult.notSearchedCount }
      : {}),
    ...(otherSearchResult
      ? {}
      : {
          otherAccountsError:
            "The user's other accounts could not be searched.",
        }),
  };
}

/**
 * The chat's search as the other accounts are asked it. An Outlook search's
 * folder or category is kept apart, for each account to find its own of
 * that name. Null when the search is malformed, which the chat account's
 * own search reports.
 */
function getOtherAccountsSearch(
  input: AnySearchInboxInput,
  provider: string,
): OtherAccountsSearch | null {
  if (!isMicrosoftProvider(provider)) return { search: { query: input.query } };
  try {
    const normalized = normalizeOutlookSearchInput({
      query: input.query,
      fromEmail: input.fromEmail,
      readState: input.readState,
      categoryName: input.categoryName,
      folderName: input.folderName,
    });
    return {
      search: {
        query: normalized.query,
        fromEmail: normalized.fromEmail,
        readState: normalized.readState,
      },
      folderName: normalized.folderName,
      categoryName: normalized.categoryName,
    };
  } catch {
    return null;
  }
}

async function searchOtherAccount({
  account,
  chatProvider,
  search: { search: chatSearch, folderName, categoryName },
  limit,
  pageToken,
  signal,
  logger,
}: {
  account: OtherAccount;
  chatProvider: string;
  search: OtherAccountsSearch;
  limit: number;
  pageToken?: string | null;
  signal: AbortSignal;
  logger: Logger;
}): Promise<OtherAccountSearchResult> {
  const scopeName = folderName ?? categoryName;
  const translated = translateAccountSearch({
    search: chatSearch,
    from: chatProvider,
    to: account.provider,
  });
  if (!translated && !scopeName) return { nothingToSearch: true };
  const search = translated?.search ?? { query: "" };
  const keywordsOnly = translated?.keywordsOnly ?? false;

  const emailProvider = await createEmailProvider({
    emailAccountId: account.id,
    provider: account.provider,
    logger,
  });
  signal.throwIfAborted();
  const labelsPromise = getLabelsForSearchResults({ emailProvider, logger });
  const isOutlook = isMicrosoftProvider(account.provider);

  let result: SearchMessagesWithCount;
  if (isOutlook) {
    // Only an existing folder or category is searched (D-008).
    if (categoryName && !findLabelNamed(await labelsPromise, categoryName))
      return { noSuchScope: true };
    const outlookResult = await searchOtherOutlookAccount({
      emailProvider,
      search,
      folderName,
      categoryName,
      limit,
      pageToken,
      signal,
      logger,
    });
    if (!outlookResult) return { noSuchScope: true };
    result = outlookResult;
  } else {
    let query = search.query;
    if (scopeName) {
      // Gmail keeps folders and categories as labels.
      const label = findLabelNamed(await labelsPromise, scopeName);
      if (!label) return { noSuchScope: true };
      query = [query, `label:"${label.name}"`].filter(Boolean).join(" ");
    }
    result = await emailProvider.searchMessages({
      query,
      maxResults: limit,
      pageToken: pageToken ?? undefined,
      allowPartial: true,
      signal,
    });
  }
  const labelsById = createLabelLookupMap(await labelsPromise);

  return {
    keywordsOnly,
    nextPageToken: result.nextPageToken,
    messages: result.messages.map((message) => ({
      ...mapMessageForSearchResult(
        searchSourceFromMessage(message),
        labelsById,
        isOutlook ? "categoryNames" : "labelNames",
      ),
      ...otherAccountEmailFields(account, message),
    })),
    ...(result.exactCount !== undefined && { exactCount: result.exactCount }),
    ...(result.countError && { countError: result.countError }),
  };
}

type SearchMessagesWithCount = Awaited<
  ReturnType<EmailProvider["searchMessages"]>
> & { exactCount?: number; countError?: string };

/** Null when the account has no folder of that name. */
async function searchOtherOutlookAccount({
  emailProvider,
  search,
  folderName,
  categoryName,
  limit,
  pageToken,
  signal,
  logger,
}: {
  emailProvider: EmailProvider;
  search: AccountSearch;
  folderName?: string | null;
  categoryName?: string | null;
  limit: number;
  pageToken?: string | null;
  signal: AbortSignal;
  logger: Logger;
}): Promise<SearchMessagesWithCount | null> {
  if (folderName) {
    try {
      await resolveOutlookFolderId({ emailProvider, folderName });
    } catch {
      return null;
    }
  }
  const { result, lastError, exactCount, countError } = await runOutlookSearch({
    emailProvider,
    normalizedInput: normalizeOutlookSearchInput({
      query: search.query,
      fromEmail: search.fromEmail,
      readState: search.readState,
      folderName,
      categoryName,
    }),
    limit,
    pageToken,
    logger,
    signal,
  });
  if (!result) throw lastError ?? new Error("Outlook search failed");
  return {
    ...result,
    ...(exactCount !== undefined && { exactCount }),
    ...(countError && { countError }),
  };
}

function findLabelNamed(
  labels: Array<{ id: string; name: string }>,
  name: string,
) {
  const wanted = name.trim().toLowerCase();
  return labels.find(
    (label) =>
      label.name.trim().toLowerCase() === wanted ||
      label.id.toLowerCase() === wanted,
  );
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

function describeChatAccount({
  email,
  result,
  error,
  exactCount,
  countError,
}: {
  email: string;
  /** Null once an earlier page found every match in this account. */
  result: ChatAccountSearchResult | null;
  error: unknown;
  exactCount?: number;
  countError?: string;
}) {
  if (typeof error === "string") return { account: email, error };
  return {
    account: email,
    returned: result?.messages?.length ?? 0,
    hasMore: Boolean(result?.nextPageToken),
    ...(exactCount !== undefined && { exactCount }),
    ...(countError && { countError }),
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
  if ("noSuchScope" in entry.result) {
    return { account, error: NO_SUCH_SCOPE_IN_ACCOUNT };
  }
  return {
    account,
    returned: entry.result.messages.length,
    hasMore: Boolean(entry.result.nextPageToken),
    ...(entry.result.keywordsOnly && { keywordsOnly: true }),
    ...(entry.result.exactCount !== undefined && {
      exactCount: entry.result.exactCount,
    }),
    ...(entry.result.countError && { countError: entry.result.countError }),
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

// Writes reach a few accounts at once, each with its own provider budget.
const ACCOUNT_WRITE_CONCURRENCY = 3;
const SENDER_LOOKUP_CONCURRENCY = 5;

type ChatAccount = { id: string; email: string; provider: string };

/** A thread id as the model gave it, and as its own account knows it. */
type AccountThreadId = { requested: string; providerId: string };

/**
 * Runs a thread action on each email in the account it is in: the chat's own
 * account for a plain id, or the user's other account an id names once it
 * is checked to be theirs. An id in no account of the user's fails alone.
 * A chat that only touched its own account gets that account's result as it
 * always has.
 */
async function runThreadActionsAcrossAccounts({
  options,
  parsedInput,
  taxonomy,
}: {
  options: InboxToolOptions;
  parsedInput: NormalizedManageInboxInput;
  taxonomy: ManageInboxTaxonomyConfig;
}) {
  const { userId, emailAccountId, email, provider } = options;
  const threadIds = parsedInput.threadIds ?? [];
  const groups = new Map<
    string,
    { account: ChatAccount; threadIds: AccountThreadId[] }
  >();
  const notOwned: string[] = [];
  const resolved = new Map<string, ChatAccount | null>();
  for (const requested of threadIds) {
    const target = await resolveEmailAccountForId({
      id: requested,
      userId,
      emailAccountId,
      provider,
    }).then(
      (found) => found,
      () => null,
    );
    if (!target) {
      notOwned.push(requested);
      continue;
    }
    let account = resolved.get(target.emailAccountId);
    if (account === undefined) {
      account = target.otherAccount
        ? {
            id: target.otherAccount.id,
            email: target.otherAccount.email,
            provider: target.otherAccount.provider,
          }
        : { id: emailAccountId, email, provider };
      resolved.set(target.emailAccountId, account);
    }
    if (!account) continue;
    const group = groups.get(account.id) ?? { account, threadIds: [] };
    group.threadIds.push({ requested, providerId: target.id });
    groups.set(account.id, group);
  }

  const accountGroups = [...groups.values()];
  const onlyChatAccount =
    notOwned.length === 0 &&
    accountGroups.length === 1 &&
    accountGroups[0].account.id === emailAccountId;

  if (onlyChatAccount) {
    const result = await runThreadActionsInAccount({
      options,
      account: accountGroups[0].account,
      threadIds: accountGroups[0].threadIds,
      parsedInput,
      taxonomy,
    });
    if ("labelError" in result)
      return hideToolErrorFromUser({ error: result.labelError });
    const successCount = threadIds.length - result.failedThreadIds.length;
    return {
      success: result.failedThreadIds.length === 0,
      action: parsedInput.originalAction,
      requestedCount: threadIds.length,
      successCount,
      failedCount: result.failedThreadIds.length,
      failedThreadIds: result.failedThreadIds,
      ...(result.label && {
        [taxonomy.resultKeys.id]: result.label.labelId,
        [taxonomy.resultKeys.name]: result.label.labelName,
      }),
    };
  }

  const results = await mapWithConcurrency(
    accountGroups,
    ACCOUNT_WRITE_CONCURRENCY,
    async ({ account, threadIds: accountThreadIds }) => {
      try {
        return {
          account,
          requested: accountThreadIds,
          result: await runThreadActionsInAccount({
            options,
            account,
            threadIds: accountThreadIds,
            parsedInput,
            taxonomy: getManageInboxTaxonomy(account.provider),
          }),
        };
      } catch (error) {
        options.logger.warn("Inbox action failed in an account", {
          actionEmailAccountId: account.id,
          error,
        });
        return {
          account,
          requested: accountThreadIds,
          result: {
            labelError:
              describeProviderRateLimitError(error, account.provider) ??
              "Failed to update emails",
          },
        };
      }
    },
  );

  const failedThreadIds = [
    ...results.flatMap(({ requested, result }) =>
      "labelError" in result
        ? requested.map((item) => item.requested)
        : result.failedThreadIds,
    ),
    ...notOwned,
  ];
  const label = results.flatMap(({ result }) =>
    "label" in result && result.label ? [result.label] : [],
  )[0];

  return {
    success: failedThreadIds.length === 0,
    action: parsedInput.originalAction,
    requestedCount: threadIds.length,
    successCount: threadIds.length - failedThreadIds.length,
    failedCount: failedThreadIds.length,
    failedThreadIds,
    ...(label && {
      [taxonomy.resultKeys.id]: label.labelId,
      [taxonomy.resultKeys.name]: label.labelName,
    }),
    accounts: [
      ...results.map(({ account, requested, result }) =>
        "labelError" in result
          ? {
              account: account.email,
              requestedCount: requested.length,
              successCount: 0,
              failedCount: requested.length,
              error: result.labelError,
            }
          : {
              account: account.email,
              requestedCount: requested.length,
              successCount: requested.length - result.failedThreadIds.length,
              failedCount: result.failedThreadIds.length,
            },
      ),
      ...(notOwned.length
        ? [
            {
              account: null,
              requestedCount: notOwned.length,
              successCount: 0,
              failedCount: notOwned.length,
              error: OTHER_ACCOUNT_EMAIL_NOT_FOUND,
            },
          ]
        : []),
    ],
  };
}

/**
 * One account's share of a thread action. Its label or category must
 * already exist there: another account's is looked up, never created
 * (D-008).
 */
async function runThreadActionsInAccount({
  options: { emailAccountId, logger },
  account,
  threadIds,
  parsedInput: { action, labelName, read },
  taxonomy,
}: {
  options: InboxToolOptions;
  account: ChatAccount;
  threadIds: AccountThreadId[];
  parsedInput: NormalizedManageInboxInput;
  taxonomy: ManageInboxTaxonomyConfig;
}): Promise<
  | {
      failedThreadIds: string[];
      label: { labelId: string; labelName: string } | null;
    }
  | { labelError: string }
> {
  const emailProvider = await createEmailProvider({
    emailAccountId: account.id,
    provider: account.provider,
    logger,
  });
  const isChatAccount = account.id === emailAccountId;

  let archiveLabelId: string | undefined;
  if (action === "archive_threads" && labelName) {
    archiveLabelId = isChatAccount
      ? ((await resolveLabelNameAndId({ emailProvider, label: labelName }))
          .labelId ?? undefined)
      : ((await emailProvider.getLabelByName(labelName))?.id ?? undefined);
  }

  let label: { labelId: string; labelName: string } | null = null;
  if (isThreadLabelAction(action)) {
    try {
      label = await resolveThreadLabel({
        emailProvider,
        labelName: labelName!,
        action,
        matchNestedLabels: isGoogleProvider(account.provider),
        missingLabelError: taxonomy.missingLabelError,
      });
    } catch (error) {
      logger.warn("Failed to resolve label for thread action", {
        error,
        labelName,
      });
      return {
        labelError:
          error instanceof Error
            ? error.message
            : taxonomy.labelResolutionFallbackError,
      };
    }
  }

  const results = await runThreadActionsInParallel({
    threadIds: threadIds.map((item) => item.providerId),
    concurrency: THREAD_ACTION_CONCURRENCY,
    runAction: async (threadId) => {
      if (action === "archive_threads") {
        await emailProvider.archiveThreadWithLabel(
          threadId,
          account.email,
          archiveLabelId,
        );
      } else if (action === "trash_threads") {
        await emailProvider.trashThread(threadId, account.email, "user");
      } else if (action === "label_threads") {
        await applyLabelToThread({
          emailProvider,
          threadId,
          labelId: label!.labelId,
          labelName: label!.labelName,
        });
      } else if (action === "remove_label_threads") {
        await emailProvider.removeThreadLabel(threadId, label!.labelId);
      } else {
        await emailProvider.markReadThread(threadId, read ?? true);
      }
    },
  });

  return {
    failedThreadIds: results.flatMap((result, index) =>
      result.success ? [] : [threadIds[index].requested],
    ),
    label,
  };
}

/**
 * A sender-wide action in every covered account that has mail from the
 * sender, with each account's result. A user with one covered account gets
 * that account's result as it always has.
 */
async function runSenderActionsAcrossAccounts({
  options,
  action,
  originalAction,
  fromEmails,
}: {
  options: InboxToolOptions;
  action: ManageInboxAction;
  originalAction: string;
  fromEmails: string[];
}) {
  const { userId, emailAccountId, email, provider, logger } = options;
  const chatAccount: ChatAccount = { id: emailAccountId, email, provider };
  const selection = await selectOtherAccounts({ userId, emailAccountId }).catch(
    (error) => {
      logger.warn("Could not list the user's accounts for a sender action", {
        error,
      });
      return null;
    },
  );

  if (!selection?.accounts.length) {
    const result = await runSenderActionsInAccount({
      account: chatAccount,
      action,
      fromEmails,
      onlySendersWithMail: false,
      logger,
    });
    return { action: originalAction, ...result };
  }

  const runInAccount = (account: ChatAccount) =>
    runSenderActionsInAccount({
      account,
      action,
      fromEmails,
      onlySendersWithMail: true,
      logger: logger.with({ actionEmailAccountId: account.id }),
    }).catch((error) => {
      logger.warn("Sender action failed in an account", {
        actionEmailAccountId: account.id,
        error,
      });
      return {
        error:
          describeProviderRateLimitError(error, account.provider) ??
          "Failed to update emails",
      };
    });
  // A write runs to the end in every account, as the thread writes do: one
  // cut off by a read deadline would be reported as not done, and a retry
  // would unsubscribe again where it had finished.
  const accounts = await mapWithConcurrency(
    [chatAccount, ...selection.accounts],
    ACCOUNT_WRITE_CONCURRENCY,
    async (account) => ({
      account: account.email,
      ...(await runInAccount(account)),
    }),
  );
  const succeeded = new Set(
    accounts.flatMap((entry) =>
      "senders" in entry
        ? entry.senders.filter(
            (sender) =>
              !("failedSenders" in entry) ||
              !entry.failedSenders?.includes(sender),
          )
        : [],
    ),
  );
  const failedSenders = [
    ...new Set(
      accounts.flatMap((entry) =>
        "failedSenders" in entry ? (entry.failedSenders ?? []) : [],
      ),
    ),
  ];
  const failedAccounts = accounts.filter((entry) => "error" in entry);

  return {
    success: failedSenders.length === 0 && failedAccounts.length === 0,
    action: originalAction,
    sendersCount: fromEmails.length,
    senders: fromEmails,
    ...(action === "unsubscribe_senders" && {
      successCount: succeeded.size,
      failedCount: failedSenders.length,
      failedSenders,
    }),
    accounts,
    ...(selection.notSearchedCount
      ? { accountsNotSearched: selection.notSearchedCount }
      : {}),
  };
}

async function runSenderActionsInAccount({
  account,
  action,
  fromEmails,
  onlySendersWithMail,
  logger,
}: {
  account: ChatAccount;
  action: ManageInboxAction;
  fromEmails: string[];
  /** Acts only for senders this account has mail from. */
  onlySendersWithMail: boolean;
  logger: Logger;
}) {
  const emailProvider = await createEmailProvider({
    emailAccountId: account.id,
    provider: account.provider,
    logger,
  });
  const senders = onlySendersWithMail
    ? await findSendersWithMail({ emailProvider, fromEmails })
    : fromEmails;
  if (!senders.length) {
    return { success: true, sendersCount: 0, senders };
  }

  if (action === "unsubscribe_senders") {
    const unsubscribeResults = await runSenderUnsubscribeActions({
      fromEmails: senders,
      emailProvider,
      emailAccountId: account.id,
      logger,
    });
    const failedSenders = unsubscribeResults
      .filter((result) => !result.success)
      .map((result) => result.senderEmail);

    await emailProvider.bulkArchiveFromSenders(
      senders,
      account.email,
      account.id,
    );

    return {
      success: failedSenders.length === 0,
      sendersCount: senders.length,
      senders,
      successCount: unsubscribeResults.length - failedSenders.length,
      failedCount: failedSenders.length,
      failedSenders,
      autoUnsubscribeCount: unsubscribeResults.filter(
        (result) => result.success && result.unsubscribe.success,
      ).length,
      autoUnsubscribeAttemptedCount: unsubscribeResults.filter(
        (result) => result.unsubscribe.attempted,
      ).length,
    };
  }

  await emailProvider.bulkArchiveFromSenders(
    senders,
    account.email,
    account.id,
  );
  return { success: true, sendersCount: senders.length, senders };
}

async function findSendersWithMail({
  emailProvider,
  fromEmails,
}: {
  emailProvider: EmailProvider;
  fromEmails: string[];
}) {
  const results = await runWithBoundedConcurrency({
    items: fromEmails,
    concurrency: SENDER_LOOKUP_CONCURRENCY,
    run: async (senderEmail) =>
      (
        await emailProvider.getMessagesFromSender({
          senderEmail,
          maxResults: 1,
        })
      ).messages.length > 0,
  });
  // A sender whose mail could not be checked is acted on, so its failure
  // is reported rather than skipped.
  return results.flatMap(({ item, result }) =>
    result.status === "rejected" || result.value ? [item] : [],
  );
}

function getManageInboxTaxonomy(provider: string) {
  return isMicrosoftProvider(provider) ? OUTLOOK_TAXONOMY : GMAIL_TAXONOMY;
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
  options,
  taxonomy,
  confirmation,
  abortSignal,
}: {
  parsedInput: NormalizedManageInboxInput & { query: string };
  options: InboxToolOptions;
  taxonomy: ManageInboxTaxonomyConfig;
  confirmation?: { chatId: string; toolCallId: string };
  abortSignal?: AbortSignal;
}) {
  const { userId, email, emailAccountId, provider, logger } = options;
  const { action, labelName, read, query, originalAction } = parsedInput;
  const bulkAction = toMatchingBulkAction(action, read);
  if (!bulkAction) return { error: "This action can't run over a search." };

  const selection = await selectOtherAccounts({ userId, emailAccountId }).catch(
    (error) => {
      logger.warn("Could not list the user's accounts for a search action", {
        error,
      });
      return null;
    },
  );
  const multiAccount = Boolean(selection?.accounts.length);

  let labelId: string | undefined;
  let chatAccountError: string | undefined;
  // The chat's own account is one of the accounts counted: when it can't be
  // reached, the others are still counted, as one of them failing would be.
  let emailProvider: EmailProvider | undefined;
  try {
    emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
  } catch (error) {
    if (!multiAccount) throw error;
    logger.warn("Could not reach the chat's account for a search action", {
      error,
    });
    chatAccountError = ACCOUNT_SEARCH_FAILED;
  }
  if (emailProvider && action === "label_threads") {
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
      const message =
        error instanceof Error
          ? error.message
          : taxonomy.labelResolutionFallbackError;
      if (!multiAccount) return hideToolErrorFromUser({ error: message });
      chatAccountError = message;
    }
  }

  const otherAccounts =
    multiAccount && selection
      ? {
          chatEmail: email,
          previews: (
            await runOnOtherAccounts({
              userId,
              emailAccountId,
              logger,
              abortSignal,
              selection,
              run: (account, signal) =>
                previewMatchingInOtherAccount({
                  account,
                  chatProvider: provider,
                  query,
                  bulkAction,
                  labelName,
                  signal,
                  logger: logger.with({ otherEmailAccountId: account.id }),
                }),
            })
          ).results.map(
            (entry): OtherAccountMatchingPreview =>
              "error" in entry
                ? { account: entry.account, error: entry.error }
                : { account: entry.account, ...entry.result },
          ),
        }
      : undefined;

  return previewMatchingQueryAction({
    originalAction,
    query,
    bulkAction,
    labelId,
    chatAccountError,
    emailProvider,
    emailAccountId,
    provider,
    otherAccounts,
    confirmation,
    abortSignal,
  });
}

/**
 * What a search-wide action would change in one of the user's other
 * accounts. Only a search that carries over exactly is acted on, and only a
 * label or category that already exists there (D-008).
 */
async function previewMatchingInOtherAccount({
  account,
  chatProvider,
  query,
  bulkAction,
  labelName,
  signal,
  logger,
}: {
  account: ChatAccount;
  chatProvider: string;
  query: string;
  bulkAction: NonNullable<ReturnType<typeof toMatchingBulkAction>>;
  labelName?: string | null;
  signal: AbortSignal;
  logger: Logger;
}): Promise<
  | { error: string }
  | {
      search: AccountSearch;
      labelId?: string;
      count: Extract<
        Awaited<ReturnType<typeof countMatchingInAccount>>,
        { total: number }
      >;
    }
> {
  const search = searchForAccount({
    query,
    from: chatProvider,
    to: account.provider,
  });
  if (!search)
    return { error: "Nothing in this search applies to this account." };

  const emailProvider = await createEmailProvider({
    emailAccountId: account.id,
    provider: account.provider,
    logger,
  });
  signal.throwIfAborted();
  let labelId: string | undefined;
  if (bulkAction === "label") {
    const label = labelName
      ? await emailProvider.getLabelByName(labelName)
      : null;
    if (!label)
      return {
        error: getManageInboxTaxonomy(account.provider).missingLabelError(
          labelName ?? "",
          "label_threads",
        ),
      };
    labelId = label.id;
  }
  const count = await countMatchingInAccount({
    search,
    provider: account.provider,
    bulkAction,
    emailProvider,
    abortSignal: signal,
  });
  if ("error" in count) return count;
  return { search, ...(labelId ? { labelId } : {}), count };
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

import { z } from "zod";
import {
  ActionType,
  GroupItemType,
  LogicalOperator,
} from "@/generated/prisma/enums";
import { messageContextSchema } from "@/utils/ai/assistant/chat-context-validation";
import { inlineEmailActionSchema } from "@/utils/ai/assistant/inline-email-actions";

export const ASSISTANT_CHAT_MAX_TEXT_LENGTH = 20_000;
export const ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE =
  "Messages can be up to 20,000 characters.";

export const assistantPendingEmailActionTypeSchema = z.enum([
  "send_email",
  "reply_email",
  "forward_email",
]);
export type AssistantPendingEmailActionType = z.infer<
  typeof assistantPendingEmailActionTypeSchema
>;

const confirmationResultSchema = z.object({
  actionType: assistantPendingEmailActionTypeSchema,
  messageId: z.string().nullish(),
  threadId: z.string().nullish(),
  externalUrl: z.string().nullish(),
  to: z.string().nullish(),
  subject: z.string().nullish(),
  confirmedAt: z.string().min(1),
});
export type AssistantEmailConfirmationResult = z.infer<
  typeof confirmationResultSchema
>;

export const pendingSendEmailToolOutputSchema = z.object({
  success: z.boolean().optional(),
  actionType: z.literal("send_email"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  emailAccountId: z.string().min(1).optional(),
  provider: z.string().optional(),
  pendingAction: z.object({
    to: z.string().trim().min(1),
    cc: z.string().nullish(),
    bcc: z.string().nullish(),
    subject: z.string().trim().min(1),
    messageHtml: z.string().trim().min(1),
    from: z.string().nullish(),
  }),
  confirmationResult: confirmationResultSchema.optional(),
});
export type PendingSendEmailToolOutput = z.infer<
  typeof pendingSendEmailToolOutputSchema
>;

export const pendingReplyEmailToolOutputSchema = z.object({
  success: z.boolean().optional(),
  actionType: z.literal("reply_email"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  emailAccountId: z.string().min(1).optional(),
  pendingAction: z.object({
    messageId: z.string().trim().min(1),
    content: z.string().trim().min(1),
  }),
  reference: z
    .object({
      messageId: z.string().trim().min(1),
      threadId: z.string().trim().min(1),
      from: z.string().nullish(),
      subject: z.string().nullish(),
    })
    .optional(),
  confirmationResult: confirmationResultSchema.optional(),
});
export type PendingReplyEmailToolOutput = z.infer<
  typeof pendingReplyEmailToolOutputSchema
>;

export const pendingForwardEmailToolOutputSchema = z.object({
  success: z.boolean().optional(),
  actionType: z.literal("forward_email"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  emailAccountId: z.string().min(1).optional(),
  pendingAction: z.object({
    messageId: z.string().trim().min(1),
    to: z.string().trim().min(1),
    cc: z.string().nullish(),
    bcc: z.string().nullish(),
    content: z.string().nullish(),
  }),
  reference: z
    .object({
      messageId: z.string().trim().min(1),
      threadId: z.string().trim().min(1),
      from: z.string().nullish(),
      subject: z.string().nullish(),
    })
    .optional(),
  confirmationResult: confirmationResultSchema.optional(),
});
export type PendingForwardEmailToolOutput = z.infer<
  typeof pendingForwardEmailToolOutputSchema
>;

export type AssistantPendingEmailToolOutput =
  | PendingSendEmailToolOutput
  | PendingReplyEmailToolOutput
  | PendingForwardEmailToolOutput;

const confirmAssistantActionBaseBody = z.object({
  chatId: z.string().trim().min(1),
  chatMessageId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1),
});

export const confirmAssistantEmailActionBody =
  confirmAssistantActionBaseBody.extend({
    actionType: assistantPendingEmailActionTypeSchema,
    contentOverride: z.string().trim().min(1).optional(),
  });
export type ConfirmAssistantEmailActionBody = z.infer<
  typeof confirmAssistantEmailActionBody
>;

export const pendingCreateRuleToolOutputSchema = z.object({
  success: z.literal(true),
  actionType: z.literal("create_rule"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  riskMessages: z.array(z.string()),
  ruleId: z.string().trim().min(1).optional(),
  confirmationResult: z
    .object({
      ruleId: z.string().trim().min(1),
      confirmedAt: z.string().min(1),
    })
    .optional(),
});
export type PendingCreateRuleToolOutput = z.infer<
  typeof pendingCreateRuleToolOutputSchema
>;

export const confirmAssistantCreateRuleBody = confirmAssistantActionBaseBody;
export type ConfirmAssistantCreateRuleBody = z.infer<
  typeof confirmAssistantCreateRuleBody
>;

// The confirmed apply uses these output fields (what the card showed), never
// the raw tool input, so the user approves exactly what gets written.
export const pendingUpdateRuleToolOutputSchema = z.object({
  success: z.literal(true),
  actionType: z.literal("update_rule"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  riskMessages: z.array(z.string()),
  ruleId: z.string().trim().min(1),
  ruleFingerprint: z.string().min(1),
  originalName: z.string(),
  updatedName: z.string().trim().min(1),
  originalEnabled: z.boolean(),
  updatedEnabled: z.boolean(),
  updatedConditions: z
    .object({
      aiInstructions: z.string().optional(),
      clearAiInstructions: z.boolean().optional(),
      static: z
        .object({
          from: z.string().nullish(),
          to: z.string().nullish(),
          subject: z.string().nullish(),
        })
        .nullish(),
      conditionalOperator: z
        .enum([LogicalOperator.AND, LogicalOperator.OR])
        .nullish(),
    })
    .optional(),
  updatedActions: z
    .array(
      z.object({
        type: z.nativeEnum(ActionType),
        fields: z.record(z.string(), z.string().nullable()).nullish(),
        delayInMinutes: z.number().nullish(),
      }),
    )
    .min(1)
    .optional(),
  confirmationResult: z
    .object({
      ruleId: z.string().trim().min(1),
      confirmedAt: z.string().min(1),
    })
    .optional(),
});

export const confirmAssistantUpdateRuleBody = confirmAssistantActionBaseBody;

export const pendingLearnedPatternsToolOutputSchema = z.object({
  success: z.literal(true),
  actionType: z.literal("update_learned_patterns"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  riskMessages: z.array(z.string()),
  ruleId: z.string().trim().min(1),
  ruleName: z.string(),
  ruleFingerprint: z.string().min(1),
  patterns: z
    .array(
      z.object({
        type: z.nativeEnum(GroupItemType),
        value: z.string().min(1),
        exclude: z.boolean().optional(),
      }),
    )
    .min(1),
  outboundActions: z.array(
    z.object({
      type: z.string(),
      fields: z.record(z.string(), z.string().nullable()).nullish(),
    }),
  ),
  confirmationResult: z
    .object({ ruleId: z.string(), confirmedAt: z.string().min(1) })
    .optional(),
});
export type PendingLearnedPatternsToolOutput = z.infer<
  typeof pendingLearnedPatternsToolOutputSchema
>;

export const confirmAssistantLearnedPatternsBody =
  confirmAssistantActionBaseBody;

export const pendingSaveMemoryToolOutputSchema = z.object({
  success: z.literal(true),
  actionType: z.literal("save_memory"),
  requiresConfirmation: z.literal(true),
  confirmationState: z.enum(["pending", "processing", "confirmed"]),
  confirmationProcessingAt: z.string().optional(),
  content: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
  confirmationResult: z
    .object({
      content: z.string().trim().min(1),
      confirmedAt: z.string().min(1),
      deduplicated: z.boolean().optional(),
    })
    .optional(),
});
export type PendingSaveMemoryToolOutput = z.infer<
  typeof pendingSaveMemoryToolOutputSchema
>;

export const confirmAssistantSaveMemoryBody = confirmAssistantActionBaseBody;

export type ConfirmAssistantSaveMemoryBody = z.infer<
  typeof confirmAssistantSaveMemoryBody
>;

// The card's answer to a manageInbox preview over a whole search. The search
// is sent back so the server can check it against the token's hash; the
// token itself never holds it.
export const confirmAssistantMatchingActionBody =
  confirmAssistantActionBaseBody.extend({
    confirmToken: z.string().uuid(),
    query: z.string().max(500),
  });

export const cancelAssistantMatchingActionBody =
  confirmAssistantActionBaseBody.extend({
    confirmToken: z.string().uuid(),
  });

const assistantChatTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(ASSISTANT_CHAT_MAX_TEXT_LENGTH),
});

const assistantChatFilePartSchema = z.object({
  type: z.literal("file"),
  url: z
    .string()
    .max(6_000_000)
    .refine((url) => /^data:image\/(jpeg|png|webp|gif);base64,/.test(url), {
      message: "URL must be a base64 data URL with an allowed image MIME type",
    }),
  filename: z.string().optional(),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
});

const assistantChatMessagePartSchema = z.discriminatedUnion("type", [
  assistantChatTextPartSchema,
  assistantChatFilePartSchema,
]);

// A provider id, or one named with another of the user's accounts as
// `acct:<emailAccountId>:<providerId>` (see other-account-email-id.ts).
const providerIdSchema = z
  .string()
  .trim()
  .regex(/^(?:acct:[\w=+/.-]{1,200}:)?[\w=+/.-]{1,200}$/);

export const assistantInputSchema = z.object({
  id: z.string().trim().min(1),
  message: z.object({
    id: z.string().trim().min(1),
    role: z.enum(["user"]),
    parts: z
      .array(assistantChatMessagePartSchema)
      .refine((parts) => parts.filter((p) => p.type === "file").length <= 5, {
        message: "Maximum 5 file attachments per message",
      }),
  }),
  context: messageContextSchema.optional(),
  inlineActions: z.array(inlineEmailActionSchema).max(20).optional(),
  // Clients that can't render the assistant's inline email card markup would
  // show it as raw XML, so cards are opt-in per client.
  supportsInlineEmailCards: z.boolean().optional().default(false),
  // The thread open in the reader as the message is sent, so "this email"
  // has an id the assistant can use. It goes into the model's context, so it
  // may only contain the characters provider thread ids use.
  openThreadId: providerIdSchema.optional(),
  // Its latest message, so the assistant can read the email itself.
  openMessageId: providerIdSchema.optional(),
  // The browser holds this account's mail locally and can answer the
  // assistant's inbox searches from it.
  localMailSearch: z.boolean().optional().default(false),
  // The query syntaxes its local search reads. Tabs from before Outlook
  // support send only `localMailSearch` and read Gmail's syntax alone.
  // Syntaxes this server does not know are dropped rather than refused.
  // It can also count everything a search matches. Older tabs only search.
  localMailCount: z.boolean().optional().default(false),
  localMailSearchSyntaxes: z
    .array(z.string().max(32))
    .max(8)
    .optional()
    .default([])
    .transform((syntaxes) =>
      LOCAL_MAIL_SEARCH_SYNTAXES.filter((syntax) => syntaxes.includes(syntax)),
    ),
});

export const LOCAL_MAIL_SEARCH_SYNTAXES = ["gmail", "outlook"] as const;

export type AssistantInput = z.infer<typeof assistantInputSchema>;

export const stopAssistantChatSchema = z.object({
  activeStreamId: z.string().trim().min(1).optional(),
});

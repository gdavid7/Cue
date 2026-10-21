import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import {
  cleanupThreadAIDrafts,
  hasLearnableComposeAssistOutcome,
  sentReplyAnswers,
  trackSentDraftStatus,
} from "./draft-tracking";

const similarityMocks = vi.hoisted(() => ({
  calculateSimilarity: vi.fn(),
  calculateSimilarityDetails: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-retry", () => ({
  withPrismaRetry: vi.fn().mockImplementation((fn) => fn()),
}));
vi.mock("@/utils/similarity-score", () => similarityMocks);
vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  isDraftUnmodified: vi.fn(),
}));
vi.mock("@/utils/ai/reply/reply-memory", () => ({
  getReplyMemoryRetentionCutoff: vi.fn(
    () => new Date("2026-03-10T10:00:00.000Z"),
  ),
  isMeaningfulDraftEdit: vi.fn(),
  // The rule itself is tested in reply-memory.test.ts.
  isUsedStartingDraft: vi.fn(() => true),
  saveDraftSendLogReplyMemory: vi.fn().mockResolvedValue(undefined),
  syncReplyMemoriesFromDraftSendLogs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/analytics/activation", () => ({
  recordFirstSuggestedReplySent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/messaging/rule-notifications", () => ({
  replaceMessagingDraftNotificationsWithDraftSentState: vi
    .fn()
    .mockResolvedValue(undefined),
  replaceMessagingDraftNotificationsWithHandledOnWebState: vi
    .fn()
    .mockResolvedValue(undefined),
}));

import {
  calculateSimilarity,
  calculateSimilarityDetails,
} from "@/utils/similarity-score";
import { isDraftUnmodified } from "@/utils/ai/choose-rule/draft-management";
import { recordFirstSuggestedReplySent } from "@/utils/analytics/activation";
import {
  isMeaningfulDraftEdit,
  isUsedStartingDraft,
  saveDraftSendLogReplyMemory,
  syncReplyMemoriesFromDraftSendLogs,
} from "@/utils/ai/reply/reply-memory";
import {
  replaceMessagingDraftNotificationsWithDraftSentState,
  replaceMessagingDraftNotificationsWithHandledOnWebState,
} from "@/utils/messaging/rule-notifications";

const logger = createTestLogger();

describe("trackSentDraftStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(calculateSimilarityDetails).mockImplementation(
      (storedContent, providerMessage, options) => ({
        score: calculateSimilarity(storedContent, providerMessage, options),
        normalizedStoredContentLength: storedContent?.length ?? 0,
        normalizedProviderMessageLength:
          typeof providerMessage === "string" ? providerMessage.length : 0,
      }),
    );
    vi.mocked(prisma.draftSendLog.create).mockResolvedValue({
      id: "draft-send-log-1",
    } as any);
    vi.mocked(prisma.executedAction.update).mockResolvedValue({} as any);
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { id: "draft-send-log-1" },
      {},
    ] as any);
  });

  it("queues reply memory learning for meaningful edited sends", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    const provider = {
      getDraft: vi.fn().mockResolvedValue(null),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executedRule: expect.objectContaining({
            emailAccountId: "account-1",
            threadId: "thread-1",
          }),
          type: ActionType.DRAFT_EMAIL,
        }),
      }),
    );
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        draftSendLogId: "draft-send-log-1",
        sentText: "Please include pricing for seat counts.",
      }),
    );
    expect(
      replaceMessagingDraftNotificationsWithDraftSentState,
    ).toHaveBeenCalledWith({
      executedRuleId: "executed-rule-1",
      logger,
    });
    expect(
      replaceMessagingDraftNotificationsWithHandledOnWebState,
    ).not.toHaveBeenCalled();
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.LIKELY_SENT,
      },
    });
    expect(syncReplyMemoriesFromDraftSendLogs).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider,
      logger,
    });
  });

  it("collapses stale messaging draft notifications when the user replies on the web", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.14);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue({
          id: "draft-1",
        }),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(
      replaceMessagingDraftNotificationsWithHandledOnWebState,
    ).toHaveBeenCalledWith({
      executedRuleId: "executed-rule-1",
      logger,
    });
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executedActionId: "action-1",
        sentMessageId: "sent-1",
        similarityScore: 0.14,
        bodySimilarityScore: 0.14,
        bodySimilarityStatus: "scored",
        sentText: "Please include pricing for seat counts.",
        similarityMetadata: expect.objectContaining({
          draft: expect.objectContaining({
            comparableBodyLength: "Thanks for reaching out.".length,
          }),
          sent: expect.objectContaining({
            extractedReplyLength: 39,
            selectedBodySource: "html",
          }),
        }),
      }),
    });
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
      },
    });
  });

  it("passes the saved account signature to similarity scoring", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Generated reply.\n\nSaved account signature",
      executedRuleId: "executed-rule-1",
      executedRule: {
        messageId: "source-1",
        emailAccount: { signature: "Saved account signature" },
      },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.12);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue({ id: "draft-1" }),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          executedRule: {
            select: {
              messageId: true,
              emailAccount: { select: { signature: true } },
            },
          },
        }),
      }),
    );
    expect(calculateSimilarity).toHaveBeenCalledWith(
      "Generated reply.\n\nSaved account signature",
      expect.objectContaining({ id: "sent-1" }),
      { excludedSignatures: ["Saved account signature"] },
    );
  });

  it("marks missing drafts as likely sent when the sent reply is similar enough", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.72);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockRejectedValue(new Error("missing source")),
      } as any,
      logger,
    });

    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.LIKELY_SENT,
      },
    });
    expect(
      replaceMessagingDraftNotificationsWithDraftSentState,
    ).toHaveBeenCalledWith({
      executedRuleId: "executed-rule-1",
      logger,
    });
    expect(recordFirstSuggestedReplySent).toHaveBeenCalledWith("account-1");
  });

  it("treats sent messages to someone else as ignored drafts and skips learning", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.08);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createInternalForwardedSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executedActionId: "action-1",
        sentMessageId: "sent-internal-forward-1",
        similarityScore: 0.08,
        bodySimilarityScore: 0.08,
        bodySimilarityStatus: "scored",
        sentText: "Can someone check this?",
        similarityMetadata: expect.objectContaining({
          lifecycle: expect.objectContaining({
            sentMessageRepliesToSource: false,
          }),
        }),
      }),
    });
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { draftStatus: DraftEmailStatus.REPLIED_WITHOUT_DRAFT },
    });
    expect(isMeaningfulDraftEdit).not.toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
    expect(syncReplyMemoriesFromDraftSendLogs).not.toHaveBeenCalled();
    expect(recordFirstSuggestedReplySent).not.toHaveBeenCalled();
  });

  it("keeps learning from replies with forwarded blocks when sent to the source sender", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    const provider = {
      getDraft: vi.fn().mockResolvedValue(null),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createForwardedReplySentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        draftSendLogId: "draft-send-log-1",
        sentText: "Thanks, please use annual billing.",
      }),
    );
    expect(syncReplyMemoriesFromDraftSendLogs).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider,
      logger,
    });
  });

  it("skips reply memory learning when the edit is not meaningful", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.98);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
    expect(syncReplyMemoriesFromDraftSendLogs).not.toHaveBeenCalled();
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executedActionId: "action-1",
        sentMessageId: "sent-1",
        similarityScore: 0.98,
        bodySimilarityScore: 0.98,
        bodySimilarityStatus: "scored",
        sentText: "Please include pricing for seat counts.",
      }),
    });
    expect(
      replaceMessagingDraftNotificationsWithDraftSentState,
    ).toHaveBeenCalledWith({
      executedRuleId: "executed-rule-1",
      logger,
    });
    expect(
      replaceMessagingDraftNotificationsWithHandledOnWebState,
    ).not.toHaveBeenCalled();
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.LIKELY_SENT,
      },
    });
  });

  it("marks empty extracted sent reply text as non-scorable", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        textPlain: "",
        textHtml: '<div class="gmail_signature">Signature only</div>',
      },
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bodySimilarityScore: null,
        bodySimilarityStatus: "empty_sent_text",
        sentText: null,
        similarityMetadata: expect.objectContaining({
          sent: expect.objectContaining({
            extractedReplyLength: 0,
            selectedBodySource: "html",
          }),
        }),
      }),
    });
  });

  it("marks snippet-only sent bodies as non-scorable for body similarity", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Generated reply.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.22);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        textPlain: undefined,
        textHtml: undefined,
        snippet: "Generated reply.",
      },
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(calculateSimilarity).toHaveBeenCalledTimes(1);
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        similarityScore: 0.22,
        bodySimilarityScore: null,
        bodySimilarityStatus: "snippet_only_sent_body",
        similarityMetadata: expect.objectContaining({
          sent: expect.objectContaining({
            fullBodyAvailable: false,
            selectedBodySource: "snippet",
          }),
        }),
      }),
    });
  });

  it("records body similarity after removing product referral footer text", async () => {
    const draftText =
      'Generated reply.\n\nDrafted by <a href="https://example.com/ref">Inbox Zero</a>.';
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: draftText,
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(calculateSimilarity)
      .mockReturnValueOnce(0.63)
      .mockReturnValueOnce(1);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        textPlain: "Generated reply.\n\nDrafted by Inbox Zero.",
        textHtml: undefined,
      },
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(calculateSimilarity).toHaveBeenNthCalledWith(
      1,
      draftText,
      expect.objectContaining({ id: "sent-1" }),
      { excludedSignatures: [] },
    );
    expect(calculateSimilarity).toHaveBeenNthCalledWith(
      2,
      "Generated reply.",
      "Generated reply.",
      { excludedSignatures: [] },
    );
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        similarityScore: 0.63,
        bodySimilarityScore: 1,
        bodySimilarityStatus: "scored",
        similarityMetadata: expect.objectContaining({
          draft: expect.objectContaining({
            comparableBodyLength: "Generated reply.".length,
          }),
          sent: expect.objectContaining({
            comparableBodyLength: "Generated reply.".length,
          }),
        }),
      }),
    });
  });
});

describe("trackSentDraftStatus for Cue's suggestions in the composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isUsedStartingDraft).mockReturnValue(true);
    vi.mocked(calculateSimilarityDetails).mockImplementation(
      (storedContent, providerMessage, options) => ({
        score: calculateSimilarity(storedContent, providerMessage, options),
        normalizedStoredContentLength: storedContent?.length ?? 0,
        normalizedProviderMessageLength:
          typeof providerMessage === "string" ? providerMessage.length : 0,
      }),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(0.4);
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draftSendLog.create).mockResolvedValue({
      id: "draft-send-log-1",
    } as any);
  });

  it("logs the reply against Cue's suggestions and learns when the user changed one", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);
    const provider = {
      getDraft: vi.fn(),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.composeAssistReply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: "account-1",
          threadId: "thread-1",
          draftSendLog: null,
        }),
      }),
    );
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        composeAssistReplyId: "compose-assist-reply-1",
        sentMessageId: "sent-1",
        sentText: "Please include pricing for seat counts.",
      }),
    });
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith({
      draftSendLogId: "draft-send-log-1",
      sentText: "Please include pricing for seat counts.",
    });
    expect(syncReplyMemoriesFromDraftSendLogs).toHaveBeenCalled();
  });

  it("logs without learning when the reply sent Cue's suggestion as written", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("please include pricing for  seat counts."),
    ]);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
  });

  it("learns through Cue's log when the user changed the draft they started from with Cue's help", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("please include pricing for seat counts."),
    ]);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(prisma.draftSendLog.create)
      .mockResolvedValueOnce({ id: "compose-assist-log" } as any)
      .mockResolvedValueOnce({ id: "suggested-reply-log" } as any);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    // Cue's suggestion went out as written, so on its own it teaches
    // nothing; the change from the saved reply still teaches, through Cue's
    // log so its wording isn't counted as the user's.
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledTimes(1);
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith(
      expect.objectContaining({ draftSendLogId: "compose-assist-log" }),
    );
  });

  it("doesn't learn from a draft the reply didn't start from when Cue wrote it", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("please include pricing for seat counts."),
    ]);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(isUsedStartingDraft).mockReturnValue(false);
    vi.mocked(prisma.draftSendLog.create)
      .mockResolvedValueOnce({ id: "compose-assist-log" } as any)
      .mockResolvedValueOnce({ id: "suggested-reply-log" } as any);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue({ id: "suggested-draft-1" }),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    // The saved reply's draft was still in the mailbox: it wasn't sent, and
    // nothing in this send is the user's edit of it.
    expect(isUsedStartingDraft).toHaveBeenCalledWith({
      source: "suggested-reply",
      draftExists: true,
      similarityScore: 0.4,
    });
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
  });

  it("finds the suggestions made for this reply among others in the thread", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      {
        ...createComposeAssistReply("Suggestions for another message."),
        id: "other-reply",
        messageId: "source-other",
      },
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);
    const getMessage = vi.fn(async (messageId: string) =>
      messageId === "source-other"
        ? {
            ...createSourceMessage(),
            id: "source-other",
            headers: {
              ...createSourceMessage().headers,
              "message-id": "<source-other@example.com>",
            },
          }
        : createSourceMessage(),
    );

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        headers: {
          ...createSentMessage().headers,
          "in-reply-to": "<source-1@example.com>",
        },
      } as ParsedMessage,
      provider: { getDraft: vi.fn(), getMessage } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        composeAssistReplyId: "compose-assist-reply-1",
      }),
    });
    expect(prisma.draftSendLog.create).toHaveBeenCalledTimes(1);
  });

  it("does not learn when the reply went to someone other than the sender", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createForwardedSentMessage(),
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
  });

  it("learns once, from Cue's suggestions, when the reply started from a saved suggested reply", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(prisma.draftSendLog.create)
      .mockResolvedValueOnce({ id: "compose-assist-log" } as any)
      .mockResolvedValueOnce({ id: "suggested-reply-log" } as any);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        suggestedReplyDraftId: "suggested-reply-draft-1",
      }),
    });
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledTimes(1);
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith(
      expect.objectContaining({ draftSendLogId: "compose-assist-log" }),
    );
    expect(syncReplyMemoriesFromDraftSendLogs).toHaveBeenCalledTimes(1);
  });

  it("ignores Cue's suggestions made for another message in the thread", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        headers: {
          ...createSentMessage().headers,
          "in-reply-to": "<other-message@example.com>",
        },
      } as ParsedMessage,
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).not.toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
  });

  it("on a repeated delivery, learns nothing again when the stored log already learned", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Could you kindly provide your pricing?"),
    ]);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(prisma.draftSendLog.create)
      .mockRejectedValueOnce(createDuplicateError())
      .mockResolvedValueOnce({ id: "suggested-reply-log" } as any);
    vi.mocked(prisma.draftSendLog.findUnique).mockResolvedValue({
      id: "stored-compose-log",
      sentText: "Please include pricing for seat counts.",
    } as any);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
  });

  it("on a repeated delivery, lets the draft learn through the stored log when Cue's outcomes teach nothing", async () => {
    vi.mocked(prisma.composeAssistReply.findMany).mockResolvedValue([
      createComposeAssistReply("Please include pricing for seat counts."),
    ]);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(prisma.draftSendLog.create)
      .mockRejectedValueOnce(createDuplicateError())
      .mockResolvedValueOnce({ id: "suggested-reply-log" } as any);
    vi.mocked(prisma.draftSendLog.findUnique).mockResolvedValue({
      id: "stored-compose-log",
      sentText: "Please include pricing for seat counts.",
    } as any);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledTimes(1);
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith(
      expect.objectContaining({ draftSendLogId: "stored-compose-log" }),
    );
  });
});

describe("sentReplyAnswers", () => {
  // createSentMessage's internalDate.
  const sentAt = 1_710_000_000_000;
  const hoursBeforeSend = (hours: number) =>
    new Date(sentAt - hours * 60 * 60 * 1000);

  it("matches the reply to the message its threading headers answer", () => {
    const sentMessage = {
      ...createSentMessage(),
      headers: {
        ...createSentMessage().headers,
        "in-reply-to": "<source-1@example.com>",
      },
    } as ParsedMessage;
    expect(
      sentReplyAnswers({
        sentMessage,
        sourceMessage: createSourceMessage(),
        suggestionsUpdatedAt: hoursBeforeSend(24 * 5),
      }),
    ).toBe(true);
  });

  it("without threading headers, only matches a send soon after Cue was used", () => {
    const args = {
      sentMessage: createSentMessage(),
      sourceMessage: createSourceMessage(),
    };
    expect(
      sentReplyAnswers({ ...args, suggestionsUpdatedAt: hoursBeforeSend(2) }),
    ).toBe(true);
    expect(
      sentReplyAnswers({ ...args, suggestionsUpdatedAt: hoursBeforeSend(24) }),
    ).toBe(false);
    // Suggestions made after the message went out were for another reply.
    expect(
      sentReplyAnswers({ ...args, suggestionsUpdatedAt: hoursBeforeSend(-1) }),
    ).toBe(false);
  });

  it("never matches a message from another thread", () => {
    expect(
      sentReplyAnswers({
        sentMessage: createSentMessage(),
        sourceMessage: { ...createSourceMessage(), threadId: "thread-2" },
        suggestionsUpdatedAt: hoursBeforeSend(1),
      }),
    ).toBe(false);
  });
});

describe("hasLearnableComposeAssistOutcome", () => {
  const accepted = {
    outcome: "accepted" as const,
    request: "Shorter",
    refinements: [],
    original: "Thanks so much for getting back to me so quickly!",
    suggestion: "Thanks for the quick reply!",
  };

  it("skips suggestions sent exactly as Cue wrote them", () => {
    expect(
      hasLearnableComposeAssistOutcome(
        [accepted],
        "Hi Sam,\n\nThanks for the  quick reply!\nSee you Friday.",
      ),
    ).toBe(false);
  });

  it("learns from an accepted suggestion the user then changed", () => {
    expect(
      hasLearnableComposeAssistOutcome([accepted], "Thanks for replying."),
    ).toBe(true);
  });

  it("learns from follow-up requests and discarded suggestions", () => {
    const sent = "Thanks for the quick reply!";
    expect(
      hasLearnableComposeAssistOutcome(
        [{ ...accepted, refinements: ["no exclamation marks"] }],
        sent,
      ),
    ).toBe(true);
    expect(
      hasLearnableComposeAssistOutcome(
        [{ ...accepted, outcome: "discarded" }],
        sent,
      ),
    ).toBe(true);
  });
});

describe("trackSentDraftStatus for saved suggested replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(calculateSimilarityDetails).mockImplementation(
      (storedContent, providerMessage, options) => ({
        score: calculateSimilarity(storedContent, providerMessage, options),
        normalizedStoredContentLength: storedContent?.length ?? 0,
        normalizedProviderMessageLength:
          typeof providerMessage === "string" ? providerMessage.length : 0,
      }),
    );
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draftSendLog.create).mockResolvedValue({
      id: "draft-send-log-1",
    } as any);
  });

  it("logs the send against the original suggestion and learns from the edit", async () => {
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    const provider = {
      getDraft: vi.fn().mockResolvedValue(null),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.suggestedReplyDraft.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account-1",
          threadId: "thread-1",
          draftSendLog: null,
        },
      }),
    );
    expect(provider.getDraft).toHaveBeenCalledWith("suggested-draft-1");
    expect(provider.getMessage).toHaveBeenCalledWith("source-1");
    expect(calculateSimilarity).toHaveBeenCalledWith(
      "Thanks, Wednesday works.",
      expect.anything(),
      { excludedSignatures: ["Best, User"] },
    );
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        suggestedReplyDraftId: "suggested-reply-draft-1",
        sentMessageId: "sent-1",
        similarityScore: 0.52,
        sentText: "Please include pricing for seat counts.",
      }),
    });
    expect(isMeaningfulDraftEdit).toHaveBeenCalledWith(
      expect.objectContaining({ draftText: "Thanks, Wednesday works." }),
    );
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith({
      draftSendLogId: "draft-send-log-1",
      sentText: "Please include pricing for seat counts.",
    });
    expect(syncReplyMemoriesFromDraftSendLogs).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider,
      logger,
    });
    expect(prisma.executedAction.update).not.toHaveBeenCalled();
    expect(
      replaceMessagingDraftNotificationsWithDraftSentState,
    ).not.toHaveBeenCalled();
    expect(recordFirstSuggestedReplySent).toHaveBeenCalledWith("account-1");
  });

  it("does not count a suggestion as sent while its draft is still there", async () => {
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(0.2);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue({ id: "suggested-draft-1" }),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalled();
    expect(recordFirstSuggestedReplySent).not.toHaveBeenCalled();
  });

  it("logs an unchanged send without learning from it", async () => {
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        suggestedReplyDraftId: "suggested-reply-draft-1",
        similarityScore: 1,
      }),
    });
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
    expect(syncReplyMemoriesFromDraftSendLogs).not.toHaveBeenCalled();
  });

  it("does not learn when the reply went to someone other than the sender", async () => {
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(0.2);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createForwardedSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).not.toHaveBeenCalled();
    expect(recordFirstSuggestedReplySent).not.toHaveBeenCalled();
  });

  it("compares against the suggestion when it was saved over a rule draft", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      createdAt: new Date("2026-03-17T10:00:00.000Z"),
      draftId: "suggested-draft-1",
      content: "Rule draft text.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft({
        updatedAt: new Date("2026-03-17T10:05:00.000Z"),
      }),
    );
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        suggestedReplyDraftId: "suggested-reply-draft-1",
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("compares against a rule draft created after the suggestion was saved", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      createdAt: new Date("2026-03-17T11:00:00.000Z"),
      draftId: "draft-1",
      content: "Rule draft text.",
      executedRuleId: "executed-rule-1",
      executedRule: { messageId: "source-1" },
    } as any);
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft(),
    );
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { id: "draft-send-log-1" },
      {},
    ] as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn().mockResolvedValue(null),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ executedActionId: "action-1" }),
    });
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
  });
});

// A rule's reply is a suggestion kept in Cue: no mailbox draft to look for.
describe("trackSentDraftStatus for reply suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(calculateSimilarityDetails).mockImplementation(
      (storedContent, providerMessage, options) => ({
        score: calculateSimilarity(storedContent, providerMessage, options),
        normalizedStoredContentLength: storedContent?.length ?? 0,
        normalizedProviderMessageLength:
          typeof providerMessage === "string" ? providerMessage.length : 0,
      }),
    );
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue(
      createReplySuggestion(),
    );
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { id: "draft-send-log-1" },
      { count: 1 },
    ] as any);
  });

  it("looks for a waiting suggestion as well as a mailbox draft", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue(null);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: { getDraft: vi.fn(), getMessage: vi.fn() } as any,
      logger,
    });

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { draftId: { not: null } },
            { draftStatus: DraftEmailStatus.PENDING, content: { not: null } },
          ],
        }),
      }),
    );
  });

  // Sent from the reader without an edit: the normal send, no draft involved.
  it("counts a suggestion sent as it was, without asking the mailbox for a draft", async () => {
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);
    const provider = {
      getDraft: vi.fn(),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(provider.getDraft).not.toHaveBeenCalled();
    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        executedActionId: "action-1",
        sentMessageId: "sent-1",
        similarityScore: 1,
      }),
    });
    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
    expect(recordFirstSuggestedReplySent).toHaveBeenCalledWith("account-1");
    expect(
      replaceMessagingDraftNotificationsWithDraftSentState,
    ).toHaveBeenCalledWith({ executedRuleId: "executed-rule-1", logger });
  });

  // The draft funnel counts a suggestion sent once: only the send that
  // settled it logs the stage.
  it.each([
    [1, 1],
    [0, 0],
  ])("logs the funnel's sent stage when it settled %s suggestion(s)", async (count, lines) => {
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { id: "draft-send-log-1" },
      { count },
    ] as any);
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);
    const info = vi.spyOn(logger, "info");

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    const sentLines = info.mock.calls.filter(
      ([message, fields]) =>
        message === "Reply suggestion funnel" &&
        (fields as { stage?: string })?.stage === "sent",
    );
    expect(sentLines).toHaveLength(lines);
    info.mockRestore();
  });

  // No draft vanished, so a reply to the sender alone doesn't make it used.
  it("treats a different reply as written without the suggestion, and learns from it", async () => {
    vi.mocked(calculateSimilarity).mockReturnValue(0.2);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    const provider = {
      getDraft: vi.fn(),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.REPLIED_WITHOUT_DRAFT },
    });
    expect(recordFirstSuggestedReplySent).not.toHaveBeenCalled();
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalledWith({
      draftSendLogId: "draft-send-log-1",
      sentText: "Please include pricing for seat counts.",
    });
  });

  // Edited in the reader, it became a mailbox draft: that draft is compared,
  // and the rule's suggestion it came from is settled with it.
  it("settles the rule's suggestion when its edited draft is sent", async () => {
    vi.mocked(prisma.suggestedReplyDraft.findFirst).mockResolvedValue(
      createSuggestedReplyDraft({ executedActionId: "action-1" }),
    );
    vi.mocked(prisma.draftSendLog.create).mockResolvedValue({
      id: "draft-send-log-1",
    } as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.52);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(true);
    vi.mocked(prisma.executedAction.updateMany).mockResolvedValue({
      count: 1,
    });
    const provider = {
      getDraft: vi.fn().mockResolvedValue(null),
      getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
    };

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: provider as any,
      logger,
    });

    expect(prisma.draftSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        suggestedReplyDraftId: "suggested-reply-draft-1",
      }),
    });
    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: {
          in: [DraftEmailStatus.PENDING, DraftEmailStatus.CLEANED_UP_UNUSED],
        },
      },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
    expect(saveDraftSendLogReplyMemory).toHaveBeenCalled();
  });

  // "Thanks!" is close to many replies: only a near-exact send counts.
  it.each([
    [0.8, DraftEmailStatus.REPLIED_WITHOUT_DRAFT],
    [0.9, DraftEmailStatus.LIKELY_SENT],
  ])("needs a near-exact match for a short suggestion (%s)", async (score, status) => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      ...createReplySuggestion(),
      content: "Thanks, works for me!",
    });
    vi.mocked(calculateSimilarity).mockReturnValue(score);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: status },
    });
  });

  it("counts a long suggestion sent with light changes as used", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      ...createReplySuggestion(),
      content:
        "Thanks for the note, Wednesday at three works well for our team.",
    });
    vi.mocked(calculateSimilarity).mockReturnValue(0.75);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: createSentMessage(),
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
  });

  // A rule's reply to someone else isn't a reply to the sender, by design.
  it("counts a suggestion addressed to someone else as used when sent", async () => {
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      ...createReplySuggestion(),
      to: "finance@example.com",
    });
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isMeaningfulDraftEdit).mockReturnValue(false);

    await trackSentDraftStatus({
      emailAccountId: "account-1",
      message: {
        ...createSentMessage(),
        headers: { ...createSentMessage().headers, to: "finance@example.com" },
      },
      provider: {
        getDraft: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(createSourceMessage()),
      } as any,
      logger,
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "action-1",
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.LIKELY_SENT },
    });
  });
});

describe("cleanupThreadAIDrafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.executedAction.update).mockResolvedValue({} as any);
    vi.mocked(prisma.threadTracker.findMany).mockResolvedValue([]);
  });

  it("deletes stale drafts only when the generated reply is unchanged", async () => {
    const draftDetails = createDraftMessage({
      textPlain: "Generated reply\n\nOn Monday wrote:\n> Quote",
    });
    vi.mocked(prisma.executedAction.findMany).mockResolvedValue([
      {
        id: "action-1",
        draftId: "draft-1",
        content: "Generated reply",
      },
    ] as any);
    vi.mocked(calculateSimilarity).mockReturnValue(0.93);
    vi.mocked(isDraftUnmodified).mockReturnValue(true);

    const provider = {
      getDraft: vi.fn().mockResolvedValue(draftDetails),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };

    await cleanupThreadAIDrafts({
      threadId: "thread-1",
      emailAccountId: "account-1",
      provider: provider as any,
      logger,
      excludeMessageId: "message-2",
    });

    expect(isDraftUnmodified).toHaveBeenCalledWith({
      originalContent: "Generated reply",
      currentDraft: draftDetails,
      logger,
    });
    expect(provider.deleteDraft).toHaveBeenCalledWith("draft-1");
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED,
      },
    });
  });

  // A newer message makes earlier suggestions moot; the mailbox is untouched.
  it("settles earlier messages' suggestions without touching the mailbox", async () => {
    vi.mocked(prisma.executedAction.findMany).mockResolvedValue([]);
    const provider = { getDraft: vi.fn(), deleteDraft: vi.fn() };

    await cleanupThreadAIDrafts({
      threadId: "thread-1",
      emailAccountId: "account-1",
      provider: provider as any,
      logger,
      excludeMessageId: "message-2",
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        executedRule: {
          emailAccountId: "account-1",
          threadId: "thread-1",
          messageId: { not: "message-2" },
        },
        type: ActionType.DRAFT_EMAIL,
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED },
    });
    expect(provider.deleteDraft).not.toHaveBeenCalled();
  });

  it("transitions replied-without-draft records after deleting stale drafts", async () => {
    const draftDetails = createDraftMessage({
      textPlain: "Generated reply",
    });
    vi.mocked(prisma.executedAction.findMany).mockResolvedValue([
      {
        id: "action-1",
        draftId: "draft-1",
        draftStatus: DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
        draftSendLog: { id: "draft-send-log-1" },
        content: "Generated reply",
      },
    ] as any);
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isDraftUnmodified).mockReturnValue(true);

    const provider = {
      getDraft: vi.fn().mockResolvedValue(draftDetails),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };

    await cleanupThreadAIDrafts({
      threadId: "thread-1",
      emailAccountId: "account-1",
      provider: provider as any,
      logger,
      excludeMessageId: "message-2",
    });

    expect(provider.deleteDraft).toHaveBeenCalledWith("draft-1");
    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: {
        draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED,
      },
    });
  });

  it("keeps stale drafts when the generated reply was edited", async () => {
    vi.mocked(prisma.executedAction.findMany).mockResolvedValue([
      {
        id: "action-1",
        draftId: "draft-1",
        content: "Generated reply",
      },
    ] as any);
    vi.mocked(calculateSimilarity).mockReturnValue(1);
    vi.mocked(isDraftUnmodified).mockReturnValue(false);

    const provider = {
      getDraft: vi.fn().mockResolvedValue(
        createDraftMessage({
          textPlain: "Generated reply\n\nUser edit",
        }),
      ),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };

    await cleanupThreadAIDrafts({
      threadId: "thread-1",
      emailAccountId: "account-1",
      provider: provider as any,
      logger,
      excludeMessageId: "message-2",
    });

    expect(provider.deleteDraft).not.toHaveBeenCalled();
    expect(prisma.executedAction.update).not.toHaveBeenCalled();
  });
});

function createSentMessage(): ParsedMessage {
  return {
    id: "sent-1",
    threadId: "thread-1",
    internalDate: "1710000000000",
    headers: {
      from: "user@example.com",
      to: "sales@example.com",
      subject: "Re: Pricing question",
      date: "2026-03-17T10:10:00.000Z",
      "message-id": "<sent-1@example.com>",
    },
    textPlain: "Please include pricing for seat counts.",
    textHtml: "<p>Please include pricing for seat counts.</p>",
  } as ParsedMessage;
}

function createInternalForwardedSentMessage(): ParsedMessage {
  return {
    ...createSentMessage(),
    id: "sent-internal-forward-1",
    headers: {
      ...createSentMessage().headers,
      to: "teammate@example.com",
      subject: "Fwd: Pricing question",
    },
    textPlain: `Can someone check this?

---------- Forwarded message ----------
From: sales@example.com
Subject: Pricing question

Can you send pricing?`,
    textHtml: undefined,
  } as ParsedMessage;
}

function createForwardedReplySentMessage(): ParsedMessage {
  return {
    ...createSentMessage(),
    id: "sent-forward-reply-1",
    headers: {
      ...createSentMessage().headers,
      subject: "Re: Pricing question",
    },
    textPlain: `Thanks, please use annual billing.

---------- Forwarded message ----------
From: sales@example.com
Subject: Pricing question

Can you send pricing?`,
    textHtml: undefined,
  } as ParsedMessage;
}

function createSourceMessage(): ParsedMessage {
  return {
    id: "source-1",
    threadId: "thread-1",
    internalDate: "1710000000000",
    headers: {
      from: "Sales <sales@example.com>",
      to: "user@example.com",
      subject: "Pricing question",
      date: "2026-03-17T10:00:00.000Z",
      "message-id": "<source-1@example.com>",
    },
    textPlain: "Can you share pricing for a larger team?",
    textHtml: "<p>Can you share pricing for a larger team?</p>",
  } as ParsedMessage;
}

function createDraftMessage({
  textPlain,
  textHtml,
}: {
  textPlain?: string;
  textHtml?: string;
}): ParsedMessage {
  return {
    id: "draft-message-1",
    threadId: "thread-1",
    internalDate: "1710000000000",
    headers: {
      from: "user@example.com",
      to: "sales@example.com",
      subject: "Re: Pricing question",
      date: "2026-03-17T10:10:00.000Z",
      "message-id": "<draft-message-1@example.com>",
    },
    textPlain,
    textHtml,
  } as ParsedMessage;
}

function createSuggestedReplyDraft(
  overrides: { updatedAt?: Date; executedActionId?: string | null } = {},
): any {
  return {
    id: "suggested-reply-draft-1",
    updatedAt: overrides.updatedAt ?? new Date("2026-03-17T10:05:00.000Z"),
    draftId: "suggested-draft-1",
    messageId: "source-1",
    content: "Thanks, Wednesday works.",
    executedActionId: overrides.executedActionId ?? null,
    emailAccount: { signature: "Best, User" },
  };
}

function createReplySuggestion(): any {
  return {
    id: "action-1",
    createdAt: new Date("2026-03-17T10:00:00.000Z"),
    draftId: null,
    content: "Thanks, Wednesday works.",
    executedRuleId: "executed-rule-1",
    executedRule: {
      messageId: "source-1",
      emailAccount: { signature: "Best, User" },
    },
  };
}

function createForwardedSentMessage(): ParsedMessage {
  return {
    ...createSentMessage(),
    headers: {
      ...createSentMessage().headers,
      to: "teammate@example.com",
      subject: "Fwd: Pricing question",
    },
  } as ParsedMessage;
}

function createComposeAssistReply(suggestion: string): any {
  return {
    id: "compose-assist-reply-1",
    // An hour before createSentMessage was sent.
    updatedAt: new Date(1_710_000_000_000 - 60 * 60 * 1000),
    messageId: "source-1",
    outcomes: [
      {
        outcome: "accepted",
        request: "More formal",
        refinements: [],
        original: "pls send pricing",
        suggestion,
      },
    ],
    emailAccount: { signature: "Best, User" },
  };
}

function createDuplicateError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

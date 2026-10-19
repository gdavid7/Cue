import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { Logger } from "@/utils/logger";
import {
  getReplySuggestionFunnel,
  logReplySuggestionStage,
} from "@/utils/reply-tracker/suggestion-funnel";

vi.mock("@/utils/prisma");

const NOW = new Date("2026-10-19T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("getReplySuggestionFunnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("follows each window's suggestions to the stage they reached", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      // Written 2 days ago: shown, opened, edited, sent lightly edited.
      row({
        createdAt: daysAgo(2),
        shown: true,
        opened: true,
        draftStatus: "LIKELY_SENT",
        editedDraftSimilarity: 0.8,
      }),
      // Written 3 days ago: shown, opened, sent as written without a draft.
      row({
        createdAt: daysAgo(3),
        shown: true,
        opened: true,
        draftStatus: "LIKELY_SENT",
        sentSimilarity: 1,
      }),
      // Written 20 days ago: shown, then dismissed.
      row({ createdAt: daysAgo(20), shown: true, draftStatus: "DISMISSED" }),
      // Written 25 days ago: never shown.
      row({ createdAt: daysAgo(25), draftStatus: "CLEANED_UP_UNUSED" }),
    ] as never);

    const funnel = await getReplySuggestionFunnel(NOW);

    expect(funnel.windows).toEqual([
      {
        days: 7,
        counts: {
          generated: 2,
          shown: 2,
          opened: 2,
          edited: 1,
          sent: 2,
          dismissed: 0,
        },
        sentBySimilarity: { unchanged: 1, light: 1, heavy: 0 },
      },
      {
        days: 30,
        counts: {
          generated: 4,
          shown: 3,
          opened: 2,
          edited: 1,
          sent: 2,
          dismissed: 1,
        },
        sentBySimilarity: { unchanged: 1, light: 1, heavy: 0 },
      },
    ]);
    expect(funnel.truncated).toBe(false);
  });

  // Rule replies from before suggestions were mailbox drafts, and runs whose
  // reply was never written, aren't suggestions.
  it("reads only suggestions kept in Cue, and no content", async () => {
    prisma.executedAction.findMany.mockResolvedValue([]);

    await getReplySuggestionFunnel(NOW);

    const query = prisma.executedAction.findMany.mock.calls[0][0];
    expect(query?.where).toMatchObject({
      type: "DRAFT_EMAIL",
      draftId: null,
      draftStatus: { not: null },
      createdAt: { gte: daysAgo(30) },
    });
    // The cap keeps the newest suggestions.
    expect(query?.orderBy).toEqual({ createdAt: "desc" });
    for (const field of ["content", "to", "cc", "bcc", "subject"])
      expect(query?.select).not.toHaveProperty(field);
  });
});

describe("logReplySuggestionStage", () => {
  it("logs IDs, the stage and similarity numbers only", () => {
    const info = vi.fn();
    const logger = { info } as unknown as Logger;

    logReplySuggestionStage({
      logger,
      stage: "sent",
      executedActionId: "action-1",
      similarityScore: 0.8234,
    });

    expect(info).toHaveBeenCalledWith("Reply suggestion funnel", {
      funnel: "reply-suggestion",
      stage: "sent",
      executedActionId: "action-1",
      similarityScore: 0.82,
      similarityBucket: "light",
    });
  });
});

function row({
  createdAt,
  shown = false,
  opened = false,
  draftStatus,
  sentSimilarity,
  editedDraftSimilarity,
}: {
  createdAt: Date;
  shown?: boolean;
  opened?: boolean;
  draftStatus: string;
  sentSimilarity?: number;
  editedDraftSimilarity?: number;
}) {
  return {
    createdAt,
    draftStatus,
    replySuggestionShownAt: shown ? createdAt : null,
    replySuggestionOpenedAt: opened ? createdAt : null,
    draftSendLog:
      sentSimilarity === undefined ? null : { similarityScore: sentSimilarity },
    suggestedReplyDraft:
      editedDraftSimilarity === undefined
        ? null
        : { draftSendLog: { similarityScore: editedDraftSimilarity } },
  };
}

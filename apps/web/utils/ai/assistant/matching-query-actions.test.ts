import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  getMatchingQueryActions,
  toMatchingBulkAction,
  withoutConfirmToken,
  withoutConfirmTokens,
} from "./matching-query-actions";

describe("toMatchingBulkAction", () => {
  it("runs archive, read state and labels as the inbox's select-all actions", () => {
    expect(toMatchingBulkAction("archive_threads", undefined)).toBe("archive");
    expect(toMatchingBulkAction("mark_read_threads", true)).toBe("mark_read");
    expect(toMatchingBulkAction("mark_read_threads", false)).toBe(
      "mark_unread",
    );
    expect(toMatchingBulkAction("label_threads", undefined)).toBe("label");
    expect(toMatchingBulkAction("categorize_threads", undefined)).toBe("label");
    // Trash has no confirm-and-undo flow here, so it never runs over a search.
    expect(toMatchingBulkAction("trash_threads", undefined)).toBeNull();
  });

  it("names exactly the actions each provider's manageInbox accepts with a query", () => {
    for (const provider of ["google", "microsoft"]) {
      for (const action of getMatchingQueryActions(provider))
        expect(toMatchingBulkAction(action, true)).not.toBeNull();
    }
  });
});

describe("withoutConfirmToken", () => {
  it("keeps the confirm token out of what the model sees", () => {
    expect(
      withoutConfirmToken({ status: "needs_confirmation", confirmToken: "t" }),
    ).toEqual({ status: "needs_confirmation" });
  });
});

describe("withoutConfirmTokens", () => {
  it("removes confirm tokens from stored history before anything reads it", () => {
    const history: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "manageInbox",
            output: {
              type: "json",
              value: { status: "needs_confirmation", confirmToken: "secret" },
            },
          },
        ],
      },
    ];
    expect(JSON.stringify(withoutConfirmTokens(history))).not.toContain(
      "secret",
    );
  });
});

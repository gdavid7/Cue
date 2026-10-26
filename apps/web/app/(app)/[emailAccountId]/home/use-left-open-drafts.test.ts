import { describe, expect, it } from "vitest";
import type { LeftOpenDraft } from "@inboxzero/mail-core/queries";
import {
  LEFT_OPEN_SHOWN_LIMIT,
  selectLeftOpenDrafts,
} from "./use-left-open-drafts";

describe("selectLeftOpenDrafts", () => {
  it("leaves out a draft a send waiting to go out stands in for, in its own account", () => {
    const drafts = [draft("a", "d1"), draft("b", "d1"), draft("a", "d2")];

    const { drafts: shown } = selectLeftOpenDrafts(drafts, [
      { emailAccountId: "a", messageIds: ["d1"] },
    ]);

    // The same id in another account is another message.
    expect(shown.map((item) => [item.accountId, item.messageId])).toEqual([
      ["b", "d1"],
      ["a", "d2"],
    ]);
  });

  it("caps the lane and says when there were more", () => {
    const many = Array.from({ length: LEFT_OPEN_SHOWN_LIMIT + 1 }, (_, i) =>
      draft("a", `d${i}`),
    );

    expect(selectLeftOpenDrafts(many, [])).toMatchObject({ capped: true });
    expect(selectLeftOpenDrafts(many, []).drafts).toHaveLength(
      LEFT_OPEN_SHOWN_LIMIT,
    );
    expect(
      selectLeftOpenDrafts(many.slice(0, LEFT_OPEN_SHOWN_LIMIT), []),
    ).toMatchObject({ capped: false });
    // Hidden drafts don't count toward "more".
    expect(
      selectLeftOpenDrafts(many, [{ emailAccountId: "a", messageIds: ["d0"] }]),
    ).toMatchObject({ capped: false });
  });
});

function draft(accountId: string, messageId: string): LeftOpenDraft {
  return {
    accountId,
    conversationId: messageId,
    messageId,
    subject: "Plans",
    to: [],
    savedAtMs: 0,
  };
}

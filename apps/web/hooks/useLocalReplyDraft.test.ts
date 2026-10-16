// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getReplyDraftForSession } from "@/utils/mail-engine/reply-drafts";
import { useLocalReplyDraft } from "./useLocalReplyDraft";

vi.mock("@/utils/mail-engine/reply-drafts", () => ({
  getReplyDraftForSession: vi.fn(),
  dropReplyDraftDeletedFromMailbox: vi.fn(async (draft) => draft),
}));

const identityFor = (emailAccountId: string) => ({
  emailAccountId,
  threadId: "compose:new-message",
  messageId: "compose:new-message",
});
const draft = (emailAccountId: string, subject: string) => ({
  ...identityFor(emailAccountId),
  content: { values: { subject } } as never,
  revision: 1,
  updatedAt: 0,
});

describe("useLocalReplyDraft", () => {
  // A composer that switches account and straight back must see what was
  // saved meanwhile, not what it loaded the first time.
  it("reloads a draft when its account comes back before another loaded", async () => {
    vi.mocked(getReplyDraftForSession)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(draft("account-a", "Saved before the switch"));

    const { result, rerender } = renderHook(
      ({ accountId }) => useLocalReplyDraft(identityFor(accountId)),
      { initialProps: { accountId: "account-a" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    rerender({ accountId: "account-b" });
    expect(result.current.isLoading).toBe(true);
    rerender({ accountId: "account-a" });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() =>
      expect(result.current.draft?.content?.values.subject).toBe(
        "Saved before the switch",
      ),
    );
  });
});

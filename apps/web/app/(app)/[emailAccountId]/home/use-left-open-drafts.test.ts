// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeftOpenDraft } from "@inboxzero/mail-core/queries";
import {
  CUE_AUTHORED_RECOVERIES,
  CUE_AUTHORED_RECOVERY_MS,
  LEFT_OPEN_SHOWN_LIMIT,
  selectLeftOpenDrafts,
  useLeftOpenDrafts,
} from "./use-left-open-drafts";

const mail = vi.hoisted(() => ({
  // What the local store answers.
  drafts: [] as LeftOpenDraft[],
  client: {} as { capabilities?: string[]; queryLeftOpenDrafts?: unknown },
  // What the server says Cue wrote, per account; a missing account failed.
  cueAuthored: {} as Record<string, string[]>,
  // Drafts the server says it didn't check, per account.
  unchecked: {} as Record<string, string[]>,
  // The status a failed account's read answers with; 503 if unset.
  failStatus: {} as Record<string, number>,
  // Each account the server was asked about, in order.
  serverReads: [] as string[],
  // The local store's drafts revision.
  sequence: 1,
  serverPaths: {} as Record<string, string>,
  // Set to hold the server's answer until released.
  pending: null as Promise<void> | null,
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
vi.mock("@inboxzero/mail-react/use-mailbox-window", () => ({
  useMailboxWindow: (query: { accountIds: string[] }) => ({
    status: "ready",
    revision: { databaseEpoch: 1, sequence: mail.sequence },
    data: {
      conversations: [],
      connection: "ready",
      coverage: query.accountIds.map((accountId) => ({
        accountId,
        scopeId: "account",
        metadata: "complete",
        content: "not_requested",
        indexedContent: "not_requested",
        lastCompletedSyncAtMs: 1,
      })),
    },
  }),
}));
vi.mock("@/hooks/useHiddenDraftMessageIds", () => ({
  useAllAccountsHiddenDraftMessageIds: () => [],
}));
vi.mock("@/utils/fetch-for-accounts", () => ({
  fetchForAccounts: async (path: string, accountIds: string[]) => {
    // The hook asks each account alone.
    expect(accountIds).toHaveLength(1);
    const [accountId] = accountIds;
    mail.serverReads.push(accountId);
    mail.serverPaths[accountId] = path;
    await mail.pending;
    const messageIds = mail.cueAuthored[accountId];
    if (!messageIds)
      throw Object.assign(new Error("failed"), {
        status: mail.failStatus[accountId] ?? 503,
      });
    const asked = (new URL(path, "http://x").searchParams.get("items") ?? "")
      .split(",")
      .map((item) => item.slice(item.lastIndexOf(":") + 1));
    const checkedMessageIds = asked.filter(
      (id) => !mail.unchecked[accountId]?.includes(id),
    );
    return {
      byAccount: [{ accountId, data: { messageIds, checkedMessageIds } }],
      failedAccountIds: [],
    };
  },
}));

const ACCOUNTS = [
  { id: "a", email: "a@example.com" },
  { id: "b", email: "b@example.com" },
];

describe("useLeftOpenDrafts", () => {
  beforeEach(() => {
    mail.drafts = [];
    mail.cueAuthored = {};
    mail.serverReads = [];
    mail.failStatus = {};
    mail.unchecked = {};
    mail.sequence = 1;
    mail.serverPaths = {};
    mail.pending = null;
    mail.client = {
      capabilities: ["method:queryLeftOpenDrafts"],
      queryLeftOpenDrafts: vi.fn(async () => mail.drafts),
    };
  });

  it("leaves out a draft Cue wrote into the mailbox and keeps the user's", async () => {
    mail.drafts = [draft("a", "cue-follow-up"), draft("a", "users-own")];
    mail.cueAuthored = { a: ["cue-follow-up"] };

    const { result } = renderLeftOpenDrafts();

    await waitFor(() =>
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "users-own",
      ]),
    );
  });

  it("shows no draft of an account the server couldn't answer for", async () => {
    mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
    mail.cueAuthored = { b: [] };

    const { result } = renderLeftOpenDrafts();

    await waitFor(() =>
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "b-draft",
      ]),
    );
  });

  it("shows no draft the server says it didn't check", async () => {
    mail.drafts = [draft("a", "unchecked"), draft("a", "users-own")];
    mail.cueAuthored = { a: [] };
    mail.unchecked = { a: ["unchecked"] };

    const { result } = renderLeftOpenDrafts();

    await waitFor(() =>
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "users-own",
      ]),
    );
  });

  it("asks each account only about its own drafts", async () => {
    mail.drafts = [
      draft("a", "a-draft", "a-thread", 1000),
      draft("b", "b-draft", "b-thread", 3000),
      draft("a", "a-older", "a-thread-2", 500),
    ];
    mail.cueAuthored = { a: [], b: [] };

    renderLeftOpenDrafts();

    await waitFor(() => expect(mail.serverPaths.b).toBeDefined());
    const a = new URL(mail.serverPaths.a, "http://x").searchParams;
    expect(a.get("items")?.split(",").sort()).toEqual([
      "a-thread-2:a-older",
      "a-thread:a-draft",
    ]);
    // Each draft's own save time, in the items' order.
    const savedAt = new Map(
      a
        .get("items")
        ?.split(",")
        .map((item, i) => [item, a.get("savedAtMs")?.split(",")[i]]),
    );
    expect(savedAt.get("a-thread:a-draft")).toBe("1000");
    expect(savedAt.get("a-thread-2:a-older")).toBe("500");
    expect(
      new URL(mail.serverPaths.b, "http://x").searchParams.get("items"),
    ).toBe("b-thread:b-draft");
  });

  it("shows nothing while the server hasn't answered", async () => {
    mail.drafts = [draft("a", "users-own")];
    mail.cueAuthored = { a: [] };
    let release = () => {};
    mail.pending = new Promise((resolve) => {
      release = resolve;
    });

    const { result } = renderLeftOpenDrafts();

    await waitFor(() => expect(mail.serverReads).toHaveLength(1));
    expect(result.current.drafts).toEqual([]);
    release();
    await waitFor(() =>
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "users-own",
      ]),
    );
  });

  it("shows nothing when the server couldn't answer for any account", async () => {
    mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];

    const { result } = renderLeftOpenDrafts();

    await waitFor(() => expect(mail.serverReads).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.drafts).toEqual([]);
  });

  describe("when an account couldn't be answered for", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks again for only that account and shows its drafts once it answers", async () => {
      mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
      // Gmail deferred account a's read.
      mail.cueAuthored = { b: [] };

      const { result } = renderLeftOpenDrafts();

      await waitFor(() =>
        expect(result.current.drafts.map((item) => item.messageId)).toEqual([
          "b-draft",
        ]),
      );
      mail.cueAuthored = { a: [], b: [] };
      await vi.advanceTimersByTimeAsync(CUE_AUTHORED_RECOVERY_MS);

      await waitFor(() =>
        expect(
          result.current.drafts.map((item) => item.messageId).sort(),
        ).toEqual(["a-draft", "b-draft"]),
      );
      expect(mail.serverReads.sort()).toEqual(["a", "a", "b"]);
    });

    it("asks again even when every account failed", async () => {
      mail.drafts = [draft("a", "a-draft")];

      const { result } = renderLeftOpenDrafts();

      await waitFor(() => expect(mail.serverReads).toHaveLength(1));
      mail.cueAuthored = { a: [] };
      await vi.advanceTimersByTimeAsync(CUE_AUTHORED_RECOVERY_MS);

      await waitFor(() =>
        expect(result.current.drafts.map((item) => item.messageId)).toEqual([
          "a-draft",
        ]),
      );
    });

    it("stops asking after a few tries", async () => {
      mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
      mail.cueAuthored = { b: [] };

      const { result } = renderLeftOpenDrafts();

      await waitFor(() => expect(mail.serverReads).toHaveLength(2));
      await waitOutRecoveries();

      expect(readsOf("a")).toBe(1 + CUE_AUTHORED_RECOVERIES);
      expect(readsOf("b")).toBe(1);
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "b-draft",
      ]);
    });

    it("still stops after a few tries when the drafts' revision moves mid-recovery", async () => {
      mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
      mail.cueAuthored = { b: [] };

      const { result, rerender } = renderLeftOpenDrafts();
      await waitFor(() => expect(mail.serverReads).toHaveLength(2));

      // Hold the first retry's answer while the drafts are saved again,
      // each save a new revision with the same drafts to ask about.
      let release = () => {};
      mail.pending = new Promise((resolve) => {
        release = resolve;
      });
      await vi.advanceTimersByTimeAsync(CUE_AUTHORED_RECOVERY_MS);
      expect(readsOf("a")).toBe(2);
      for (let move = 1; move <= 3; move++) {
        mail.sequence += 1;
        mail.drafts = mail.drafts.map((d) => ({
          ...d,
          subject: `Plans ${move}`,
        }));
        rerender();
        await waitFor(() =>
          expect(result.current.drafts[0]?.subject).toBe(`Plans ${move}`),
        );
      }
      release();
      mail.pending = null;
      await waitOutRecoveries();

      expect(readsOf("a")).toBe(1 + CUE_AUTHORED_RECOVERIES);
      expect(readsOf("b")).toBe(1);
    });

    it("neither asks again nor updates once unmounted mid-recovery", async () => {
      mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
      mail.cueAuthored = { b: [] };

      const { unmount, cache } = renderLeftOpenDrafts();
      await waitFor(() => expect(mail.serverReads).toHaveLength(2));
      const answered = cachedCueAuthored(cache);
      let release = () => {};
      mail.pending = new Promise((resolve) => {
        release = resolve;
      });
      await vi.advanceTimersByTimeAsync(CUE_AUTHORED_RECOVERY_MS);
      expect(readsOf("a")).toBe(2);

      unmount();
      mail.cueAuthored = { a: [], b: [] };
      release();
      mail.pending = null;
      await waitOutRecoveries();

      expect(readsOf("a")).toBe(2);
      expect(cachedCueAuthored(cache)).toBe(answered);
    });

    it("doesn't ask again for an account with too many of Cue's drafts to check", async () => {
      mail.drafts = [draft("a", "a-draft"), draft("b", "b-draft")];
      mail.cueAuthored = { b: [] };
      mail.failStatus = { a: 409 };

      const { result } = renderLeftOpenDrafts();
      await waitFor(() => expect(mail.serverReads).toHaveLength(2));
      await waitOutRecoveries();

      expect(readsOf("a")).toBe(1);
      expect(result.current.drafts.map((item) => item.messageId)).toEqual([
        "b-draft",
      ]);
    });
  });

  it("asks the server nothing when there are no drafts to show", async () => {
    const { result } = renderLeftOpenDrafts();

    await waitFor(() =>
      expect(mail.client.queryLeftOpenDrafts).toHaveBeenCalled(),
    );
    expect(result.current.drafts).toEqual([]);
    expect(mail.serverReads).toEqual([]);
  });

  it("stays hidden when the engine doesn't say it answers the query", async () => {
    mail.drafts = [draft("a", "users-own")];
    mail.cueAuthored = { a: [] };
    // An older engine relayed by another tab has the method but doesn't
    // advertise it.
    mail.client = {
      capabilities: [],
      queryLeftOpenDrafts: vi.fn(async () => mail.drafts),
    };

    const { result } = renderLeftOpenDrafts();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.drafts).toEqual([]);
    expect(mail.client.queryLeftOpenDrafts).not.toHaveBeenCalled();
  });
});

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

function renderLeftOpenDrafts() {
  const cache = new Map<string, { data?: unknown }>();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => cache } }, children);
  return {
    cache,
    ...renderHook(() => useLeftOpenDrafts({ accounts: ACCOUNTS }), {
      wrapper,
    }),
  };
}

function cachedCueAuthored(cache: Map<string, { data?: unknown }>) {
  const key = [...cache.keys()].find((k) => k.includes("cue-authored-drafts"));
  return key ? cache.get(key)?.data : undefined;
}

function readsOf(accountId: string) {
  return mail.serverReads.filter((id) => id === accountId).length;
}

/** Past every recovery the hook could schedule, and a few more. */
async function waitOutRecoveries() {
  for (let i = 0; i < CUE_AUTHORED_RECOVERIES + 3; i++)
    await vi.advanceTimersByTimeAsync(CUE_AUTHORED_RECOVERY_MS * 2 ** i);
}

function draft(
  accountId: string,
  messageId: string,
  conversationId = messageId,
  savedAtMs = 0,
): LeftOpenDraft {
  return {
    accountId,
    conversationId,
    messageId,
    subject: "Plans",
    to: [],
    savedAtMs,
  };
}

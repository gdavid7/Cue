// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeftOpenDraft } from "@inboxzero/mail-core/queries";
import {
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
  serverReads: [] as string[][],
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
vi.mock("@inboxzero/mail-react/use-mailbox-window", () => ({
  useMailboxWindow: (query: { accountIds: string[] }) => ({
    status: "ready",
    revision: { databaseEpoch: 1, sequence: 1 },
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
  fetchForAccounts: async (_path: string, accountIds: string[]) => {
    mail.serverReads.push(accountIds);
    return {
      byAccount: accountIds.flatMap((accountId) =>
        mail.cueAuthored[accountId]
          ? [{ accountId, data: { messageIds: mail.cueAuthored[accountId] } }]
          : [],
      ),
      failedAccountIds: accountIds.filter(
        (accountId) => !mail.cueAuthored[accountId],
      ),
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
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => cache } }, children);
  return renderHook(() => useLeftOpenDrafts({ accounts: ACCOUNTS }), {
    wrapper,
  });
}

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

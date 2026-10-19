import { describe, expect, it, vi } from "vitest";
import { fetchThreadsPage } from "@/utils/threads/fetch-page";
import { threadsQuery } from "@/utils/threads/validation";
import { getCueMembership } from "@/utils/split-inbox/cue-membership.server";

vi.mock("@/utils/split-inbox/cue-membership.server", () => ({
  getCueMembership: vi.fn(),
}));

describe("fetchThreadsPage", () => {
  it.each([
    { anyLabelIds: ["label-a"] },
    { anyLabelIds: ["label-a", "label-b"] },
  ])("preserves a required singular label when matching any of $anyLabelIds", async ({
    anyLabelIds,
  }) => {
    const emailProvider = {
      getThreadsWithQuery: vi.fn(async ({ query }) => ({
        threads: query.labelIds.includes("required-label")
          ? []
          : [{ id: "outside-required-label", messages: [] }],
      })),
    };

    const result = await fetchThreadsPage({
      emailAccountId: "account-1",
      query: { labelId: "required-label", anyLabelIds },
      emailProvider: emailProvider as never,
      maxResults: 50,
      messageFormat: "metadata",
    });

    expect(result.threads).toEqual([]);
    const queriedLabels = emailProvider.getThreadsWithQuery.mock.calls.map(
      ([{ query }]) => query.labelIds,
    );
    expect(queriedLabels).toHaveLength(anyLabelIds.length);
    expect(queriedLabels).toEqual(
      expect.arrayContaining(
        anyLabelIds.map((labelId) => ["required-label", labelId]),
      ),
    );
  });
});

describe("match-any pagination", () => {
  it("keeps overflow and deduplicates threads across condition pages", async () => {
    const thread = (id: string, date: number) => ({
      id,
      messages: [{ internalDate: String(date) }],
    });
    const emailProvider = {
      getThreadsWithQuery: vi.fn(async ({ query }) => ({
        threads: query.fromEmail
          ? [thread("newest", 4000), thread("shared", 3000)]
          : [thread("shared", 3000), thread("oldest", 1000)],
      })),
    };
    const load = (pageToken?: string) =>
      fetchThreadsPage({
        emailAccountId: "account-1",
        query: {
          labelId: "INBOX",
          anyOf: [{ fromEmail: "sender@example.com" }, { labelId: "STARRED" }],
        },
        emailProvider: emailProvider as never,
        maxResults: 2,
        pageToken,
        messageFormat: "metadata",
      });
    const first = await load();
    expect(first.threads.map(({ id }) => id)).toEqual(["newest", "shared"]);
    expect(first.nextPageToken).toBeTruthy();
    const second = await load(first.nextPageToken);
    expect(second.threads.map(({ id }) => id)).toEqual(["oldest"]);
    expect(second.nextPageToken).toBeUndefined();
    expect(
      emailProvider.getThreadsWithQuery.mock.calls.some(
        ([{ query }]) =>
          query.labelIds?.includes("STARRED") &&
          query.labelIds.includes("INBOX"),
      ),
    ).toBe(true);
  });
});

describe("Other pagination", () => {
  const excludeSplits = [
    {
      matchAll: true,
      filters: [{ kind: "LABEL" as const, value: "newsletter" }],
    },
  ];
  const thread = (id: string, labels: string[]) => ({
    id,
    messages: [{ labelIds: ["INBOX", ...labels] }],
  });

  it("fills pages past excluded conversations without losing the continuation", async () => {
    const emailProvider = {
      name: "google",
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValueOnce({
          threads: [thread("excluded", ["newsletter"])],
          nextPageToken: "second",
        })
        .mockResolvedValueOnce({
          threads: [thread("kept", [])],
          nextPageToken: "third",
        }),
    };
    const result = await fetchThreadsPage({
      query: { type: "inbox", excludeSplits },
      emailProvider: emailProvider as never,
      emailAccountId: "account",
      maxResults: 1,
      messageFormat: "metadata",
    });
    expect(result.threads.map(({ id }) => id)).toEqual(["kept"]);
    expect(result.nextPageToken).toBe("third");
    expect(
      emailProvider.getThreadsWithQuery.mock.calls.at(1)?.at(0)?.pageToken,
    ).toBe("second");
  });

  it("bounds empty scans and preserves the next page for sparse inboxes", async () => {
    let page = 0;
    const emailProvider = {
      name: "google",
      getThreadsWithQuery: vi.fn(async () => {
        page += 1;
        return {
          threads: [thread("excluded", ["newsletter"])],
          nextPageToken: String(page),
        };
      }),
    };
    const result = await fetchThreadsPage({
      query: { type: "inbox", excludeSplits },
      emailProvider: emailProvider as never,
      emailAccountId: "account",
      maxResults: 1,
      messageFormat: "metadata",
    });
    expect(result.threads).toEqual([]);
    expect(result.nextPageToken).toBe("5");
    expect(emailProvider.getThreadsWithQuery).toHaveBeenCalledTimes(5);
  });
});

describe("Outlook Other tab", () => {
  it("leaves out conversations any Outlook split claims, Focused included", async () => {
    const message = (
      labelIds: string[],
      inboxSection: "focused" | "other",
    ) => ({ labelIds: ["INBOX", ...labelIds], inboxSection, headers: {} });
    const emailProvider = {
      name: "microsoft",
      getThreadsWithQuery: vi.fn(async () => ({
        threads: [
          { id: "focused", messages: [message([], "focused")] },
          { id: "categorized", messages: [message(["category-id"], "other")] },
          { id: "rest", messages: [message([], "other")] },
        ],
      })),
    };
    const query = threadsQuery.parse({
      type: "inbox",
      excludeSplits: JSON.stringify([
        { matchAll: true, filters: [{ kind: "CATEGORY", value: "focused" }] },
        { matchAll: true, filters: [{ kind: "LABEL", value: "category-id" }] },
      ]),
    });

    const result = await fetchThreadsPage({
      query,
      emailProvider: emailProvider as never,
      emailAccountId: "account",
      maxResults: 20,
      messageFormat: "metadata",
    });

    expect(result.threads.map(({ id }) => id)).toEqual(["rest"]);
  });
});

describe("Cue-sorted pages", () => {
  const thread = (id: string, messageId: string) => ({
    id,
    messages: [{ id: messageId, labelIds: ["INBOX"] }],
  });

  it("scans the inbox for conversations Cue sorted, without asking the provider for a label", async () => {
    vi.mocked(getCueMembership).mockResolvedValue({
      TO_REPLY: ["reply-1"],
      NEWSLETTER: [],
      MARKETING: [],
    });
    const emailProvider = {
      name: "microsoft",
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValueOnce({
          threads: [thread("other", "other-1")],
          nextPageToken: "second",
        })
        .mockResolvedValueOnce({ threads: [thread("reply", "reply-1")] }),
    };

    const result = await fetchThreadsPage({
      query: { labelIds: ["INBOX"], cue: ["TO_REPLY"] },
      emailProvider: emailProvider as never,
      emailAccountId: "account",
      maxResults: 1,
      messageFormat: "metadata",
    });

    expect(result.threads.map(({ id }) => id)).toEqual(["reply"]);
    expect(getCueMembership).toHaveBeenCalledWith({
      emailAccountId: "account",
    });
    for (const [{ query }] of emailProvider.getThreadsWithQuery.mock.calls) {
      expect(query).toEqual({ labelIds: ["INBOX"] });
    }
  });

  it("keeps Cue-sorted conversations out of Other", async () => {
    vi.mocked(getCueMembership).mockResolvedValue({
      TO_REPLY: [],
      NEWSLETTER: ["news-1"],
      MARKETING: [],
    });
    const emailProvider = {
      name: "google",
      getThreadsWithQuery: vi.fn().mockResolvedValue({
        threads: [thread("news", "news-1"), thread("kept", "kept-1")],
      }),
    };

    const result = await fetchThreadsPage({
      query: {
        type: "inbox",
        excludeSplits: [
          { matchAll: true, filters: [{ kind: "CUE", value: "NEWSLETTER" }] },
        ],
      },
      emailProvider: emailProvider as never,
      emailAccountId: "account",
      maxResults: 10,
      messageFormat: "metadata",
    });

    expect(result.threads.map(({ id }) => id)).toEqual(["kept"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getOrderedEmailAccounts: vi.fn(),
  loadInboxPreview: vi.fn(),
  mailPath: "/mail/u/1/inbox" as string | null,
  requestHeaders: {} as Record<string, string>,
  localMailCookie: undefined as string | undefined,
  lastAccountCookie: undefined as string | undefined,
  splits: [] as {
    id: string;
    matchAll?: boolean;
    filters: { kind: string; value: string }[];
  }[],
  dismissedHints: [] as string[],
  findUser: vi.fn(),
  getMailSettings: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/utils/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("@/utils/prisma", () => ({
  default: {
    user: {
      findUnique: (input: unknown) => mocks.findUser(input),
    },
  },
}));
vi.mock("@/utils/mail-url.server", () => ({
  getOrderedEmailAccounts: (userId: string) =>
    mocks.getOrderedEmailAccounts(userId),
}));
vi.mock("@/utils/threads/inbox-preview.server", () => ({
  loadInboxPreview: (input: unknown) => mocks.loadInboxPreview(input),
}));
vi.mock("@/utils/split-inbox/settings.server", () => ({
  getMailSettings: () => mocks.getMailSettings(),
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      ...mocks.requestHeaders,
      ...(mocks.mailPath ? { "x-cue-mail-path": mocks.mailPath } : {}),
    }),
  cookies: async () => ({
    get: (name: string) =>
      name === "cue-local-mail" && mocks.localMailCookie !== undefined
        ? { value: mocks.localMailCookie }
        : name === "last_email_account_id" &&
            mocks.lastAccountCookie !== undefined
          ? { value: mocks.lastAccountCookie }
          : undefined,
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/InboxPreviewList", () => ({
  InboxPreviewSeed: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => mocks.redirect(url),
}));
// The screen itself is out of scope; only the route's gatekeeping is tested.
vi.mock("@/app/(app)/[emailAccountId]/mail/MailScreen", () => ({
  MailScreen: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailScreenLayout", () => ({
  MailScreenLayout: ({ children }: { children: React.ReactNode }) => children,
}));

import { InboxPreviewSeed } from "@/app/(app)/[emailAccountId]/mail/InboxPreviewList";
import MailRouteLayout from "./layout";

function screenOf(layout: Awaited<ReturnType<typeof renderAt>>) {
  return (layout as React.ReactElement<{ children: React.ReactElement[] }>)
    .props.children[0] as React.ReactElement<{ preview: unknown }>;
}

function renderAt(accountIndex: string) {
  return MailRouteLayout({
    children: null,
    params: Promise.resolve({ accountIndex }),
  });
}

describe("MailRouteLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getOrderedEmailAccounts.mockResolvedValue([
      { id: "acc_a", provider: "google" },
      { id: "acc_b", provider: "microsoft" },
    ]);
    mocks.loadInboxPreview.mockReturnValue(new Promise(() => {}));
    mocks.mailPath = "/mail/u/1/inbox";
    mocks.requestHeaders = {};
    mocks.localMailCookie = undefined;
    mocks.lastAccountCookie = undefined;
    mocks.splits = [{ id: "all", filters: [] }];
    mocks.dismissedHints = ["inbox-style:acc_a", "inbox-style:acc_b"];
    mocks.findUser.mockImplementation(async () => ({
      dismissedHints: mocks.dismissedHints,
    }));
    mocks.getMailSettings.mockImplementation(async () => ({
      splits: mocks.splits,
    }));
  });

  it("opens one of the signed-in user's own accounts", async () => {
    await expect(renderAt("1")).resolves.toBeTruthy();
    expect(mocks.getOrderedEmailAccounts).toHaveBeenCalledWith("user-1");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("starts the inbox from the server for a browser without that mailbox", async () => {
    mocks.localMailCookie = "acc_a";

    await renderAt("1");

    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_b",
        provider: "microsoft",
      }),
    );
  });

  it("does not fetch the inbox again to answer a server action", async () => {
    mocks.requestHeaders = { "next-action": "abc123" };

    expect(screenOf(await renderAt("1")).props.preview).toBeNull();
    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("does not fetch the inbox for the service worker's offline copy", async () => {
    mocks.requestHeaders = { "x-cue-offline-save": "1" };

    expect(screenOf(await renderAt("1")).props.preview).toBeNull();
    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("leaves a mailbox this browser synced a moment ago to the local engine", async () => {
    mocks.localMailCookie = `acc_a.acc_b~${syncedAgo(5 * 60_000)}`;

    await renderAt("1");

    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  // RL-1: a laptop opened after days shows its own mail at once, and the
  // engine adds the newest from the provider while it catches up.
  it("fetches the newest inbox mail for a mailbox that fell behind, for the engine only", async () => {
    mocks.localMailCookie = `acc_b~${syncedAgo(3 * 24 * 3_600_000)}`;
    mocks.splits = [
      { id: "all", filters: [] },
      {
        id: "primary",
        filters: [{ kind: "CATEGORY", value: "CATEGORY_PERSONAL" }],
      },
    ];

    const layout = await renderAt("1");

    expect(screenOf(layout).props.catchUp).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_b",
        provider: "microsoft",
        catchUp: true,
      }),
    );
  });

  it("treats a mailbox recorded before sync times were kept as fallen behind", async () => {
    mocks.localMailCookie = "acc_a.acc_b";

    const layout = await renderAt("1");

    expect(screenOf(layout).props.catchUp).toBe(true);
    await vi.waitFor(() => expect(mocks.loadInboxPreview).toHaveBeenCalled());
  });

  it("fetches the tab the inbox opens on, such as Gmail's Primary", async () => {
    mocks.splits = [
      { id: "all", filters: [] },
      {
        id: "primary",
        matchAll: true,
        filters: [{ kind: "CATEGORY", value: "CATEGORY_PERSONAL" }],
      },
    ];

    await renderAt("0");

    // Primary is a slice of the inbox; its newest mail is what the first
    // screen shows, not the newest of the whole inbox or of all mail.
    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_a",
        provider: "google",
        tab: { splitId: "primary", labelIds: ["INBOX", "CATEGORY_PERSONAL"] },
      }),
    );
  });

  it("does not fetch the whole inbox when Outlook's inbox opens on Focused", async () => {
    mocks.splits = [
      { id: "all", filters: [] },
      {
        id: "focused",
        matchAll: true,
        filters: [{ kind: "CATEGORY", value: "focused" }],
      },
    ];

    const layout = await renderAt("1");

    await expect(screenOf(layout).props.preview).resolves.toBeNull();
    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("reads Primary ahead for a new Gmail mailbox, whose inbox style opens on it", async () => {
    // A new mailbox opens on All until its inbox style is chosen, and
    // Gmail's default style opens on Primary from then on.
    mocks.dismissedHints = [];

    await renderAt("0");

    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_a",
        provider: "google",
        readAhead: ["INBOX", "CATEGORY_PERSONAL"],
      }),
    );
  });

  it("still fetches the inbox, reading nothing ahead, when the style choice can't be read", async () => {
    mocks.findUser.mockRejectedValue(new Error("database down"));

    await renderAt("0");

    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_a",
        provider: "google",
      }),
    );
  });

  it("reads the style choice only where it can add a read-ahead", async () => {
    // Outlook reads nothing ahead.
    await renderAt("1");
    await vi.waitFor(() => expect(mocks.loadInboxPreview).toHaveBeenCalled());
    // An inbox already on a tab reads that tab.
    mocks.splits = [
      { id: "all", filters: [] },
      {
        id: "primary",
        matchAll: true,
        filters: [{ kind: "CATEGORY", value: "CATEGORY_PERSONAL" }],
      },
    ];
    await renderAt("0");
    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledTimes(2),
    );

    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("reads nothing ahead once the inbox style is chosen", async () => {
    await renderAt("0");

    await vi.waitFor(() =>
      expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
        emailAccountId: "acc_a",
        provider: "google",
      }),
    );
  });

  it("fetches the inbox when it opens on All", async () => {
    mocks.splits = [
      { id: "all", filters: [] },
      { id: "work", filters: [{ kind: "LABEL", value: "Work" }] },
    ];

    await renderAt("1");

    await vi.waitFor(() => expect(mocks.loadInboxPreview).toHaveBeenCalled());
  });

  it("shows no preview, rather than failing, when the tab settings fail to load", async () => {
    mocks.getMailSettings.mockRejectedValue(new Error("database down"));

    const layout = await renderAt("1");

    await expect(screenOf(layout).props.preview).resolves.toBeNull();
    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("sends the page without waiting on the inbox or on the tab settings", async () => {
    mocks.getMailSettings.mockReturnValue(new Promise(() => {}));

    const layout = await renderAt("1");

    expect(screenOf(layout).props.preview).toBeInstanceOf(Promise);
  });

  it("keeps the mail screen in the same place whether or not it seeds the inbox", async () => {
    const seeded = await renderAt("1");
    mocks.localMailCookie = `acc_b~${syncedAgo(60_000)}`;
    const unseeded = await renderAt("1");

    expect(screenOf(seeded).type).toBe(InboxPreviewSeed);
    expect(screenOf(unseeded).type).toBe(InboxPreviewSeed);
    expect(screenOf(seeded).props.preview).toBeInstanceOf(Promise);
    expect(screenOf(unseeded).props.preview).toBeNull();
  });

  it.each([
    "/mail/u/1/sent",
    "/mail/u/1/search?q=x",
    "/mail/u/1/all-inboxes",
  ])("does not fetch the inbox for %s", async (mailPath) => {
    mocks.mailPath = mailPath;

    await renderAt("1");

    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it.each([
    "2",
    "99",
    "abc",
    "-1",
    "0001",
  ])("sends /mail/u/%s, which names no account of theirs, to the first inbox", async (accountIndex) => {
    await expect(renderAt(accountIndex)).rejects.toThrow(
      "redirect:/mail/u/0/inbox",
    );
  });

  it("sends a removed position to the account this browser last used, at its new position", async () => {
    // u/2 was acc_c until an earlier account was removed elsewhere.
    mocks.lastAccountCookie = JSON.stringify({
      userId: "user-1",
      emailAccountId: "acc_b",
    });
    await expect(renderAt("2")).rejects.toThrow("redirect:/mail/u/1/inbox");
  });

  it("asks a signed-out visitor to log in", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(renderAt("0")).rejects.toThrow(
      "redirect:/login?next=%2Fmail%2Fu%2F0",
    );
  });

  it("sends a user without a mailbox to connect one", async () => {
    mocks.getOrderedEmailAccounts.mockResolvedValue([]);
    await expect(renderAt("0")).rejects.toThrow("redirect:/connect-mailbox");
  });
});

function syncedAgo(ms: number) {
  return Math.floor((Date.now() - ms) / 1000).toString(36);
}

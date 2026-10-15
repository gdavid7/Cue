import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getOrderedEmailAccounts: vi.fn(),
  loadInboxPreview: vi.fn(),
  mailPath: "/mail/u/1/inbox" as string | null,
  localMailCookie: undefined as string | undefined,
  splits: [] as { id: string; filters: { kind: string; value: string }[] }[],
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/utils/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("@/utils/mail-url.server", () => ({
  getOrderedEmailAccounts: (userId: string) =>
    mocks.getOrderedEmailAccounts(userId),
}));
vi.mock("@/utils/threads/inbox-preview.server", () => ({
  loadInboxPreview: (input: unknown) => mocks.loadInboxPreview(input),
}));
vi.mock("@/utils/split-inbox/settings.server", () => ({
  getMailSettings: async () => ({ splits: mocks.splits }),
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(mocks.mailPath ? { "x-cue-mail-path": mocks.mailPath } : {}),
  cookies: async () => ({
    get: (name: string) =>
      name === "cue-local-mail" && mocks.localMailCookie !== undefined
        ? { value: mocks.localMailCookie }
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
    mocks.localMailCookie = undefined;
    mocks.splits = [{ id: "all", filters: [] }];
  });

  it("opens one of the signed-in user's own accounts", async () => {
    await expect(renderAt("1")).resolves.toBeTruthy();
    expect(mocks.getOrderedEmailAccounts).toHaveBeenCalledWith("user-1");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("starts the inbox from the server for a browser without that mailbox", async () => {
    mocks.localMailCookie = "acc_a";

    await renderAt("1");

    expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
      emailAccountId: "acc_b",
      provider: "microsoft",
    });
  });

  it("leaves a mailbox this browser has synced to the local engine", async () => {
    mocks.localMailCookie = "acc_a.acc_b";

    await renderAt("1");

    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("does not fetch the whole inbox when the inbox opens on a tab", async () => {
    // Gmail's tabs: the inbox opens on Primary, not on All.
    mocks.splits = [
      { id: "all", filters: [] },
      {
        id: "primary",
        filters: [{ kind: "CATEGORY", value: "CATEGORY_PERSONAL" }],
      },
    ];

    const layout = await renderAt("1");

    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
    expect(screenOf(layout).props.preview).toBeNull();
  });

  it("fetches the inbox when it opens on All", async () => {
    mocks.splits = [
      { id: "all", filters: [] },
      { id: "work", filters: [{ kind: "LABEL", value: "Work" }] },
    ];

    await renderAt("1");

    expect(mocks.loadInboxPreview).toHaveBeenCalled();
  });

  it("keeps the mail screen in the same place whether or not it seeds the inbox", async () => {
    const seeded = await renderAt("1");
    mocks.localMailCookie = "acc_b";
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

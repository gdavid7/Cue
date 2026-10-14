import { describe, expect, it } from "vitest";
import {
  buildMailPath,
  getLabelSlugs,
  getSplitSlugs,
  mailPathForAccount,
  type MailUrl,
  parseMailPath,
  resolveSlug,
} from "./mail-url";
import { OTHER_SPLIT_ID } from "@/utils/split-inbox/split-query";

describe("buildMailPath", () => {
  it.each<[MailUrl, string]>([
    [{ accountIndex: 0 }, "/mail/u/0/inbox"],
    [
      { accountIndex: 2, view: { kind: "type", type: "sent" } },
      "/mail/u/2/sent",
    ],
    [
      { accountIndex: 0, view: { kind: "type", type: "draft" } },
      "/mail/u/0/drafts",
    ],
    [
      { accountIndex: 0, view: { kind: "type", type: "inbox" } },
      "/mail/u/0/inbox",
    ],
    [
      { accountIndex: 0, view: { kind: "type", type: "CATEGORY_SOCIAL" } },
      "/mail/u/0/category/social",
    ],
    [
      { accountIndex: 0, view: { kind: "split", slug: "needs-reply" } },
      "/mail/u/0/needs-reply",
    ],
    [
      { accountIndex: 0, view: { kind: "label", slug: "receipts" } },
      "/mail/u/0/label/receipts",
    ],
    [
      { accountIndex: 1, view: { kind: "search", q: "from:ana invoice" } },
      "/mail/u/1/search?q=from%3Aana+invoice",
    ],
    [
      { accountIndex: 0, view: { kind: "inbox" }, threadId: "18c2f0a9b" },
      "/mail/u/0/inbox/18c2f0a9b",
    ],
    [
      {
        accountIndex: 0,
        allInboxes: true,
        threadId: "abc",
        threadAccountIndex: 2,
      },
      "/mail/u/0/all-inboxes/inbox/abc?account=2",
    ],
  ])("builds %j as %s", (url, expected) => {
    expect(buildMailPath(url)).toBe(expected);
  });

  it("keeps an Outlook thread id with slashes in one segment", () => {
    expect(buildMailPath({ accountIndex: 0, threadId: "AAQk/ab+c=" })).toBe(
      "/mail/u/0/inbox/AAQk%2Fab%2Bc%3D",
    );
  });
});

describe("parseMailPath", () => {
  it("round-trips every address the builder makes", () => {
    const urls: MailUrl[] = [
      { accountIndex: 0, view: { kind: "inbox" } },
      { accountIndex: 3, view: { kind: "type", type: "trash" } },
      { accountIndex: 0, view: { kind: "type", type: "CATEGORY_UPDATES" } },
      { accountIndex: 0, view: { kind: "type", type: "some_new_type" } },
      { accountIndex: 0, view: { kind: "split", slug: "reading" } },
      { accountIndex: 0, view: { kind: "folder", slug: "projects" } },
      { accountIndex: 0, view: { kind: "search", q: "lunch" }, threadId: "t1" },
      {
        accountIndex: 1,
        allInboxes: true,
        view: { kind: "split", slug: "unread" },
        threadId: "t2",
        threadAccountIndex: 0,
      },
      {
        accountIndex: 0,
        view: { kind: "label", slug: "work" },
        threadId: "a/b",
      },
    ];
    for (const url of urls) {
      const [pathname, search] = buildMailPath(url).split("?");
      expect(parseMailPath(pathname, search)).toEqual({
        threadId: null,
        threadAccountIndex: null,
        ...url,
      });
    }
  });

  it("treats the bare account root as the inbox", () => {
    expect(parseMailPath("/mail/u/0")).toMatchObject({
      accountIndex: 0,
      view: { kind: "inbox" },
      threadId: null,
    });
  });

  it("reads a thread id the router already decoded", () => {
    expect(parseMailPath("/mail/u/0/inbox/AAQk/ab+c=")?.threadId).toBe(
      "AAQk/ab+c=",
    );
  });

  it("falls back to the inbox for a search without a query", () => {
    expect(parseMailPath("/mail/u/0/search")?.view).toEqual({ kind: "inbox" });
  });

  it("ignores a thread account outside All Inboxes", () => {
    expect(
      parseMailPath("/mail/u/0/inbox/t1", "account=2")?.threadAccountIndex,
    ).toBeNull();
  });

  it.each([
    "/cmv7j1yky000206l1iouqvl70/mail",
    "/mail",
    "/mail/u/abc/inbox",
    "/mail/u/-1/inbox",
    "/u/0/automation",
  ])("is not a mail address: %s", (pathname) => {
    expect(parseMailPath(pathname)).toBeNull();
  });
});

describe("getSplitSlugs", () => {
  it("slugs names and steers clear of words that already name a view", () => {
    const slugs = getSplitSlugs([
      { id: "s1", name: "Needs Reply" },
      { id: "s2", name: "All" },
      { id: "s3", name: "Sent" },
      { id: "s4", name: "Café   Reading!" },
    ]);
    expect(Object.fromEntries(slugs)).toEqual({
      s1: "needs-reply",
      s2: "inbox-all",
      s3: "inbox-sent",
      s4: "cafe-reading",
      [OTHER_SPLIT_ID]: "inbox-other",
    });
  });

  it("disambiguates repeated names in tab order", () => {
    const slugs = getSplitSlugs([
      { id: "a", name: "Team" },
      { id: "b", name: "team" },
      { id: "c", name: "TEAM" },
    ]);
    expect([slugs.get("a"), slugs.get("b"), slugs.get("c")]).toEqual([
      "team",
      "team-2",
      "team-3",
    ]);
  });

  it("keeps names in other scripts readable and falls back for symbols", () => {
    const slugs = getSplitSlugs([
      { id: "he", name: "עבודה" },
      { id: "ja", name: "仕事 メール" },
      { id: "sym", name: "⭐️" },
    ]);
    expect(slugs.get("he")).toBe("עבודה");
    expect(slugs.get("ja")).toBe("仕事-メール");
    expect(slugs.get("sym")).toBe("tab");
  });

  it("slugs Gmail's Other tab last so it never shifts the others", () => {
    const withOther = getSplitSlugs([
      { id: OTHER_SPLIT_ID, name: "Other" },
      { id: "x", name: "Other" },
    ]);
    expect(withOther.get("x")).toBe("inbox-other");
    expect(withOther.get(OTHER_SPLIT_ID)).toBe("inbox-other-2");
  });
});

describe("getLabelSlugs and resolveSlug", () => {
  const labels = [
    { id: "Label_9", name: "Work Projects" },
    { id: "Label_2", name: "Work/Projects" },
    { id: "Label_5", name: "Receipts" },
  ];

  it("assigns slugs in id order, so list order never changes them", () => {
    const forward = getLabelSlugs(labels);
    const reversed = getLabelSlugs([...labels].reverse());
    expect(Object.fromEntries(forward)).toEqual(Object.fromEntries(reversed));
    expect(forward.get("Label_2")).toBe("work-projects");
    expect(forward.get("Label_9")).toBe("work-projects-2");
  });

  it("resolves a slug, or a raw id from an old link, to the id", () => {
    const slugs = getLabelSlugs(labels);
    expect(resolveSlug(slugs, "receipts")).toBe("Label_5");
    expect(resolveSlug(slugs, "Label_9")).toBe("Label_9");
    expect(resolveSlug(slugs, "missing")).toBeNull();
  });
});

describe("mailPathForAccount", () => {
  it("addresses an account by its position", () => {
    expect(
      mailPathForAccount(["a", "b"], "b", {
        view: { kind: "type", type: "sent" },
      }),
    ).toBe("/mail/u/1/sent");
  });

  it("falls back to the redirecting legacy route for an unknown id", () => {
    expect(mailPathForAccount(["a"], "zzz")).toBe("/zzz/mail");
  });
});

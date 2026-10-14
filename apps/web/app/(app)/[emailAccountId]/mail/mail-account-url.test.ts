import { describe, expect, it } from "vitest";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";

const ACCOUNTS = ["first", "second", "third"];

describe("getMailAccountUrl", () => {
  it("drops the old account's label, thread and side panel but keeps other params", () => {
    expect(
      getMailAccountUrl(ACCOUNTS, "second", {
        pathname: "/mail/u/0/label/receipts/thread-1",
        search: "?side-panel-thread-id=thread&layout=list",
      }),
    ).toBe("/mail/u/1/inbox?layout=list");
  });

  it("keeps a built-in view and a search", () => {
    expect(
      getMailAccountUrl(ACCOUNTS, "third", {
        pathname: "/mail/u/0/sent/t1",
        search: "",
      }),
    ).toBe("/mail/u/2/sent");
    expect(
      getMailAccountUrl(ACCOUNTS, "third", {
        pathname: "/mail/u/0/search",
        search: "?q=receipt",
      }),
    ).toBe("/mail/u/2/search?q=receipt");
  });

  it("leaves All Inboxes and split tabs for the account's inbox", () => {
    expect(
      getMailAccountUrl(ACCOUNTS, "second", {
        pathname: "/mail/u/0/all-inboxes/unread/t1",
        search: "?account=2",
      }),
    ).toBe("/mail/u/1/inbox");
    expect(
      getMailAccountUrl(ACCOUNTS, "second", {
        pathname: "/mail/u/0/needs-reply",
        search: "",
      }),
    ).toBe("/mail/u/1/inbox");
  });

  it("opens an account's inbox from outside mail", () => {
    expect(getMailAccountUrl(ACCOUNTS, "first")).toBe("/mail/u/0/inbox");
    expect(
      getMailAccountUrl(ACCOUNTS, "first", {
        pathname: "/abc123/home",
        search: "",
      }),
    ).toBe("/mail/u/0/inbox");
  });

  it("falls back to the redirecting legacy route before accounts are known", () => {
    expect(getMailAccountUrl([], "first")).toBe("/first/mail");
  });
});

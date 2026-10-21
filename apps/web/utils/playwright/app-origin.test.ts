import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { appUrl, rememberAppOrigin } from "./app-origin";

describe("appUrl", () => {
  it("keeps paths relative before the browser has loaded anything", () => {
    expect(appUrl(fakePage("about:blank"), "/api/user/email-accounts")).toBe(
      "/api/user/email-accounts",
    );
  });

  it("targets the host the browser landed on, not the configured one", () => {
    const page = fakePage("https://cuemail.tech/settings");
    expect(appUrl(page, "/api/user/email-accounts?x=1")).toBe(
      "https://cuemail.tech/api/user/email-accounts?x=1",
    );
  });

  it("keeps the remembered origin after navigating to about:blank", () => {
    const page = fakePage("https://cuemail.tech/settings");
    rememberAppOrigin(page);
    page.current = "about:blank";
    expect(appUrl(page, "/mail/u/0/inbox")).toBe(
      "https://cuemail.tech/mail/u/0/inbox",
    );
  });

  it("ignores about:blank when remembering", () => {
    const page = fakePage("about:blank");
    rememberAppOrigin(page);
    expect(appUrl(page, "/settings")).toBe("/settings");
  });
});

function fakePage(url: string) {
  const page = {
    current: url,
    url() {
      return page.current;
    },
  };
  return page as typeof page & Page;
}

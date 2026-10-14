import { describe, expect, it } from "vitest";
import {
  getAppPageFromPathname,
  getPageViewPathname,
  getPageViewSearch,
  stripUntrackedUrlParams,
} from "@/utils/analytics/product";

describe("getPageViewSearch", () => {
  it("drops thread selection and search text but keeps the view", () => {
    expect(
      getPageViewSearch(
        new URLSearchParams(
          "type=inbox&thread-id=t1&thread-account-id=a1&side-panel-thread-id=t2&q=invoice&split=s1",
        ),
      ),
    ).toBe("type=inbox&split=s1");
  });

  it("is unchanged when only the open thread changes", () => {
    expect(
      getPageViewSearch(new URLSearchParams("type=inbox&thread-id=t1")),
    ).toBe(getPageViewSearch(new URLSearchParams("type=inbox&thread-id=t2")));
  });

  it("handles missing params", () => {
    expect(getPageViewSearch(null)).toBe("");
    expect(getPageViewSearch(new URLSearchParams("thread-id=t1"))).toBe("");
  });
});

describe("stripUntrackedUrlParams", () => {
  it("removes thread ids and search text from every URL PostHog attaches", () => {
    const event = stripUntrackedUrlParams({
      properties: {
        $current_url:
          "https://app.test/acc/mail?split=news&thread-id=t1&q=invoice",
        $referrer: "https://app.test/acc/mail?side-panel-thread-id=t2",
        event_name: "kept",
      },
      $set_once: {
        $initial_current_url: "https://app.test/acc/mail?q=refund",
      },
    });
    expect(event.properties).toEqual({
      $current_url: "https://app.test/acc/mail?split=news",
      $referrer: "https://app.test/acc/mail",
      event_name: "kept",
    });
    expect(event.$set_once).toEqual({
      $initial_current_url: "https://app.test/acc/mail",
    });
  });
});

describe("getAppPageFromPathname", () => {
  it("tells shared conversations apart from their activity feed", () => {
    expect(getAppPageFromPathname("/shared")).toBe("shared_conversations");
    expect(getAppPageFromPathname("/shared/conv-1")).toBe(
      "shared_conversations",
    );
    expect(getAppPageFromPathname("/shared/activity")).toBe("shared_activity");
  });
});

describe("getPageViewPathname", () => {
  it("keeps thread ids and label or tab names out of mail page views", () => {
    expect(getPageViewPathname("/mail/u/0/label/medical/thread-1")).toBe(
      "/mail/u/0/label",
    );
    expect(getPageViewPathname("/mail/u/1/needs-reply/thread-1")).toBe(
      "/mail/u/1/tab",
    );
    expect(getPageViewPathname("/mail/u/0/search")).toBe("/mail/u/0/inbox");
    expect(getPageViewPathname("/mail/u/0/all-inboxes/inbox/t1")).toBe(
      "/mail/u/0/all-inboxes/inbox",
    );
  });

  it("keeps built-in views, which name nothing private", () => {
    expect(getPageViewPathname("/mail/u/0/sent/t1")).toBe("/mail/u/0/sent");
    expect(getPageViewPathname("/mail/u/0/category/social")).toBe(
      "/mail/u/0/category/social",
    );
  });

  it("leaves other pages alone", () => {
    expect(getPageViewPathname("/abc/automation")).toBe("/abc/automation");
  });

  it("strips mail paths from URLs PostHog attaches to events", () => {
    const event = stripUntrackedUrlParams({
      properties: {
        $current_url: "https://app.example.com/mail/u/0/label/medical/t1",
      },
    });
    expect(event.properties?.$current_url).toBe(
      "https://app.example.com/mail/u/0/label",
    );
  });
});

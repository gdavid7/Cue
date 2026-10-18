/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  formatUnreadTitle,
  keepUnreadTitle,
} from "@/utils/web-notifications/unread-title";

afterEach(() => {
  document.title = "";
});

describe("formatUnreadTitle", () => {
  it("shows the inbox unread count like Gmail", () => {
    expect(formatUnreadTitle(3, "Cue")).toBe("Inbox (3) – Cue");
  });

  it("leaves the page title alone when nothing is unread", () => {
    expect(formatUnreadTitle(0, "Cue")).toBeNull();
  });

  it("caps very large counts", () => {
    expect(formatUnreadTitle(12_345, "Cue")).toBe("Inbox (99+) – Cue");
  });
});

describe("keepUnreadTitle", () => {
  it("updates live and restores the page title at zero", () => {
    document.title = "Cue | Settings";
    const title = keepUnreadTitle("Cue");

    title.set(2);
    expect(document.title).toBe("Inbox (2) – Cue");
    title.set(5);
    expect(document.title).toBe("Inbox (5) – Cue");
    title.set(0);
    expect(document.title).toBe("Cue | Settings");
    title.dispose();
  });

  it("keeps the count when the app changes the page title on navigation", async () => {
    document.title = "Cue | Mail";
    const title = keepUnreadTitle("Cue");
    title.set(4);

    document.title = "Cue | Settings";
    await Promise.resolve();
    expect(document.title).toBe("Inbox (4) – Cue");

    title.set(0);
    expect(document.title).toBe("Cue | Settings");
    title.dispose();
  });

  it("restores the page title when disposed", () => {
    document.title = "Cue | Mail";
    const title = keepUnreadTitle("Cue");
    title.set(1);
    title.dispose();
    expect(document.title).toBe("Cue | Mail");
  });
});

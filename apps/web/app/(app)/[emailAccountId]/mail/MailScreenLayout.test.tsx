import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MailScreenLayout } from "./MailScreenLayout";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/shortcuts/ShortcutsProvider", () => ({
  ShortcutsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("MailScreenLayout", () => {
  it("paints the mail palette from the server's HTML, before any effect runs", async () => {
    const html = renderToString(
      await MailScreenLayout({ children: <p>inbox</p> }),
    );

    // Unread dots and links read the palette's blue at first paint, not the
    // app's slate until the page has hydrated.
    expect(html).toMatch(/data-theme="mail"[^>]*>[\s\S]*<p>inbox<\/p>/);
  });
});

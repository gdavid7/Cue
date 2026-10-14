/** @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlookFolder } from "@/utils/outlook/folders";
import { getMailNavView, useMailRoute, useMailSlugs } from "./use-mail-route";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "acc_b",
    accountIds: ["acc_a", "acc_b"],
  }),
}));

describe("useMailRoute", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/mail/u/1/needs-reply?utm_source=x");
  });

  it("reads the view from the address", () => {
    const { result } = renderHook(() => useMailRoute());
    expect(result.current.location).toMatchObject({
      accountIndex: 1,
      view: { kind: "split", slug: "needs-reply" },
      threadId: null,
    });
  });

  it("lets several changes in one handler build on each other", () => {
    const { result } = renderHook(() => useMailRoute());
    result.current.updateLocation((current) => ({
      ...current,
      threadId: "t1",
    }));
    result.current.updateLocation((current) => ({
      ...current,
      view: { kind: "search", q: "lunch" },
    }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/mail/u/1/search/t1?utm_source=x&q=lunch",
    );
  });

  it("changes nothing off the mail screen", () => {
    window.history.replaceState(null, "", "/acc_b/automation");
    const { result } = renderHook(() => useMailRoute());
    result.current.updateLocation((current) => ({ ...current, threadId: "t" }));
    expect(window.location.pathname).toBe("/acc_b/automation");
  });
});

describe("mail sidebar links", () => {
  it("address labels and nested folders by slug", () => {
    const folders = [
      {
        id: "f-clients",
        displayName: "Clients",
        childFolders: [{ id: "f-acme", displayName: "Acme", childFolders: [] }],
      },
    ] as unknown as OutlookFolder[];
    const { result } = renderHook(() =>
      useMailSlugs([{ id: "Label_1", name: "Receipts" }], folders),
    );

    expect(
      getMailNavView({ kind: "label", labelId: "Label_1" }, result.current),
    ).toEqual({ kind: "label", slug: "receipts" });
    expect(
      getMailNavView({ kind: "folder", folderId: "f-acme" }, result.current),
    ).toEqual({ kind: "folder", slug: "clients-acme" });
    expect(
      getMailNavView({ kind: "type", type: "inbox" }, result.current),
    ).toEqual({ kind: "inbox" });
  });

  it("falls back to the id for a label whose name isn't loaded", () => {
    const { result } = renderHook(() => useMailSlugs([], []));
    expect(
      getMailNavView({ kind: "label", labelId: "Label_9" }, result.current),
    ).toEqual({ kind: "label", slug: "Label_9" });
  });
});

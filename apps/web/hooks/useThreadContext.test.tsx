// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextWithText, useThreadContext } from "@/hooks/useThreadContext";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";

vi.mock("@/env", () => ({ env: {} }));

const fetcher = vi.fn();
const CONTEXT = {
  items: [{ id: "thread-2", kind: "email", title: "Pricing", reasons: [] }],
};

describe("useThreadContext", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting();
    fetcher.mockReset();
  });
  afterEach(cleanup);

  // RD-3: the server keeps no context, so a reopen within minutes reads this
  // browser's instead of gathering mail, events and linked pages again.
  it("answers a conversation reopened soon after from this browser", async () => {
    fetcher.mockResolvedValue(CONTEXT);

    const first = render();
    await waitFor(() => expect(first.current.data).toEqual(CONTEXT));
    cleanup();
    const second = render();

    expect(second.current.data).toEqual(CONTEXT);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // F5: the panel's items are kept; their text and a linked page's words
  // stay in memory for this page only.
  it("keeps no item text or linked-page words in this browser", async () => {
    const page = {
      id: "page-1",
      kind: "web",
      title: "Opening hours",
      snippet: "Open 9 to 5 on weekdays",
      reasons: [],
      text: "Open 9 to 5 on weekdays, closed on holidays.",
    };
    fetcher.mockResolvedValue({ items: [page] });

    const first = render();
    await waitFor(() => expect(first.current.data).toEqual({ items: [page] }));
    cleanup();

    expect(JSON.stringify({ ...window.localStorage })).not.toContain("9 to 5");
    const second = render();
    expect(second.current.data?.items).toEqual([
      {
        id: "page-1",
        kind: "web",
        title: "Opening hours",
        snippet: "",
        reasons: [],
      },
    ]);
    expect(contextWithText(second.current.data)).toBeUndefined();
  });
});

function render() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), fetcher }}>
      {children}
    </SWRConfig>
  );
  const { result } = renderHook(
    () => useThreadContext({ threadId: "thread-1", emailAccountId: "a1" }),
    { wrapper },
  );
  return result;
}

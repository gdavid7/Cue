// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadContext } from "@/hooks/useThreadContext";
import { resetBrowserCacheBlocksForTesting } from "@/utils/browser-cache";

vi.mock("@/env", () => ({ env: {} }));

const fetcher = vi.fn();
const CONTEXT = {
  items: [{ id: "thread-2", kind: "email", title: "Pricing", reasons: [] }],
};

describe("useThreadContext", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheBlocksForTesting();
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

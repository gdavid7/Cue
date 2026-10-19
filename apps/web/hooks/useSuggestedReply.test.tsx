// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSuggestedReply } from "@/hooks/useSuggestedReply";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";

vi.mock("@/env", () => ({ env: {} }));

const fetcher = vi.fn();
const SUGGESTION = {
  suggestion: { status: "suggested", reply: "Friday works.", citations: [] },
  canSearchWeb: true,
};

describe("useSuggestedReply", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting();
    fetcher.mockReset();
  });
  afterEach(cleanup);

  // RD-3: the server keeps no suggestions, so reopening reads this browser's.
  it("answers a reopened conversation from this browser without asking again", async () => {
    fetcher.mockResolvedValue(SUGGESTION);

    const first = render({ enabled: true });
    await waitFor(() => expect(first.current.data).toEqual(SUGGESTION));
    cleanup();
    const second = render({ enabled: true });

    expect(second.current.data).toEqual(SUGGESTION);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads back only what this browser kept when asked to", async () => {
    const kept = render({ enabled: true, keptOnly: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kept.current.data).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the abstention's query with the web pass", async () => {
    fetcher.mockResolvedValue(SUGGESTION);

    render({ enabled: true, searchWeb: true, webQuery: "venue hours" });

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.stringify(fetcher.mock.calls[0][0])).toContain(
      "webQuery=venue+hours",
    );
  });

  // RD-3g: the reader's context goes with the request instead of being
  // gathered again on the server.
  it("sends the reader's context with the request", async () => {
    fetcher.mockResolvedValue(SUGGESTION);
    const context = [
      {
        id: "thread-2",
        kind: "email" as const,
        title: "Pricing",
        snippet: "",
        at: "2026-10-01T00:00:00.000Z",
        reasons: [],
        text: "The price is 40.",
      },
    ];

    render({ enabled: true, context });

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const init = fetcher.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ context });
  });
});

function render(
  options: Partial<Parameters<typeof useSuggestedReply>[0]> & {
    enabled: boolean;
  },
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), fetcher }}>
      {children}
    </SWRConfig>
  );
  const { result } = renderHook(
    () =>
      useSuggestedReply({
        threadId: "thread-1",
        emailAccountId: "account-1",
        messageId: "message-1",
        ...options,
      }),
    { wrapper },
  );
  return result;
}

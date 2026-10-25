// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThreadBriefPrefetch, useThreadBrief } from "@/hooks/useThreadBrief";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import {
  getReaderPrefetcher,
  PREFETCH_INTENT_DELAY_MS,
} from "@/utils/reader-prefetch";

vi.mock("@/env", () => ({ env: {} }));

const fetcher = vi.fn();
const BRIEF = {
  brief: { summary: "Maya asks about June", keyPoints: [], source: "ai" },
};

describe("useThreadBrief after a hover prefetch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting();
    fetcher.mockReset();
  });
  afterEach(cleanup);

  // PF-3: the hover started the model call; opening the row must not ask again.
  it("takes over the brief a hover on the row already started", async () => {
    let answer: (value: typeof BRIEF) => void = () => {};
    fetcher.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await hover("thread-1");

    const opened = render("thread-1");
    answer(BRIEF);

    await waitFor(() => expect(opened.current.data).toEqual(BRIEF));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // PF-3: a prefetched brief is a paid model call; opening the row later, long
  // after the prefetch expired, reads it from this browser instead.
  it("keeps a prefetched brief, so a later open asks for nothing", async () => {
    fetcher.mockResolvedValue(BRIEF);
    await hover("thread-2");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    const opened = render("thread-2");

    expect(opened.current.data).toEqual(BRIEF);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

async function hover(threadId: string) {
  getReaderPrefetcher().intend({
    accountId: "a1",
    threadId,
    request: () =>
      getThreadBriefPrefetch({
        emailAccountId: "a1",
        threadId,
        messageId: "m1",
        fetcher,
      }),
  });
  await new Promise((resolve) =>
    setTimeout(resolve, PREFETCH_INTENT_DELAY_MS + 50),
  );
}

function render(threadId: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), fetcher }}>
      {children}
    </SWRConfig>
  );
  const { result } = renderHook(
    () =>
      useThreadBrief({
        emailAccountId: "a1",
        threadId,
        messageId: "m1",
        enabled: true,
      }),
    { wrapper },
  );
  return result;
}

// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContactPhoto } from "@/hooks/useContactPhoto";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";

vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_CONTACTS_ENABLED: true } }));

const fetcher = vi.fn();

describe("useContactPhoto", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting();
    fetcher.mockReset();
  });
  afterEach(cleanup);

  // RD-3: the server keeps no photos, so this browser keeps a complete sweep.
  it("keeps a complete sweep in this browser instead of asking again", async () => {
    fetcher.mockResolvedValue({
      photos: { "ana@example.com": "https://photo/ana" },
      swept: true,
    });

    expect(await photoFor("Ana <Ana@Example.com>")).toBe("https://photo/ana");
    cleanup();
    expect(await photoFor("ana@example.com")).toBe("https://photo/ana");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks again next time when the sweep did not complete", async () => {
    fetcher.mockResolvedValue({ photos: {}, swept: false });

    await photoFor("ana@example.com", { expectPhoto: false });
    cleanup();
    await photoFor("ana@example.com", { expectPhoto: false });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

async function photoFor(email: string, { expectPhoto = true } = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), fetcher }}>
      {children}
    </SWRConfig>
  );
  const { result } = renderHook(
    () => useContactPhoto({ email, emailAccountId: "account-1" }),
    { wrapper },
  );
  if (expectPhoto) await waitFor(() => expect(result.current).toBeTruthy());
  else await waitFor(() => expect(fetcher).toHaveBeenCalled());
  return result.current;
}

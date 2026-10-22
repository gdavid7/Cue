import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithAccount } from "./fetch";
import { resetSigningOut, startSigningOut } from "./signing-out";

afterEach(() => {
  resetSigningOut();
  vi.unstubAllGlobals();
});

describe("fetchWithAccount", () => {
  it("sends nothing and never settles once sign-out started", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    startSigningOut();

    const settled = vi.fn();
    fetchWithAccount({ url: "/api/x", emailAccountId: "a" }).then(
      settled,
      settled,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("does not report an abort caused by sign-out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        startSigningOut();
        throw new DOMException("Aborted", "AbortError");
      }),
    );

    const settled = vi.fn();
    fetchWithAccount({ url: "/api/x", emailAccountId: "a" }).then(
      settled,
      settled,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).not.toHaveBeenCalled();
  });

  it("still surfaces ordinary network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(
      fetchWithAccount({ url: "/api/x", emailAccountId: null }),
    ).rejects.toThrow("offline");
  });
});

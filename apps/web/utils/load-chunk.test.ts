import { describe, expect, it, vi } from "vitest";
import { loadChunk } from "./load-chunk";

describe("loadChunk", () => {
  it("recovers when a retry succeeds", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("ChunkLoadError"))
      .mockResolvedValueOnce("module");
    const reload = vi.fn();

    await expect(
      loadChunk(load, { delaysMs: [0], reload, storage: createStorage() }),
    ).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the page only once for repeated failures", async () => {
    const error = new Error("ChunkLoadError");
    const load = vi.fn().mockRejectedValue(error);
    const reload = vi.fn();
    const storage = createStorage();

    // The first failure reloads and never settles, as the page is leaving.
    loadChunk(load, { delaysMs: [0], reload, storage });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    await expect(
      loadChunk(load, { delaysMs: [0], reload, storage }),
    ).rejects.toBe(error);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for a background preload", async () => {
    const error = new Error("ChunkLoadError");
    const reload = vi.fn();

    await expect(
      loadChunk(() => Promise.reject(error), {
        delaysMs: [],
        reload,
        reloadOnFailure: false,
        storage: createStorage(),
      }),
    ).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });
});

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

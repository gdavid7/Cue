/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChunk } from "./load-chunk";

const mockToastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: mockToastInfo } }));

describe("loadChunk", () => {
  afterEach(() => {
    mockToastInfo.mockClear();
    document.body.innerHTML = "";
  });

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

    expect(mockToastInfo).not.toHaveBeenCalled();

    await expect(
      loadChunk(load, { delaysMs: [0], reload, storage }),
    ).rejects.toBe(error);
    expect(reload).toHaveBeenCalledTimes(1);
    // The guard rules out a second reload, so the user still gets a way out.
    expect(mockToastInfo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reload" }),
      }),
    );
  });

  it("offers a reload instead of reloading while the user is typing", async () => {
    const error = new Error("ChunkLoadError");
    const load = vi.fn().mockRejectedValue(error);
    const reload = vi.fn();
    const storage = createStorage();
    const draft = document.createElement("textarea");
    document.body.append(draft);
    draft.focus();

    await expect(
      loadChunk(load, { delaysMs: [], reload, storage }),
    ).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledTimes(1);

    // Typing did not use up the one automatic reload.
    draft.blur();
    loadChunk(load, { delaysMs: [], reload, storage });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("does not claim a new version when the device is offline", async () => {
    const error = new Error("ChunkLoadError");
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const storage = createStorage();
    storage.setItem("stale-deployment-reloaded-at", String(Date.now()));

    try {
      await expect(
        loadChunk(() => Promise.reject(error), {
          delaysMs: [],
          reload: vi.fn(),
          storage,
        }),
      ).rejects.toBe(error);
      expect(mockToastInfo).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
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
    expect(mockToastInfo).not.toHaveBeenCalled();
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

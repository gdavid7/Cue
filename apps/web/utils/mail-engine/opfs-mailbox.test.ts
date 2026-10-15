import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_ENGINE_OPFS_DIRECTORY, wipeOpfsMailEngine } from "./opfs-mailbox";

describe("wipeOpfsMailEngine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("removes the mail-engine OPFS directory", async () => {
    const removeEntry = vi.fn();
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({ removeEntry }),
      },
    });
    await wipeOpfsMailEngine();
    expect(removeEntry).toHaveBeenCalledWith(MAIL_ENGINE_OPFS_DIRECTORY, {
      recursive: true,
    });
  });

  it("ignores a missing OPFS directory", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({
          removeEntry: async () => {
            throw Object.assign(new Error("missing"), {
              name: "NotFoundError",
            });
          },
        }),
      },
    });
    await expect(wipeOpfsMailEngine()).resolves.toBe(true);
  });

  it("reports a directory that stays locked through every retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({
          removeEntry: async () => {
            throw Object.assign(new Error("busy"), {
              name: "InvalidStateError",
            });
          },
        }),
      },
    });
    const done = wipeOpfsMailEngine();
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(false);
  });

  it("retries removeEntry while the SAHPool still holds the directory", async () => {
    vi.useFakeTimers();
    const removeEntry = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("busy"), { name: "InvalidStateError" }),
      )
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({ removeEntry }),
      },
    });
    const done = wipeOpfsMailEngine();
    await vi.runAllTimersAsync();
    await done;
    expect(removeEntry).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

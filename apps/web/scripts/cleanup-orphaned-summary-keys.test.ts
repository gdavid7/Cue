import { describe, expect, it, vi } from "vitest";
import {
  findOrphanedSummaryKeys,
  looksLikeRawSummaryKey,
} from "./cleanup-orphaned-summary-keys";

vi.mock("@/utils/redis", () => ({ redis: {} }));

const EMAIL_TEXT = "Hi Sarah,\n\nThanks for the update on the renewal.";

describe("looksLikeRawSummaryKey", () => {
  it("tells an email's text from the app's namespaced keys", () => {
    expect(looksLikeRawSummaryKey(EMAIL_TEXT)).toBe(true);
    expect(looksLikeRawSummaryKey("x".repeat(300))).toBe(true);
    expect(looksLikeRawSummaryKey("usage:user@example.com")).toBe(false);
    expect(
      looksLikeRawSummaryKey("usage-migration:weekly-usage-cost-user:u1:done"),
    ).toBe(false);
    expect(looksLikeRawSummaryKey(`summary:${"a".repeat(64)}`)).toBe(false);
    expect(looksLikeRawSummaryKey("short-key")).toBe(false);
  });
});

describe("findOrphanedSummaryKeys", () => {
  it("counts only text-keyed strings that never expire, and deletes nothing by default", async () => {
    const store = fakeStore({
      [EMAIL_TEXT]: { type: "string", ttl: -1, value: "A summary" },
      // Text-like, but expiring or not a string: not the old summary cache.
      [`${EMAIL_TEXT} later`]: { type: "string", ttl: 600, value: "x" },
      [`${EMAIL_TEXT} hash`]: { type: "hash", ttl: -1, value: "" },
      "usage:user@example.com": { type: "hash", ttl: -1, value: "" },
    });
    const log = vi.fn();

    const result = await findOrphanedSummaryKeys(store.client, { log });

    expect(result).toMatchObject({ orphaned: 1, deleted: 0 });
    expect(store.client.unlink).not.toHaveBeenCalled();
    // Reports never print the email text that forms the key.
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sarah");
  });

  it("deletes the orphaned keys only when asked", async () => {
    const store = fakeStore({
      [EMAIL_TEXT]: { type: "string", ttl: -1, value: "A summary" },
      "usage:user@example.com": { type: "hash", ttl: -1, value: "" },
    });

    const result = await findOrphanedSummaryKeys(store.client, {
      apply: true,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ orphaned: 1, deleted: 1 });
    expect(store.keys()).toEqual(["usage:user@example.com"]);
  });
});

function fakeStore(
  entries: Record<string, { type: string; ttl: number; value: string }>,
) {
  const data = new Map(Object.entries(entries));
  const client = {
    scan: vi.fn(async () => ["0", [...data.keys()]] as [string, string[]]),
    type: vi.fn(async (key: string) => data.get(key)?.type ?? "none"),
    ttl: vi.fn(async (key: string) => data.get(key)?.ttl ?? -2),
    strlen: vi.fn(async (key: string) => data.get(key)?.value.length ?? 0),
    unlink: vi.fn(async (...keys: string[]) => {
      for (const key of keys) data.delete(key);
      return keys.length;
    }),
  };
  return { client, keys: () => [...data.keys()] };
}

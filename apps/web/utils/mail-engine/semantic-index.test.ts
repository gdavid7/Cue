import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_NOT_CACHED } from "@/utils/mail-engine/embedding-worker-client";
import {
  createSemanticIndex,
  SEMANTIC_INDEX_CAP,
  semanticSearchSupported,
} from "@/utils/mail-engine/semantic-index";
import type { TextEmbedder } from "@/utils/mail-search/semantic-embedding";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const stores: MailStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("createSemanticIndex", () => {
  it("embeds recent mail in small batches, and only what is new on the next pass", async () => {
    const store = await mailbox([
      message("kitchen", "Kitchen remodel proposal", { daysAgo: 1 }),
      message("dentist", "Appointment confirmed", { daysAgo: 2 }),
      message("ancient", "Kitchen ideas", {
        daysAgo: SEMANTIC_INDEX_CAP.windowMs / DAY_MS + 5,
      }),
    ]);
    const embedder = topicEmbedder();
    const index = createIndex(store, embedder);

    expect(await index.indexBacklog()).toBe(2);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    const [texts] = embedder.embed.mock.calls[0];
    expect(texts).toEqual([
      expect.stringContaining("Kitchen remodel proposal"),
      expect.stringContaining("Appointment confirmed"),
    ]);
    expect(await index.indexBacklog()).toBe(0);
  });

  it("finds mail by meaning, without loading the model while there are no vectors", async () => {
    const store = await mailbox([
      message("kitchen", "Kitchen remodel proposal", { daysAgo: 1 }),
      message("dentist", "Appointment confirmed", { daysAgo: 2 }),
    ]);
    const embedder = topicEmbedder();
    const index = createIndex(store, embedder);

    expect(await search(index, "kitchen contractor")).toEqual([]);
    expect(embedder.embed).not.toHaveBeenCalled();

    await index.indexBacklog();
    expect(
      (await search(index, "kitchen contractor")).map(
        (match) => match.conversationId,
      ),
    ).toEqual(["kitchen"]);
  });

  it("starts the background index after its delay, and stops when asked", async () => {
    vi.useFakeTimers();
    try {
      const store = await mailbox([
        message("kitchen", "Kitchen remodel proposal", { daysAgo: 1 }),
      ]);
      const embedder = topicEmbedder();
      const index = createSemanticIndex({
        store,
        embedder,
        nowMs: () => NOW,
        startDelayMs: 60_000,
      });
      index.start();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(embedder.embed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      index.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSemanticIndex when passes fail", () => {
  it("stops for the session when the model can't be kept on this device", async () => {
    const store = await mailbox([
      message("kitchen", "Kitchen remodel proposal", { daysAgo: 1 }),
    ]);
    const embedder = {
      embed: vi.fn(async () => {
        throw new Error(MODEL_NOT_CACHED);
      }),
    };
    const sleeps: number[] = [];
    const index = createSemanticIndex({
      store,
      embedder,
      nowMs: () => NOW,
      startDelayMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    index.start();
    await vi.waitFor(() => expect(embedder.embed).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    // No pass is scheduled after the first.
    expect(sleeps).toEqual([0]);
    expect(await search(index, "kitchen")).toEqual([]);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });

  it("backs off after each failure in a row, and a search only cuts the start delay short", async () => {
    vi.useFakeTimers();
    try {
      const store = await mailbox([
        message("kitchen", "Kitchen remodel proposal", { daysAgo: 1 }),
      ]);
      const embedder = {
        embed: vi.fn(async (): Promise<Float32Array[]> => {
          throw new Error("model_download_503");
        }),
      };
      const index = createSemanticIndex({
        store,
        embedder,
        nowMs: () => NOW,
        startDelayMs: 60_000,
      });
      index.start();
      await search(index, "kitchen");
      await vi.advanceTimersByTimeAsync(0);
      expect(embedder.embed).toHaveBeenCalledTimes(1);

      // Retries after 10 minutes, then 20: a search in between waits too.
      await search(index, "kitchen");
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(embedder.embed).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(19 * 60_000);
      expect(embedder.embed).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(embedder.embed).toHaveBeenCalledTimes(3);
      index.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("semanticSearchSupported", () => {
  const desktop = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
    hardwareConcurrency: 8,
  };

  it("runs on a desktop browser with the cores and memory for the model", () => {
    stubBrowserGlobals();
    try {
      expect(semanticSearchSupported(desktop)).toBe(true);
      expect(semanticSearchSupported({ ...desktop, deviceMemory: 2 })).toBe(
        false,
      );
      expect(
        semanticSearchSupported({ ...desktop, hardwareConcurrency: 2 }),
      ).toBe(false);
      expect(
        semanticSearchSupported({ ...desktop, connection: { saveData: true } }),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves phones out", () => {
    stubBrowserGlobals();
    try {
      expect(
        semanticSearchSupported({
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
          hardwareConcurrency: 6,
        }),
      ).toBe(false);
      expect(
        semanticSearchSupported({
          ...desktop,
          userAgentData: { mobile: true },
        }),
      ).toBe(false);
      // An iPad reads as a Mac; the page knows it has no fine pointer.
      expect(semanticSearchSupported(desktop, { touchOnly: true })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function stubBrowserGlobals() {
  vi.stubGlobal("caches", {});
  vi.stubGlobal("Worker", class {});
}

function createIndex(store: MailStore, embedder: TextEmbedder) {
  return createSemanticIndex({
    store,
    embedder,
    nowMs: () => NOW,
    sleep: async () => undefined,
  });
}

function search(index: ReturnType<typeof createSemanticIndex>, text: string) {
  return index.search({ accountId: "a", text, limit: 5 });
}

// Two topics, so similarity is 1 within one and 0 across them.
function topicEmbedder() {
  return {
    embed: vi.fn(async (texts: string[]) =>
      texts.map((text) =>
        /kitchen/i.test(text)
          ? Float32Array.from([1, 0])
          : Float32Array.from([0, 1]),
      ),
    ),
  };
}

async function mailbox(changes: ProviderChange[]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  stores.push(store);
  await store.ensureAccount({
    accountId: "a",
    provider: "google",
    generation: "g",
  });
  await store.applyHydration({
    session: { accountId: "a", generation: "g" },
    requestId: "test",
    changes,
    bodies: [],
  });
  return store;
}

function message(
  id: string,
  subject: string,
  { daysAgo }: { daysAgo: number },
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: id,
      version: "1",
    },
    fields: {
      from: "Sender <sender@example.com>",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: NOW - daysAgo * DAY_MS,
      roles: ["inbox"],
      subject,
      preview: "",
      read: true,
      starred: false,
      folderId: null,
      labelIds: ["INBOX"],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}

/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import {
  INBOX_SNAPSHOT_ROWS,
  clearInboxSnapshot,
  clearInboxSnapshots,
  readInboxSnapshot,
  resetInboxSnapshotBlocksForTesting,
  writeInboxSnapshot,
} from "./inbox-snapshot";

afterEach(() => {
  window.localStorage.clear();
  resetInboxSnapshotBlocksForTesting();
});

describe("inbox snapshot", () => {
  it("keeps the top of each account's inbox apart", () => {
    writeInboxSnapshot("acc-1", [thread("a1"), thread("a2")]);
    writeInboxSnapshot("acc-2", [thread("b1")]);

    expect(readInboxSnapshot("acc-1")?.map(({ id }) => id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(readInboxSnapshot("acc-2")?.map(({ id }) => id)).toEqual(["b1"]);
    expect(readInboxSnapshot("acc-3")).toBeNull();
  });

  it("keeps only what the first screens show", () => {
    const many = Array.from({ length: INBOX_SNAPSHOT_ROWS + 10 }, (_, index) =>
      thread(`t${index}`, "x".repeat(5000)),
    );
    writeInboxSnapshot("acc-1", many);

    const saved = readInboxSnapshot("acc-1");
    expect(saved).toHaveLength(INBOX_SNAPSHOT_ROWS);
    expect(saved?.[0]?.snippet.length).toBeLessThan(500);
    expect(saved?.[0]?.messages[0]?.snippet?.length).toBeLessThan(500);
  });

  it("forgets every saved inbox on sign-out, and a late save can't bring one back", () => {
    writeInboxSnapshot("acc-1", [thread("a1")]);

    clearInboxSnapshots();
    writeInboxSnapshot("acc-1", [thread("a1")]);

    expect(readInboxSnapshot("acc-1")).toBeNull();
  });

  it("forgets a removed account's inbox only", () => {
    writeInboxSnapshot("acc-1", [thread("a1")]);
    writeInboxSnapshot("acc-2", [thread("b1")]);

    clearInboxSnapshot("acc-1");
    writeInboxSnapshot("acc-1", [thread("a1")]);

    expect(readInboxSnapshot("acc-1")).toBeNull();
    expect(readInboxSnapshot("acc-2")).not.toBeNull();
  });

  it("ignores a saved entry it can't read", () => {
    window.localStorage.setItem("cue:inbox-snapshot:v1:acc-1", "{not json");

    expect(readInboxSnapshot("acc-1")).toBeNull();
  });
});

function thread(id: string, snippet = "") {
  return {
    id,
    messageIds: [`${id}-m`],
    snippet,
    plans: [],
    messages: [
      {
        id: `${id}-m`,
        threadId: id,
        snippet,
        subject: id,
        date: "2026-10-15T00:00:00.000Z",
        internalDate: "1",
        labelIds: ["INBOX"],
        headers: {
          from: "ada@example.com",
          to: "me@example.com",
          subject: id,
          date: "",
        },
      },
    ],
  } as unknown as ListThread;
}

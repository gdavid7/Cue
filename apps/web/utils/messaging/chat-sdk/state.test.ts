import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it } from "vitest";
import { withoutMessageContent } from "./state";

describe("withoutMessageContent", () => {
  // RD-3: a Telegram thread's messages would otherwise sit in Redis for a week.
  it("drops message history and transcripts but keeps other lists", async () => {
    const memory = createMemoryState();
    await memory.connect();
    const state = withoutMessageContent(memory);

    await state.appendToList("msg-history:telegram:1", { text: "Rent is due" });
    await state.appendToList("transcripts:user:1", { text: "Rent is due" });
    await state.appendToList("queue:telegram:1", { id: "message-1" });

    expect(await memory.getList("msg-history:telegram:1")).toEqual([]);
    expect(await memory.getList("transcripts:user:1")).toEqual([]);
    expect(await memory.getList("queue:telegram:1")).toEqual([
      { id: "message-1" },
    ]);
  });

  it("passes locks and dedupe keys through", async () => {
    const state = withoutMessageContent(createMemoryState());
    await state.connect();

    expect(await state.setIfNotExists("dedupe:telegram:1", true, 1000)).toBe(
      true,
    );
    expect(await state.setIfNotExists("dedupe:telegram:1", true, 1000)).toBe(
      false,
    );
  });
});

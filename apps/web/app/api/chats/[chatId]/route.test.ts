import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailAccountTestMiddleware();
});

import { GET, PATCH } from "./route";

describe("PATCH /api/chats/[chatId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when only unknown fields are provided", async () => {
    const request = new Request("http://localhost/api/chats/chat-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unsupportedField: true }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ chatId: "chat-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "At least one field must be provided.",
    });
    expect(prisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when no updatable fields are provided", async () => {
    const request = new Request("http://localhost/api/chats/chat-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ chatId: "chat-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "At least one field must be provided.",
    });
  });
});

describe("GET /api/chats/[chatId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The client waits on a marked reply, so a dead run's marker isn't reported.
  it("reports a running reply but not one whose run is past its limit", async () => {
    const startedAt = new Date();
    prisma.chat.findFirst.mockResolvedValueOnce({
      id: "chat-1",
      messages: [],
      activeStreamId: "stream-1",
      activeStreamStartedAt: startedAt,
    } as never);
    prisma.chat.findFirst.mockResolvedValueOnce({
      id: "chat-1",
      messages: [],
      activeStreamId: "stream-1",
      activeStreamStartedAt: new Date(Date.now() - 600_000),
    } as never);

    const live = await (await get()).json();
    const stale = await (await get()).json();

    expect(live).toMatchObject({
      activeStreamId: "stream-1",
      activeStreamStartedAt: startedAt.toISOString(),
    });
    expect(stale).toMatchObject({
      activeStreamId: null,
      activeStreamStartedAt: null,
    });
  });
});

function get() {
  return GET(new Request("http://localhost/api/chats/chat-1") as never, {
    params: Promise.resolve({ chatId: "chat-1" }),
  });
}

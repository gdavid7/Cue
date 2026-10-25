import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

const mocks = vi.hoisted(() => ({ loadInboxPreview: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/threads/inbox-preview.server", () => ({
  loadInboxPreview: mocks.loadInboxPreview,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});

import { GET } from "./route";

describe("GET /api/user/inbox-catch-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands a Gmail mailbox's newest inbox messages to the engine", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    } as never);
    const changes = [{ kind: "message_patch", messageId: "m1" }];
    mocks.loadInboxPreview.mockResolvedValue({ threads: [], changes });

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changes });
    expect(mocks.loadInboxPreview).toHaveBeenCalledWith({
      emailAccountId: "email-account-1",
      provider: "google",
      catchUp: true,
    });
  });

  // Outlook's engine could not use the messages, so nothing is read.
  it("reads nothing from Outlook", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "microsoft" },
    } as never);

    const response = await get();

    expect(await response.json()).toEqual({ changes: [] });
    expect(mocks.loadInboxPreview).not.toHaveBeenCalled();
  });

  it("answers with nothing when the preview gives up", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    } as never);
    mocks.loadInboxPreview.mockResolvedValue(null);

    expect(await (await get()).json()).toEqual({ changes: [] });
  });
});

function get() {
  return GET(new NextRequest("http://localhost:3000/api/user/inbox-catch-up"), {
    params: Promise.resolve({}),
  });
}

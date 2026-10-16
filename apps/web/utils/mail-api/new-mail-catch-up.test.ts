import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { nudgeGmailHistoryCatchUp } from "@/utils/webhook/google/history-catch-up";
import { nudgeCatchUpForNewGmail } from "./new-mail-catch-up";

vi.mock("@/utils/webhook/google/history-catch-up", () => ({
  nudgeGmailHistoryCatchUp: vi.fn().mockResolvedValue(undefined),
}));

const logger = createTestLogger();

describe("nudgeCatchUpForNewGmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the server to catch up to the newest inbox mail the client just synced", async () => {
    await nudgeCatchUpForNewGmail({
      emailAccountId: "account-1",
      results: [
        page([
          patch({ version: "1200", roles: ["inbox"] }),
          patch({ version: "1500", roles: ["inbox"] }),
        ]),
        { status: "reset_required", scopeId: "primary" },
      ],
      logger,
    });

    expect(nudgeGmailHistoryCatchUp).toHaveBeenCalledExactlyOnceWith({
      emailAccountId: "account-1",
      mailboxHistoryId: "1500",
      logger,
    });
  });

  it.each([
    ["sent mail", patch({ version: "1500", roles: ["sent"] })],
    [
      "a change to old inbox mail",
      patch({
        version: "1500",
        roles: ["inbox"],
        receivedAtMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
      }),
    ],
  ])("does not nudge for %s", async (_name, change) => {
    await nudgeCatchUpForNewGmail({
      emailAccountId: "account-1",
      results: [page([change])],
      logger,
    });

    expect(nudgeGmailHistoryCatchUp).not.toHaveBeenCalled();
  });
});

function page(changes: ReturnType<typeof patch>[]) {
  return { status: "page", page: { changes } } as any;
}

function patch({
  version,
  roles,
  receivedAtMs = Date.now() - 60_000,
}: {
  version: string;
  roles: string[];
  receivedAtMs?: number;
}) {
  return {
    kind: "message_patch",
    key: { accountId: "account-1", messageId: `m-${version}` },
    reference: {
      provider: "google",
      messageId: `m-${version}`,
      conversationId: "t",
      version,
    },
    fields: { roles, receivedAtMs },
  } as any;
}

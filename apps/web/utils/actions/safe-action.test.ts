import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "@/utils/error";
import {
  currentGmailQuotaContext,
  GmailCallDeferredError,
} from "@/utils/gmail/quota";
import { actionClientUser } from "./safe-action";

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

describe("server actions and the Gmail quota gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the user to retry shortly when the gate deferred a Gmail call, without reporting it", async () => {
    const action = actionClientUser
      .metadata({ name: "bulkArchive" })
      .action(async () => {
        // Gaxios wraps errors thrown below it, as the gate's deferral is.
        throw Object.assign(new Error("request failed"), {
          cause: new GmailCallDeferredError(12_000, "interactive"),
        });
      });

    const result = await action();

    expect(result?.serverError).toBe(
      "Gmail is busy for this account. Try again in about 12 seconds.",
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("charges a clicked action's Gmail calls as interactive and an action the app fires as background", async () => {
    const priorityIn = (name: string) =>
      actionClientUser
        .metadata({ name })
        .action(async () => currentGmailQuotaContext())();

    expect((await priorityIn("bulkArchive"))?.data).toEqual({
      caller: "bulkArchive",
      priority: "interactive",
    });
    expect((await priorityIn("assessUser"))?.data).toEqual({
      caller: "assessUser",
      priority: "background",
    });
  });
});

import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
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

  it("charges an action's Gmail calls at the priority it declares, and a click when it declares none", async () => {
    const clicked = await actionClientUser
      .metadata({ name: "archiveThread" })
      .action(async () => currentGmailQuotaContext())();
    const bulk = await actionClientUser
      .metadata({ name: "bulkArchive", gmailPriority: "sync" })
      .action(async () => currentGmailQuotaContext())();

    expect(clicked?.data).toEqual({
      caller: "archiveThread",
      priority: "interactive",
    });
    expect(bulk?.data).toEqual({ caller: "bulkArchive", priority: "sync" });
  });

  it("runs work an action leaves for after the response as background", async () => {
    // Next runs after() callbacks in the context they were registered from.
    const callbacks: Array<() => unknown> = [];
    vi.mocked(after).mockImplementation((callback) => {
      callbacks.push(AsyncLocalStorage.bind(callback as () => unknown));
    });
    let afterResponse: unknown = null;
    const result = await actionClientUser
      .metadata({ name: "cleanInbox" })
      .action(async () => {
        after(() => {
          afterResponse = currentGmailQuotaContext();
        });
        return currentGmailQuotaContext();
      })();

    for (const callback of callbacks) await callback();

    expect(result?.data).toEqual({
      caller: "cleanInbox",
      priority: "interactive",
    });
    expect(afterResponse).toEqual({
      caller: "cleanInbox",
      priority: "background",
    });
  });
});

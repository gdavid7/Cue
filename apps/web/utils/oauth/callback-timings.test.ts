import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "@/utils/error";
import { createScopedLogger } from "@/utils/logger";
import {
  deferCallbackStep,
  runWithCallbackTimings,
  timeCallbackStep,
} from "@/utils/oauth/callback-timings";

const { mockAfter } = vi.hoisted(() => ({ mockAfter: vi.fn() }));

vi.mock("next/server", async (importActual) => ({
  ...(await importActual<typeof import("next/server")>()),
  after: mockAfter,
}));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));

describe("runWithCallbackTimings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs one line with the steps the redirect waited on and those it didn't", async () => {
    const logger = createScopedLogger("test");
    const info = vi.spyOn(logger, "info");

    const response = await runWithCallbackTimings(
      { flow: "sign-in", provider: "google", logger },
      async () => {
        await timeCallbackStep("linkAccount", async () => {
          await timeCallbackStep("linkAccount.profile", async () => {});
        });
        await timeCallbackStep("linkAccount", async () => {});
        deferCallbackStep("calendarConnect", async () => {}, logger);
        return new Response(null, { status: 302 });
      },
    );

    expect(response.status).toBe(302);
    const lines = info.mock.calls.filter(
      ([message]) => message === "Sign-in callback timings",
    );
    expect(lines).toEqual([
      [
        "Sign-in callback timings",
        {
          flow: "sign-in",
          provider: "google",
          status: 302,
          totalMs: expect.any(Number),
          untrackedMs: expect.any(Number),
          steps: {
            linkAccount: expect.any(Number),
            "linkAccount.profile": expect.any(Number),
          },
          deferred: ["calendarConnect"],
        },
      ],
    ]);
  });

  it("still logs the line when the callback throws", async () => {
    const logger = createScopedLogger("test");
    const info = vi.spyOn(logger, "info");

    await expect(
      runWithCallbackTimings({ flow: "link", provider: "google", logger }, () =>
        Promise.reject(new Error("token exchange failed")),
      ),
    ).rejects.toThrow("token exchange failed");

    expect(info).toHaveBeenCalledWith(
      "Sign-in callback timings",
      expect.objectContaining({ flow: "link", status: "threw" }),
    );
  });
});

describe("deferCallbackStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a deferred step that fails instead of throwing", async () => {
    const logger = createScopedLogger("test");
    const logError = vi.spyOn(logger, "error");
    const error = new Error("calendar down");

    deferCallbackStep("calendarConnect", () => Promise.reject(error), logger);
    await expect(mockAfter.mock.calls[0]?.[0]()).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      "Deferred sign-in step failed",
      expect.objectContaining({ step: "calendarConnect", error }),
    );
    expect(captureException).toHaveBeenCalledWith(error, {
      extra: { step: "calendarConnect" },
    });
  });
});

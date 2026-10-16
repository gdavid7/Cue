import { afterEach, describe, expect, it, vi } from "vitest";
import { meterGmailCall } from "@/utils/gmail/quota";

const google = vi.hoisted(() => ({ baseUrl: undefined as string | undefined }));

vi.mock("@/env", async (importActual) => {
  const { env } = await importActual<typeof import("@/env")>();
  return {
    env: new Proxy(env, {
      get: (target, property) =>
        property === "GOOGLE_BASE_URL"
          ? google.baseUrl
          : Reflect.get(target, property),
    }),
  };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => false,
}));

// Without the shared store every Gmail call goes through unpaced, which
// against real Google ends in per-minute refusals for whole accounts.
describe("Gmail quota gate without its store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays quiet against the emulator", async () => {
    google.baseUrl = "http://localhost:4002";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await meterGmailCall({ emailAccountId: "account-1", cost: 5 }, async () =>
      Promise.resolve("ok"),
    );

    expect(gateOffErrors(error)).toHaveLength(0);
  });

  it("logs an error, once, when real Google is configured", async () => {
    google.baseUrl = undefined;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let call = 0; call < 2; call++)
      await expect(
        meterGmailCall({ emailAccountId: "account-1", cost: 5 }, async () =>
          Promise.resolve("ok"),
        ),
      ).resolves.toBe("ok");

    expect(gateOffErrors(error)).toHaveLength(1);
  });
});

function gateOffErrors(error: { mock: { calls: unknown[][] } }) {
  return error.mock.calls.filter(([line]) =>
    String(line).includes("Gmail quota gate is off"),
  );
}

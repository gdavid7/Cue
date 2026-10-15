import { log } from "next-axiom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOG_FIELD_PATHS } from "./log-fields";
import { createClientLogger } from "./logger-client";

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: {
    NEXT_PUBLIC_AXIOM_TOKEN: undefined as string | undefined,
  },
}));

vi.mock("next-axiom", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/env", () => ({
  env: mockedEnv,
}));

describe("createClientLogger", () => {
  beforeEach(() => {
    mockedEnv.NEXT_PUBLIC_AXIOM_TOKEN = undefined;
    vi.clearAllMocks();
  });

  it("logs trace to console and resolves lazy args without axiom", () => {
    const consoleDebugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => {});

    const logger = createClientLogger("client-test");

    logger.trace("Tracing details", () => ({ foo: "bar" }));

    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[client-test]:",
      "Tracing details",
      { foo: "bar" },
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs trace through axiom when the public token is configured", () => {
    mockedEnv.NEXT_PUBLIC_AXIOM_TOKEN = "public-token";

    const logger = createClientLogger("client-test");

    logger.trace("Tracing details", { foo: "bar" });

    expect(log.debug).toHaveBeenCalledWith("Tracing details", {
      scope: "client-test",
      foo: "bar",
    });
  });

  it("caps the key paths a browser event sends to axiom", () => {
    mockedEnv.NEXT_PUBLIC_AXIOM_TOKEN = "public-token";
    const byRoute = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`/route-${index}`, index]),
    );

    createClientLogger("client-test").warn("Slow routes", { byRoute });

    const [, shipped] = vi.mocked(log.warn).mock.calls[0];
    expect(
      Object.keys((shipped as { byRoute: object }).byRoute).length,
    ).toBeLessThan(MAX_LOG_FIELD_PATHS);
    expect(shipped).toMatchObject({ scope: "client-test" });
  });
});

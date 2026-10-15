import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axiomLog as log } from "@/utils/axiom-log";
import { LOG_FIELDS_OVERFLOW_KEY, MAX_LOG_FIELD_PATHS } from "./log-fields";
import { createScopedLogger, toLogJson } from "./logger";

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: (() => {
    let axiomToken: string | undefined;
    let throwOnAxiomTokenAccess = false;

    return {
      NODE_ENV: "test",
      get AXIOM_TOKEN() {
        if (throwOnAxiomTokenAccess) {
          throw new Error("Attempted to read server token in client context");
        }
        return axiomToken;
      },
      set AXIOM_TOKEN(value: string | undefined) {
        axiomToken = value;
      },
      setThrowOnAxiomTokenAccess(value: boolean) {
        throwOnAxiomTokenAccess = value;
      },
      NEXT_PUBLIC_AXIOM_TOKEN: undefined,
      NEXT_PUBLIC_LOG_SCOPES: undefined,
      ENABLE_DEBUG_LOGS: false,
    };
  })(),
}));

vi.mock("@/utils/axiom-log", () => ({
  axiomLog: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  describeAxiomTarget: () => 'dataset "test-dataset"',
}));

vi.mock("@/env", () => ({
  env: mockedEnv,
}));

describe("Logger", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedEnv.NODE_ENV = "test";
    mockedEnv.AXIOM_TOKEN = undefined;
    mockedEnv.setThrowOnAxiomTokenAccess(false);
    mockedEnv.NEXT_PUBLIC_AXIOM_TOKEN = undefined;
    mockedEnv.NEXT_PUBLIC_LOG_SCOPES = undefined;
    mockedEnv.ENABLE_DEBUG_LOGS = false;
    vi.unstubAllGlobals();
    vi.stubEnv("SHIP_LOGS_TO_AXIOM", "1");
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("redacts encoded MIME in provider errors even when debug logging is enabled", () => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.AXIOM_TOKEN = "server-token";
    mockedEnv.ENABLE_DEBUG_LOGS = true;
    const raw = Buffer.from(
      "To: recipient@example.com\r\n\r\nPrivate message",
    ).toString("base64url");
    createScopedLogger("test").error("Send failed", {
      error: { message: "Bad Gateway", status: 502, config: { data: { raw } } },
    });
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(raw);
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(raw);
    expect(log.error).toHaveBeenCalledWith(
      "Send failed",
      expect.objectContaining({
        error: expect.objectContaining({
          status: 502,
          config: { data: { raw: true } },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Axiom logging when the server token is configured", () => {
    mockedEnv.AXIOM_TOKEN = "server-token";

    const logger = createScopedLogger("test");

    logger.info("Server log", { foo: "bar" });

    expect(log.info).toHaveBeenCalledWith(
      "Server log",
      expect.objectContaining({ scope: "test", foo: "bar" }),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[test]: Server log"),
    );
  });

  it("says once per instance whether production server logs ship to Axiom, and why not", () => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.AXIOM_TOKEN = "server-token";
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const axiomLines = (spy: typeof consoleWarnSpy) =>
      spy.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[axiom]"));

    vi.stubEnv("SHIP_LOGS_TO_AXIOM", "");
    createScopedLogger("first");
    createScopedLogger("second");
    expect(axiomLines(consoleWarnSpy)).toEqual([
      expect.stringContaining("this build has no SHIP_LOGS_TO_AXIOM"),
    ]);

    vi.stubEnv("SHIP_LOGS_TO_AXIOM", "1");
    createScopedLogger("third");
    createScopedLogger("fourth");
    expect(axiomLines(consoleLogSpy)).toEqual([
      '[axiom]: Server logs ship to dataset "test-dataset"',
    ]);
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(
      "server-token",
    );
  });

  it("keeps logs off Axiom outside Vercel even with the server token", () => {
    // Local builds, test runs and Playwright servers can carry the
    // production token; their errors must not read as production ones.
    vi.stubEnv("SHIP_LOGS_TO_AXIOM", "");
    mockedEnv.AXIOM_TOKEN = "server-token";

    createScopedLogger("test").error("Local failure");

    expect(log.error).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[test]: Local failure"),
    );
  });

  it("ships from a Vercel build when the runtime does not expose VERCEL", () => {
    vi.stubEnv("VERCEL", "");
    mockedEnv.AXIOM_TOKEN = "server-token";

    createScopedLogger("test").error("Production failure");

    expect(log.error).toHaveBeenCalledWith(
      "Production failure",
      expect.objectContaining({ scope: "test" }),
    );
  });

  it("keeps request context on the console copy of Axiom logs", () => {
    mockedEnv.AXIOM_TOKEN = "server-token";

    createScopedLogger("test").with({ requestId: "req_1" }).info("Scoped log");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("req_1"),
    );
  });

  it("logs one serialized production error to Axiom without errorFull", () => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.AXIOM_TOKEN = "server-token";

    const logger = createScopedLogger("test");
    const error = {
      name: "ProviderError",
      message: "Provider request failed",
      code: "rate_limit_exceeded",
      statusCode: 429,
      requestId: "req_123",
      retriesLeft: 2,
      retryDelay: 500,
      config: {
        url: "https://api.example.test/v1/messages",
        method: "POST",
        retryConfig: {
          currentRetryAttempt: 1,
          statusCodesToRetry: [429, 500],
          totalTimeout: 60_000,
        },
      },
      responseHeaders: {
        "x-request-id": "header_req_123",
        "content-type": "application/json",
        server: "provider",
        "set-cookie": "provider-session=secret",
      },
      cause: {
        code: "ECONNRESET",
        message: "socket hang up",
        socket: {
          bytesRead: 10,
          remoteAddress: "127.0.0.1",
        },
      },
    };

    logger.error("Provider error", { error, operation: "send" });

    expect(log.error).toHaveBeenCalledWith("Provider error", {
      scope: "test",
      operation: "send",
      errorMessage: "Provider request failed",
      error: expect.objectContaining({
        name: "ProviderError",
        message: "Provider request failed",
        code: "rate_limit_exceeded",
        statusCode: 429,
        requestId: "req_123",
        config: expect.objectContaining({
          url: "https://api.example.test/v1/messages",
          method: "POST",
          retryConfig: expect.objectContaining({
            currentRetryAttempt: 1,
          }),
        }),
        cause: expect.objectContaining({
          code: "ECONNRESET",
          message: "socket hang up",
        }),
        responseHeaders: expect.objectContaining({
          "set-cookie": true,
        }),
      }),
    });
    expect(log.error).not.toHaveBeenCalledWith(
      "Provider error",
      expect.objectContaining({ errorFull: expect.anything() }),
    );
  });

  it("uses the serialized production error format for Axiom warnings", () => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.AXIOM_TOKEN = "server-token";

    const logger = createScopedLogger("test");

    logger.warn("Retrying provider request", {
      error: {
        headers: {
          "x-request-id": "header_req_456",
          server: "provider",
        },
        response: {
          data: {
            error: {
              message: "Rate limited",
              status: 429,
              code: "RESOURCE_EXHAUSTED",
            },
          },
        },
        config: {
          retryConfig: {
            statusCodesToRetry: [429, 500],
          },
        },
      },
    });

    expect(log.warn).toHaveBeenCalledWith("Retrying provider request", {
      scope: "test",
      errorMessage: "Rate limited",
      error: expect.objectContaining({
        response: expect.objectContaining({
          data: {
            error: {
              message: "Rate limited",
              status: 429,
              code: "RESOURCE_EXHAUSTED",
            },
          },
        }),
      }),
    });
  });

  it("does not use Axiom logging when only the public token is configured", () => {
    mockedEnv.NEXT_PUBLIC_AXIOM_TOKEN = "public-token";

    const logger = createScopedLogger("test");

    logger.info("Server log");

    expect(log.info).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it("does not read the server token when used on the client", () => {
    vi.stubGlobal("window", {});
    mockedEnv.setThrowOnAxiomTokenAccess(true);

    expect(() => {
      const logger = createScopedLogger("test");
      logger.info("Client log");
    }).not.toThrow();

    expect(log.info).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it("should serialize simple Error objects", () => {
    const logger = createScopedLogger("test");
    const error = new Error("Something went wrong");

    logger.error("Error occurred", { error });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("Something went wrong");
  });

  it("should serialize Error instances as message only", () => {
    const logger = createScopedLogger("test");
    const error = new Error("Custom error") as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 400;
    error.code = "VALIDATION_ERROR";

    logger.error("Validation failed", { error });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("Custom error");
    // Error instances show only message in console logs (custom properties not shown)
  });

  it("should serialize nested error objects", () => {
    const logger = createScopedLogger("test");
    const error = {
      response: {
        data: {
          error: { code: 500, message: "Internal error" },
        },
      },
    };

    logger.error("Error processing message", { error });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("500");
    expect(loggedMessage).toContain("Internal error");
  });

  it("should serialize deeply nested errors", () => {
    const logger = createScopedLogger("test");
    const error = {
      error: {
        response: {
          data: {
            error: {
              code: 404,
              message: "Not found",
              details: { resource: "user", id: "123" },
            },
          },
        },
      },
    };

    logger.error("Resource not found", { error });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("404");
    expect(loggedMessage).toContain("Not found");
    expect(loggedMessage).toContain("user");
    expect(loggedMessage).toContain("123");
  });

  it("should serialize arrays of errors", () => {
    const logger = createScopedLogger("test");
    const errors = [
      new Error("Error 1"),
      { message: "Error 2", code: 400 },
      new Error("Error 3"),
    ];

    logger.error("Multiple errors", { errors });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("Error 1");
    expect(loggedMessage).toContain("Error 2");
    expect(loggedMessage).toContain("Error 3");
    expect(loggedMessage).toContain("400");
  });

  it("should serialize axios-like error structure", () => {
    const logger = createScopedLogger("test");
    const error = {
      response: {
        status: 401,
        data: {
          error: "Unauthorized",
          message: "Invalid token",
        },
      },
      config: {
        url: "/api/endpoint",
        method: "POST",
      },
    };

    logger.error("API request failed", { error });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).not.toContain("[object Object]");
    expect(loggedMessage).toContain("401");
    expect(loggedMessage).toContain("Unauthorized");
    expect(loggedMessage).toContain("Invalid token");
    expect(loggedMessage).toContain("/api/endpoint");
  });

  it("caps the key paths an Axiom event adds and still redacts what overflows", () => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.AXIOM_TOKEN = "server-token";
    const recipients = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `thread-${index}`,
        { subject: `Private subject ${index}` },
      ]),
    );

    createScopedLogger("test")
      .with({ requestId: "req_1" })
      .info("Sent replies", { recipients });

    const [, shipped] = vi.mocked(log.info).mock.calls[0];
    expect(flattenKeys(shipped).length).toBeLessThanOrEqual(
      MAX_LOG_FIELD_PATHS,
    );
    expect(shipped).toMatchObject({ scope: "test", requestId: "req_1" });
    const overflow = String(
      (shipped as Record<string, unknown>)[LOG_FIELDS_OVERFLOW_KEY],
    );
    expect(overflow).toContain("thread-79");
    expect(JSON.stringify(shipped)).not.toContain("Private subject");
  });

  it("redacts sensitive fields inside a JSON log field", () => {
    mockedEnv.NODE_ENV = "production";

    const json = toLogJson({
      "thread-1": { subject: "Private subject", accessToken: "secret-token" },
    });

    expect(JSON.parse(json)).toEqual({
      "thread-1": { subject: true, accessToken: true },
    });
  });

  it("always redacts received OAuth state values", () => {
    const logger = createScopedLogger("test");
    const receivedState = "signed-oauth-state-secret";

    logger.error("Invalid OAuth state", { receivedState });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];
    expect(loggedMessage).toContain('"receivedState": true');
    expect(loggedMessage).not.toContain(receivedState);
  });

  it("should handle complex nested error objects without [object Object]", () => {
    const logger = createScopedLogger("test");

    // Complex error like Gmail API error
    const complexError = {
      error: {
        response: {
          data: {
            error: {
              code: 404,
              message: "Requested entity was not found.",
              status: "NOT_FOUND",
            },
          },
        },
        code: 404,
        message: "Requested entity was not found.",
      },
      attemptNumber: 1,
      retriesLeft: 5,
    };

    logger.error("Error finding draft", { error: complexError });

    const loggedMessage = consoleErrorSpy.mock.calls[0][0];

    // Should not have [object Object]
    expect(loggedMessage).not.toContain("[object Object]");

    // Should contain important details
    expect(loggedMessage).toContain("404");
    expect(loggedMessage).toContain("Requested entity was not found");
    expect(loggedMessage).toContain("attemptNumber");
    expect(loggedMessage).toContain("retriesLeft");
  });
});

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

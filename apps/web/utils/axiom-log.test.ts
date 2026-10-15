import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axiomLog } from "./axiom-log";
import { createScopedLogger } from "./logger";

// next-axiom reads its dataset and token when it loads.
vi.hoisted(() => {
  process.env.AXIOM_DATASET = "cue-test";
  process.env.AXIOM_TOKEN = "xaat-test-secret";
  delete process.env.NEXT_PUBLIC_AXIOM_INGEST_ENDPOINT;
  delete process.env.AXIOM_INGEST_ENDPOINT;
  delete process.env.NEXT_PUBLIC_AXIOM_DATASET;
  delete process.env.NEXT_PUBLIC_AXIOM_TOKEN;
});

vi.mock("@/env", () => ({
  env: {
    NODE_ENV: "production",
    AXIOM_TOKEN: "xaat-test-secret",
    ENABLE_DEBUG_LOGS: false,
    NEXT_PUBLIC_LOG_SCOPES: undefined,
    NEXT_PUBLIC_AXIOM_DATASET: undefined,
    NEXT_PUBLIC_AXIOM_TOKEN: undefined,
  },
}));

const INGEST_URL = "https://api.axiom.co/v1/datasets/cue-test/ingest";

describe("axiomLog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SHIP_LOGS_TO_AXIOM", "1");
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends a request's logs to the dataset's ingest API when the logger flushes, and says it worked", async () => {
    fetchMock.mockResolvedValue(ingestResponse(200, { ingested: 1 }));

    const logger = createScopedLogger("api").with({ url: "/api/threads" });
    logger.info("Request handled", { durationMs: 12 });
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(INGEST_URL);
    expect(JSON.parse(init.body)).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Request handled",
        fields: { scope: "api", url: "/api/threads", durationMs: 12 },
      }),
    ]);
    expect(axiomLines(consoleLog)).toContain(
      '[axiom]: Axiom log shipping works: HTTP 200, 1 events to dataset "cue-test" (from AXIOM_DATASET) at api.axiom.co, token from AXIOM_TOKEN',
    );
  });

  it("warns once when Axiom refuses the token or dataset, which next-axiom alone would swallow", async () => {
    fetchMock.mockImplementation(async () =>
      ingestResponse(403, { message: "Forbidden" }),
    );

    for (const message of ["first", "second"]) {
      axiomLog.error(message, {});
      await axiomLog.flush();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(axiomLines(consoleWarn)).toEqual([
      '[axiom]: Axiom refused 1 log events with HTTP 403 (dataset "cue-test" (from AXIOM_DATASET) at api.axiom.co, token from AXIOM_TOKEN): {"message":"Forbidden"}',
    ]);
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(
      "xaat-test-secret",
    );
  });

  it("warns when Axiom accepts the request but drops events, as past the field limit", async () => {
    fetchMock.mockResolvedValue(
      ingestResponse(200, {
        ingested: 0,
        failed: 1,
        failures: [{ error: "adding field would exceed the field limit" }],
      }),
    );

    axiomLog.warn("Slow request", { durationMs: 9000 });
    await axiomLog.flush();

    expect(axiomLines(consoleWarn)).toEqual([
      expect.stringContaining(
        'dropped 1 of 1 log events (dataset "cue-test" (from AXIOM_DATASET) at api.axiom.co, token from AXIOM_TOKEN): adding field would exceed the field limit',
      ),
    ]);
  });
});

function ingestResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function axiomLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("[axiom]"));
}

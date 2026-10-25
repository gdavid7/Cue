import { Logger, LogLevel } from "next-axiom";
import { serializeError } from "serialize-error";
import { describe, expect, it } from "vitest";
import {
  type AxiomResults,
  buildAxiomQueries,
  buildHealthReport,
  formatAxiomError,
  formatHumanSummary,
  formatReportBlock,
  HEALTH_REPORT_END,
  HEALTH_REPORT_START,
  isThrottledMailResponse,
  parseAxiomTabular,
  type RobotResults,
  redact,
  runAxiomQueries,
  summarizeAxiom,
  summarizeSentry,
} from "./health-report";

const NOW = new Date("2026-10-14T12:00:00Z");

describe("parseAxiomTabular", () => {
  it("turns column-major tables into rows", () => {
    expect(
      parseAxiomTabular({
        tables: [
          {
            fields: [{ name: "route" }, { name: "count" }],
            columns: [
              ["/api/threads", "/api/chat"],
              [12, 3],
            ],
          },
        ],
      }),
    ).toEqual([
      { route: "/api/threads", count: 12 },
      { route: "/api/chat", count: 3 },
    ]);
  });

  it("returns no rows for an empty or unexpected body", () => {
    expect(parseAxiomTabular({ tables: [] })).toEqual([]);
    expect(parseAxiomTabular(null)).toEqual([]);
  });
});

describe("buildAxiomQueries", () => {
  it("cannot be broken out of the dataset name", () => {
    const queries = buildAxiomQueries("vercel'] | delete");
    expect(queries.totals.startsWith("['vercel] | delete']")).toBe(true);
  });

  it.each([
    "map",
    "flattened",
  ] as const)("samples the latest error events without aggregating computed columns (%s)", (layout) => {
    const apl = buildAxiomQueries("cue", layout).errorSamples;

    // Axiom could not find the temporaries of computed columns from an
    // aggregate after `extend` or `project` ("field '_tmp30' not found in
    // current projection"), so the newest event per error is picked in code.
    expect(apl).toMatch(
      /\| project _time, route = .+ \| top \d+ by _time desc$/,
    );
    expect(apl).not.toMatch(/\| (extend|summarize) |arg_max/);
  });

  it("only names fields that next-axiom ships for Cue's logger calls", () => {
    const logger = shipCueLoggerCalls();
    const shipped = new Set(
      logger.logEvents.flatMap((event) => flattenKeys(event)),
    );
    // Callers are list values, not keys, so they add no columns.
    expect([...shipped].filter((key) => key.includes("messages/send"))).toEqual(
      [],
    );

    const checked = new Set<string>();
    for (const [name, apl] of Object.entries(
      buildAxiomQueries("cue", "flattened"),
    )) {
      const bracketed = [...apl.matchAll(/\['([^']+)'\]/g)].map((m) => m[1]);
      expect(bracketed, name).toEqual(["cue"]);
      for (const [, field] of apl.matchAll(/column_ifexists\('([^']+)'/g)) {
        // next-axiom files the same platform metadata under `vercel` on
        // Vercel and under `platform` elsewhere, such as this test, and only
        // adds `git` on Vercel.
        const shippedAs = field.replace(/^vercel\./, "platform.");
        if (field.startsWith("git.")) expect(field).toBe("git.ref");
        else expect(shipped, `${name} names ${field}`).toContain(shippedAs);
        checked.add(field);
      }
    }
    expect([...checked].sort()).toEqual([
      "fields.cause",
      "fields.durationMs",
      "fields.error.code",
      "fields.error.name",
      "fields.error.stack",
      "fields.error.status",
      "fields.errorMessage",
      "fields.limitUnits",
      "fields.stack",
      "fields.totalUnits",
      "fields.url",
      "git.ref",
      "level",
      "message",
      "vercel.environment",
      "vercel.region",
    ]);
  });

  it("reads logger context as keys of the fields map field", () => {
    const events = shipCueLoggerCalls().logEvents;
    const contextPaths = new Set(
      events.flatMap((event) =>
        flattenKeys((event as { fields?: object }).fields ?? {}),
      ),
    );

    const checked = new Set<string>();
    for (const [name, apl] of Object.entries(buildAxiomQueries("cue", "map"))) {
      expect(apl, name).not.toContain("column_ifexists('fields.");
      for (const [access] of apl.matchAll(/\['fields'\](?:\['[^']+'\])+/g)) {
        const path = [...access.matchAll(/\['([^']+)'\]/g)]
          .map((match) => match[1])
          .slice(1)
          .join(".");
        expect(contextPaths, `${name} reads ${path}`).toContain(path);
        checked.add(path);
      }
    }
    expect([...checked].sort()).toEqual([
      "cause",
      "durationMs",
      "error.code",
      "error.name",
      "error.stack",
      "error.status",
      "errorMessage",
      "limitUnits",
      "stack",
      "totalUnits",
      "url",
    ]);
    expect(buildAxiomQueries("cue", "map").errorsByRoute).toContain(
      "by route = tostring(['fields']['url'])",
    );
  });

  it("falls back to the flattened columns when Axiom rejects the map form", async () => {
    const map = buildAxiomQueries("cue", "map");
    const flattened = buildAxiomQueries("cue", "flattened");
    const ran: string[] = [];

    const results = await runAxiomQueries("cue", async (apl) => {
      ran.push(apl);
      if (apl.includes("['fields']")) {
        return { error: "HTTP 400: field 'fields' not found" };
      }
      if (apl === flattened.slowestRoutes) return { error: "HTTP 500" };
      return { rows: [{ events: 1 }] };
    });

    expect(results.errorsByRoute).toEqual({ rows: [{ events: 1 }] });
    expect(results.slowestRoutes).toEqual({ error: "HTTP 500" });
    // The query that names no logger context runs once.
    expect(ran.filter((apl) => apl === map.gmailRateLimited)).toHaveLength(1);
    expect(ran).toContain(flattened.errorSamples);
  });

  it("keeps the map form's result when Axiom accepts it", async () => {
    const ran: string[] = [];

    await runAxiomQueries("cue", async (apl) => {
      ran.push(apl);
      return { rows: [] };
    });

    expect(ran.some((apl) => apl.includes("column_ifexists('fields."))).toBe(
      false,
    );
  });
});

describe("formatAxiomError", () => {
  it("keeps the status and the start of Axiom's reason", () => {
    const error = formatAxiomError(
      400,
      `{"code":400,"message":"invalid query:\n unknown field 'level'${" x".repeat(200)}"}`,
    );
    expect(error).toMatch(
      /^HTTP 400: \{"code":400,"message":"invalid query: unknown field 'level'/,
    );
    expect(error.length).toBeLessThanOrEqual("HTTP 400: ".length + 200);
    expect(formatAxiomError(502, "  ")).toBe("HTTP 502");
  });
});

describe("summarizeAxiom", () => {
  it("summarizes errors, Gmail rate limits, quota usage and slow routes", () => {
    const summary = summarizeAxiom({
      totals: {
        rows: [{ total: 900, appLogs: 880, errors: 14, warnings: 30 }],
      },
      errorsByRoute: {
        rows: [
          {
            route: "/api/threads/clx9k2m3n4p5q6r7s8t9u0v1w2",
            message: "Failed for jane.doe@example.org",
            events: 9,
          },
        ],
      },
      gmailRateLimited: { rows: [{ events: 4 }] },
      gmailQuotaUsage: {
        rows: [
          {
            samples: 60,
            maxUnits: 14_500,
            avgUnits: 3210.6,
            limitUnits: 15_000,
          },
        ],
      },
      gmailDeferred: { rows: [{ events: 2 }] },
      slowestRoutes: {
        rows: [
          { route: "/api/chat?x=1", p95Ms: 8123.4, maxMs: 20_000, events: 5 },
        ],
      },
      errorSamples: { rows: [] },
    });

    expect(summary).toMatchObject({
      errors: 14,
      appLogs: 880,
      gmailRateLimitExceeded: 4,
      gmailQuota: {
        status: "present",
        maxUnitsPerMinute: 14_500,
        avgUnitsPerMinute: 3211,
        deferredCalls: 2,
      },
      slowestRoutes: [{ route: "/api/chat", p95Ms: 8123, maxMs: 20_000 }],
      failedQueries: [],
    });
    expect(summary.topErrors[0]?.route).toBe("/api/threads/:id");
    expect(JSON.stringify(summary)).not.toContain("jane.doe");
  });

  it("attaches one redacted sample to each top error", () => {
    const filtersRoute = "/api/user/stats/newsletters";
    const summary = summarizeAxiom({
      ...emptyAxiomResults(),
      errorsByRoute: {
        rows: [
          {
            route: filtersRoute,
            message: "Error getting email filters",
            events: 49,
          },
          { route: "", message: "Discovery fetch failed", events: 6 },
          { route: "/api/labels", message: "Error fetching labels", events: 1 },
        ],
      },
      errorSamples: {
        rows: [
          {
            route: filtersRoute,
            message: "Error getting email filters",
            errorName: "",
            errorMessage:
              'Gmail call deferred for 20s for jane.doe@example.org in "Quarterly salary review for the whole team"',
            errorStatus: "403",
            errorCode: "403",
            errorStack: [
              "Error: Gmail call deferred",
              "    at admitGmailCall (/var/task/apps/web/.next/server/chunks/quota.js:1:200)",
              "    at async meterGmailCall (/var/task/apps/web/.next/server/chunks/quota.js:1:900)",
              "    at async getEmailFilters (/var/task/apps/web/.next/server/chunks/filters.js:1:50)",
              "    at async Promise.all (index 1)",
            ].join("\n"),
            vercelEnvironment: "production",
            vercelRegion: "iad1",
            gitRef: "main",
          },
          {
            route: "",
            message: "Discovery fetch failed",
            errorMessage: "TypeError: fetch failed",
            errorStack: "",
            vercelEnvironment: "",
          },
        ],
      },
    });

    const [filters, discovery, labels] = summary.topErrors;
    expect(filters?.sample).toEqual({
      errorName: "Error",
      errorMessage: 'Gmail call deferred for 20s for [REDACTED:EMAIL] in "…"',
      status: "403",
      stack: [
        "at admitGmailCall (/var/task/apps/web/.next/server/chunks/quota.js:1:200)",
        "at async meterGmailCall (/var/task/apps/web/.next/server/chunks/quota.js:1:900)",
        "at async getEmailFilters (/var/task/apps/web/.next/server/chunks/filters.js:1:50)",
      ],
      origin: "vercel iad1 (main)",
    });
    expect(discovery?.sample).toMatchObject({
      errorMessage: "TypeError: fetch failed",
      stack: [],
      origin: "not vercel",
    });
    expect(labels).not.toHaveProperty("sample");
    expect(
      summarizeAxiom({
        ...emptyAxiomResults(),
        errorsByRoute: {
          rows: [{ route: "/api/labels", message: "Failed", events: 2 }],
        },
        errorSamples: {
          rows: [
            { route: "/api/labels", message: "Failed", errorMessage: "newest" },
            { route: "/api/labels", message: "Failed", errorMessage: "older" },
          ],
        },
      }).topErrors[0]?.sample?.errorMessage,
    ).toBe("newest");
    expect(JSON.stringify(summary)).not.toMatch(/jane\.doe|salary/);
  });

  it("keeps the other signals when one query fails", () => {
    const summary = summarizeAxiom({
      totals: { rows: [{ total: 10, errors: 0, warnings: 0 }] },
      errorsByRoute: { rows: [] },
      gmailRateLimited: { error: "HTTP 400" },
      gmailQuotaUsage: { rows: [{ samples: 0 }] },
      gmailDeferred: { rows: [] },
      slowestRoutes: { error: "timeout" },
      errorSamples: { rows: [] },
    });

    expect(summary.errors).toBe(0);
    expect(summary.gmailRateLimitExceeded).toBeUndefined();
    expect(summary.gmailQuota).toEqual({ status: "no_quota_logs" });
    expect(summary.failedQueries.map((q) => q.query)).toEqual([
      "gmailRateLimited",
      "slowestRoutes",
    ]);
    const report = buildHealthReport({
      robot: { status: "no_results" },
      axiom: { status: "ok", summary },
      sentry: { status: "not_configured", missing: ["SENTRY_AUTH_TOKEN"] },
      now: NOW,
    });
    expect(report.problems).toContain(
      "Axiom query gmailRateLimited failed: HTTP 400",
    );
  });
});

describe("summarizeSentry", () => {
  it("counts last-day events and flags issues first seen in the last day", () => {
    const summary = summarizeSentry(
      [
        {
          shortId: "CUE-1",
          title: "TypeError: x is undefined",
          culprit: "/api/old",
          count: "5000",
          userCount: 3,
          firstSeen: "2026-09-01T00:00:00Z",
          stats: {
            "24h": [
              [1, 2],
              [2, 3],
            ],
          },
        },
        {
          shortId: "CUE-2",
          title: "Error: token=abcdefghijklmnopqrstuvwxyz123456 rejected",
          culprit: "/api/new",
          count: "40",
          userCount: 7,
          firstSeen: "2026-10-14T08:00:00Z",
          stats: { "24h": [[1, 40]] },
        },
      ],
      NOW,
    );

    expect(summary.unresolvedSeen).toBe(2);
    expect(summary.newIssues).toBe(1);
    expect(
      summary.topIssues.map((issue) => [
        issue.id,
        issue.events24h,
        issue.isNew,
      ]),
    ).toEqual([
      ["CUE-2", 40, true],
      ["CUE-1", 5, false],
    ]);
    expect(summary.topIssues[0]?.title).not.toContain("abcdefghijklmnop");
  });
});

describe("buildHealthReport", () => {
  const robotResults: RobotResults = {
    status: "failed",
    baseUrl: "https://cue-inbox.vercel.app",
    startedAt: NOW.toISOString(),
    steps: [
      {
        name: "inbox shows real mail",
        status: "passed",
        durationMs: 4100.4,
        metrics: { timeToFirstRowMs: 3900, inboxRows: 20 },
        consoleErrors: [],
        failedRequests: [],
      },
      {
        name: "chat answers about seeded mail",
        status: "failed",
        durationMs: 120_000,
        error: "Timed out waiting for an answer for qa.robot@gmail.com",
        consoleErrors: ["Failed to load resource"],
        failedRequests: [
          {
            method: "POST",
            url: "https://cue-inbox.vercel.app/api/chat",
            status: 500,
          },
        ],
      },
    ],
  };

  it("lists robot failures and leaves unconfigured sources as NOT CONFIGURED", () => {
    const report = buildHealthReport({
      robot: { status: "ok", results: robotResults },
      axiom: { status: "not_configured", missing: ["AXIOM_QUERY_TOKEN"] },
      sentry: { status: "error", error: "HTTP 401" },
      now: NOW,
    });

    expect(report.robot).toMatchObject({
      status: "ok",
      outcome: "failed",
      timeToFirstRowMs: 3900,
      steps: [
        { name: "inbox shows real mail", durationMs: 4100 },
        {
          name: "chat answers about seeded mail",
          failedRequests: ["500 POST https://cue-inbox.vercel.app/api/chat"],
        },
      ],
    });
    expect(report.problems).toEqual([
      expect.stringContaining(
        'Robot step "chat answers about seeded mail" failed',
      ),
      "Sentry query failed: HTTP 401",
    ]);
    expect(JSON.stringify(report)).not.toContain("qa.robot@gmail.com");

    const summary = formatHumanSummary(report);
    expect(summary).toContain(
      "Robot: FAILED (1/2 steps passed, first inbox row 3900 ms)",
    );
    expect(summary).toContain(
      "Axiom: NOT CONFIGURED (missing AXIOM_QUERY_TOKEN)",
    );
  });

  it("reports a lapsed Gmail connection as a reconnect instruction", () => {
    const report = buildHealthReport({
      robot: {
        status: "ok",
        results: { ...robotResults, status: "needs_reconnect", steps: [] },
      },
      axiom: { status: "not_configured", missing: [] },
      sentry: { status: "not_configured", missing: [] },
      now: NOW,
    });

    expect(report.problems[0]).toMatch(/^TEST ACCOUNT NEEDS RECONNECTING/);
  });

  it("prints one JSON block between the markers", () => {
    const report = buildHealthReport({
      robot: { status: "not_configured", missing: ["CUE_QA_EMAIL"] },
      axiom: { status: "not_configured", missing: ["AXIOM_DATASET"] },
      sentry: { status: "not_configured", missing: ["SENTRY_PROJECT"] },
      now: NOW,
    });
    const lines = formatReportBlock(report).split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEALTH_REPORT_START);
    expect(lines[2]).toBe(HEALTH_REPORT_END);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      version: 1,
      robot: { status: "not_configured" },
      problems: [],
    });
  });

  it("says the Outlook steps are NOT CONFIGURED without their secret", () => {
    const report = buildHealthReport({
      robot: { status: "ok", results: robotResults },
      outlook: { status: "not_configured", missing: ["CUE_QA_OUTLOOK_EMAIL"] },
      axiom: { status: "not_configured", missing: [] },
      sentry: { status: "not_configured", missing: [] },
      now: NOW,
    });

    expect(report.outlook).toEqual({
      status: "not_configured",
      missing: ["CUE_QA_OUTLOOK_EMAIL"],
    });
    const summary = formatHumanSummary(report);
    expect(summary).toContain(
      "Robot: FAILED (1/2 steps passed, first inbox row 3900 ms)",
    );
    expect(summary).toContain(
      "Outlook: NOT CONFIGURED (missing CUE_QA_OUTLOOK_EMAIL)",
    );
  });

  it("summarizes the Outlook steps and reports their failures", () => {
    const outlookStep = {
      consoleErrors: [],
      failedRequests: [],
    };
    const report = buildHealthReport({
      robot: {
        status: "ok",
        results: {
          ...robotResults,
          steps: [
            ...robotResults.steps,
            {
              ...outlookStep,
              name: "Outlook: probe arrives and the reply reaches Gmail",
              status: "passed",
              durationMs: 52_000,
              metrics: { inboundSyncMs: 8000.4, replyDeliveredMs: 41_000 },
            },
            {
              ...outlookStep,
              name: "Outlook: Today shows its sections",
              status: "failed",
              durationMs: 60_000,
              error: "Today did not load",
            },
          ],
        },
      },
      outlook: { status: "configured" },
      axiom: { status: "not_configured", missing: [] },
      sentry: { status: "not_configured", missing: [] },
      now: NOW,
    });

    expect(report.outlook).toEqual({
      status: "ok",
      passed: 1,
      total: 2,
      inboundSyncMs: 8000,
      replyDeliveredMs: 41_000,
    });
    expect(report.problems).toContain(
      'Robot step "Outlook: Today shows its sections" failed: Today did not load',
    );
    expect(formatHumanSummary(report)).toContain(
      "Outlook: 1/2 steps passed (probe arrived in 8000 ms, reply reached Gmail in 41000 ms)",
    );
  });

  it("leaves the report as it was when the caller says nothing about Outlook", () => {
    const report = buildHealthReport({
      robot: { status: "ok", results: robotResults },
      axiom: { status: "not_configured", missing: [] },
      sentry: { status: "not_configured", missing: [] },
      now: NOW,
    });

    expect(report).not.toHaveProperty("outlook");
    expect(formatHumanSummary(report)).not.toContain("Outlook");
  });
});

describe("redact", () => {
  it("removes addresses, credentials and long identifiers and caps the length", () => {
    const text = redact(
      `user someone@gmail.com thread 18f51c0b4a9d7c02aa11 id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(300)}`,
    );

    expect(text).not.toMatch(
      /someone@gmail\.com|18f51c0b4a9d7c02aa11|3f2504e0|abcdefghijklmnop/,
    );
    expect(text.length).toBeLessThanOrEqual(161);
  });
});

function emptyAxiomResults(): AxiomResults {
  return {
    totals: { rows: [] },
    errorsByRoute: { rows: [] },
    gmailRateLimited: { rows: [] },
    gmailQuotaUsage: { rows: [] },
    gmailDeferred: { rows: [] },
    slowestRoutes: { rows: [] },
    errorSamples: { rows: [] },
  };
}

function flattenKeys(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? flattenKeys(child, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function shipCueLoggerCalls() {
  const logger = new Logger({ autoFlush: false, logLevel: LogLevel.debug });
  logger.error("Request failed", {
    scope: "middleware",
    url: "/api/threads",
  });
  logger.warn("Slow request", {
    scope: "middleware",
    url: "/api/chat",
    durationMs: 9000,
  });
  logger.info("Gmail quota usage", {
    scope: "gmail-quota",
    totalUnits: 120,
    limitUnits: 15_000,
    unitsByCaller: [
      { priority: "interactive", caller: "messages/send", units: 120 },
    ],
  });
  // What Cue's logger ships for `logger.error(message, { error })` in
  // production, and for the middleware's "Unhandled error".
  const gmailError = Object.assign(new Error("Insufficient Permission"), {
    status: 403,
    code: 403,
  });
  logger.error("Error getting email filters", {
    scope: "api",
    url: "/api/user/stats/newsletters",
    error: serializeError(gmailError),
    errorMessage: gmailError.message,
  });
  logger.error("Unhandled error", {
    scope: "mail-stream",
    url: "/api/mail-stream",
    error: "REDIS_URL is not set",
    errorMessage: "REDIS_URL is not set",
    cause: "missing configuration",
    stack: new Error("REDIS_URL is not set").stack,
  });
  return logger;
}

describe("isThrottledMailResponse", () => {
  const url = "https://cue-inbox.vercel.app/api/mail/v1/threads?limit=50";
  const envelope = { error: { code: "throttled", retryAfterMs: 4000 } };

  it("treats a 503 mail error envelope carrying retryAfterMs as throttled", () => {
    expect(isThrottledMailResponse({ url, status: 503, body: envelope })).toBe(
      true,
    );
    expect(
      isThrottledMailResponse({ url, status: 503, body: { retryAfterMs: 10 } }),
    ).toBe(true);
  });

  it("keeps a 503 without the envelope as a failure", () => {
    expect(
      isThrottledMailResponse({ url, status: 503, body: "upstream down" }),
    ).toBe(false);
    expect(isThrottledMailResponse({ url, status: 503, body: null })).toBe(
      false,
    );
    expect(
      isThrottledMailResponse({
        url,
        status: 503,
        body: { error: { code: "unavailable" } },
      }),
    ).toBe(false);
  });

  it("keeps a 503 outside the mail API as a failure", () => {
    expect(
      isThrottledMailResponse({
        url: "https://cue-inbox.vercel.app/api/chat",
        status: 503,
        body: envelope,
      }),
    ).toBe(false);
  });

  it("keeps other 5xx responses as failures", () => {
    expect(isThrottledMailResponse({ url, status: 500, body: envelope })).toBe(
      false,
    );
  });
});

describe("throttled requests in the report", () => {
  it("counts throttled responses as information, not as failed requests", () => {
    const report = buildHealthReport({
      robot: {
        status: "ok",
        results: {
          status: "passed",
          baseUrl: "https://cue-inbox.vercel.app",
          startedAt: NOW.toISOString(),
          steps: [
            {
              name: "inbox shows real mail",
              status: "passed",
              durationMs: 10,
              consoleErrors: [],
              failedRequests: [],
              throttledRequests: 3,
            },
            {
              name: "open a thread",
              status: "passed",
              durationMs: 10,
              consoleErrors: [],
              failedRequests: [
                {
                  method: "GET",
                  url: "https://cue-inbox.vercel.app/api/mail/v1/threads",
                  status: 500,
                },
              ],
              throttledRequests: 1,
            },
          ],
        },
      },
      axiom: { status: "not_configured", missing: [] },
      sentry: { status: "not_configured", missing: [] },
      now: NOW,
    });

    expect(report.robot).toMatchObject({
      throttledRequests: 4,
      steps: [
        { failedRequests: [], throttledRequests: 3 },
        {
          failedRequests: [
            "500 GET https://cue-inbox.vercel.app/api/mail/v1/threads",
          ],
          throttledRequests: 1,
        },
      ],
    });
    expect(report.problems).toEqual([]);
    expect(formatHumanSummary(report)).toContain("4 throttled (not failures)");
  });
});

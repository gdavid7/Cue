import { describe, expect, it } from "vitest";
import {
  buildJourneysReport,
  DEFAULT_BUDGETS,
  evaluateAttempt,
  formatJourneysReport,
  type JourneyAttempt,
  type JourneyResults,
  JOURNEYS_REPORT_END,
  JOURNEYS_REPORT_START,
  parseJourneySelection,
  resolveBudgets,
} from "./journey-report";

const BASE_URL = "https://cue.example";
const NOW = new Date("2026-10-15T12:00:00Z");

function attempt(overrides: Partial<JourneyAttempt> = {}): JourneyAttempt {
  return {
    ok: true,
    durationMs: 1000,
    metrics: {},
    checks: [],
    ...overrides,
    diagnostics: {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      ...overrides.diagnostics,
    },
  };
}

function results(overrides: Partial<JourneyResults> = {}): JourneyResults {
  return {
    version: 1,
    mode: "production",
    baseUrl: BASE_URL,
    runTag: "r1a1",
    startedAt: "2026-10-15T11:50:00Z",
    finishedAt: "2026-10-15T11:59:00Z",
    outcome: "completed",
    selected: ["new-mail", "chat"],
    journeys: [],
    cleanup: { removed: 4 },
    ...overrides,
  };
}

describe("parseJourneySelection", () => {
  it("runs every journey for all or nothing", () => {
    expect(parseJourneySelection(undefined)).toHaveLength(6);
    expect(parseJourneySelection(" ALL ")).toHaveLength(6);
  });

  it("keeps the run order whatever order the list gives", () => {
    expect(parseJourneySelection("chat, new-mail")).toEqual([
      "new-mail",
      "chat",
    ]);
  });

  it("rejects unknown journeys instead of silently skipping them", () => {
    expect(() => parseJourneySelection("new-mail,chatt")).toThrow(/chatt/);
  });
});

describe("resolveBudgets", () => {
  it("overrides one side of a budget and keeps the rest", () => {
    const budgets = resolveBudgets('{"newMailWhileOpenMs":{"target":5000}}');
    expect(budgets.newMailWhileOpenMs).toEqual({
      target: 5000,
      limit: DEFAULT_BUDGETS.newMailWhileOpenMs.limit,
    });
    expect(budgets.archiveMs).toEqual(DEFAULT_BUDGETS.archiveMs);
  });

  it("refuses an override that is not budgets", () => {
    expect(() => resolveBudgets("{nope")).toThrow();
  });
});

describe("evaluateAttempt", () => {
  const budgets = { newMailWhileOpenMs: { target: 10_000, limit: 60_000 } };

  it("passes within target, is slow past it and fails past the limit", () => {
    const at = (ms: number) =>
      evaluateAttempt(
        attempt({ metrics: { "newMailWhileOpenMs:append": ms } }),
        budgets,
        BASE_URL,
      ).verdict;
    expect(at(9000)).toBe("PASS");
    expect(at(12_000)).toBe("SLOW");
    expect(at(180_000)).toBe("FAIL");
  });

  it("fails on a thrown error or a failed check, naming it", () => {
    const evaluated = evaluateAttempt(
      attempt({
        checks: [
          {
            name: "chat offer answer has the planted facts",
            ok: false,
            detail: "missing deadline",
          },
        ],
      }),
      budgets,
      BASE_URL,
    );
    expect(evaluated.verdict).toBe("FAIL");
    expect(evaluated.findings[0].message).toBe(
      "chat offer answer has the planted facts: missing deadline",
    );
    expect(
      evaluateAttempt(
        attempt({ ok: false, error: "timeout" }),
        budgets,
        BASE_URL,
      ).verdict,
    ).toBe("FAIL");
  });

  it("fails on our own 5xx, page errors and hydration errors but only warns on 4xx and other console errors", () => {
    const warnOnly = evaluateAttempt(
      attempt({
        diagnostics: {
          consoleErrors: ["Failed to load resource"],
          pageErrors: [],
          failedRequests: [
            { method: "GET", url: `${BASE_URL}/api/user/me`, status: 401 },
            { method: "GET", url: "https://third.party/x", status: 503 },
          ],
        },
      }),
      budgets,
      BASE_URL,
    );
    expect(warnOnly.verdict).toBe("PASS");
    expect(warnOnly.findings.map((f) => f.severity)).toEqual(["warn", "warn"]);

    for (const diagnostics of [
      {
        failedRequests: [
          { method: "POST", url: `${BASE_URL}/api/chat`, status: 500 },
        ],
      },
      { pageErrors: ["TypeError: x is undefined"] },
      {
        consoleErrors: ["Uncaught Error: Minified React error #418; visit ..."],
      },
    ]) {
      expect(
        evaluateAttempt(
          attempt({
            diagnostics: {
              consoleErrors: [],
              pageErrors: [],
              failedRequests: [],
              ...diagnostics,
            },
          }),
          budgets,
          BASE_URL,
        ).verdict,
      ).toBe("FAIL");
    }
  });
});

describe("buildJourneysReport", () => {
  const axiom = {
    status: "ok",
    errors: 3,
    warnings: 7,
    gmailRateLimitExceeded: 0,
    topErrors: [{ route: "/api/chat", message: "Tool failed", count: 3 }],
  };

  it("judges each journey, reports flakiness and lists the worst problems first", () => {
    const report = buildJourneysReport({
      results: {
        status: "ok",
        data: results({
          journeys: [
            {
              name: "new-mail",
              attempts: [
                attempt({ metrics: { "newMailWhileOpenMs:append": 185_000 } }),
              ],
            },
            {
              name: "chat",
              attempts: [
                attempt({
                  checks: [
                    {
                      name: "chat offer tools succeed",
                      ok: false,
                      detail: "searchInbox tool-output-error",
                    },
                  ],
                }),
                attempt({ metrics: { "chatTotalMs:offer": 50_000 } }),
              ],
            },
          ],
        }),
      },
      budgets: DEFAULT_BUDGETS,
      axiom,
      now: NOW,
    });
    expect(report.overall).toBe("FAIL");
    expect(report.journeys.map((j) => [j.name, j.status, j.flaky])).toEqual([
      ["new-mail", "FAIL", false],
      ["chat", "SLOW", true],
    ]);
    expect(report.flaky).toEqual(["chat"]);
    expect(report.problems).toEqual([
      "FAIL new-mail: newMailWhileOpenMs:append 185000 over limit 60000",
      "SLOW chat: chatTotalMs:offer 50000 over target 40000",
      "FLAKY chat: failed first (chat offer tools succeed: searchInbox tool-output-error), passed on retry",
      'Server logged 3 errors during the run, most often "Tool failed" on /api/chat.',
    ]);
  });

  it("does not let skipped journeys pass or fail the run", () => {
    const report = buildJourneysReport({
      results: {
        status: "ok",
        data: results({
          journeys: [
            {
              name: "new-mail",
              attempts: [attempt({ metrics: { newMailOnOpenMs: 900 } })],
            },
            {
              name: "chat",
              attempts: [],
              skipped: "not started: under 200s left in the run",
            },
          ],
        }),
      },
      budgets: DEFAULT_BUDGETS,
      axiom: { status: "not_configured", missing: ["AXIOM_QUERY_TOKEN"] },
      now: NOW,
    });
    expect(report.overall).toBe("PASS");
    expect(report.journeys[1].status).toBe("SKIPPED");
  });

  it("fails a run that could not sign in", () => {
    const report = buildJourneysReport({
      results: {
        status: "ok",
        data: results({ outcome: "sign_in_failed", note: "No code" }),
      },
      budgets: DEFAULT_BUDGETS,
      axiom,
      now: NOW,
    });
    expect(report.overall).toBe("FAIL");
    expect(report.problems[0]).toBe("Could not sign in: No code");
  });

  it("fails when the browser run left no results", () => {
    const report = buildJourneysReport({
      results: { status: "missing" },
      budgets: DEFAULT_BUDGETS,
      axiom,
      now: NOW,
    });
    expect(report.overall).toBe("FAIL");
    expect(report.outcome).toBe("no_results");
  });
});

describe("formatJourneysReport", () => {
  it("prints one line per journey with numbers against targets between markers", () => {
    const report = buildJourneysReport({
      results: {
        status: "ok",
        data: results({
          journeys: [
            {
              name: "new-mail",
              attempts: [
                attempt({
                  metrics: {
                    "newMailWhileOpenMs:smtp": 4210.6,
                    mailStreamConnected: true,
                  },
                }),
              ],
            },
          ],
        }),
      },
      budgets: DEFAULT_BUDGETS,
      axiom: {
        status: "ok",
        errors: 0,
        warnings: 2,
        gmailRateLimitExceeded: 0,
      },
      now: NOW,
    });
    const text = formatJourneysReport(report);
    expect(text.startsWith(JOURNEYS_REPORT_START)).toBe(true);
    expect(text.endsWith(JOURNEYS_REPORT_END)).toBe(true);
    expect(text).toContain(
      "- new-mail: PASS | newMailWhileOpenMs:smtp=4211/10000",
    );
    expect(text).toContain("Server logs during the run: 0 errors, 2 warnings");
    expect(text).toContain("Top problems: none");
  });
});

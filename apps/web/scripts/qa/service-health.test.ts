import { describe, expect, it } from "vitest";
import {
  buildServiceHealthQueries,
  evaluateServiceHealth,
  formatServiceHealthMarkdown,
  type ServiceHealthResults,
  worstStatus,
} from "./service-health";

const empty = { rows: [] };

describe("slow returning load", () => {
  it("fails when more than 5% of requests take over 10s", () => {
    const check = checkFor("Slow returning load", {
      requestLatency: {
        rows: [
          {
            scope: "mail/v1/enumeration",
            requests: 200,
            slowRequests: 30,
            events: 80,
          },
          {
            scope: "mail/v1/changes",
            requests: 100,
            slowRequests: 1,
            events: 40,
          },
        ],
      },
    });
    expect(check.status).toBe("FAIL");
    expect(check.lines[0]).toContain("15.0%");
    expect(check.lines[1]).toContain("within");
  });

  it("passes at the limit and ignores scopes with too few requests", () => {
    const check = checkFor("Slow returning load", {
      requestLatency: {
        rows: [
          {
            scope: "mail/v1/enumeration",
            requests: 100,
            slowRequests: 5,
            events: 50,
          },
          { scope: "mail/v1/changes", requests: 2, slowRequests: 2, events: 2 },
        ],
      },
    });
    expect(check.status).toBe("PASS");
    expect(check.lines[1]).toContain("too few");
  });

  it("warns instead of failing when the query fails", () => {
    const check = checkFor("Slow returning load", {
      requestLatency: { error: "HTTP 400" },
    });
    expect(check.status).toBe("WARN");
  });
});

describe("Gmail per-second cap", () => {
  const row = (account: string, minute: string) => ({
    account,
    minute,
    peakSecondUnits: 200,
  });

  it("fails on three consecutive pinned minutes", () => {
    const check = checkFor("Gmail per-second cap", {
      quotaPeaks: {
        rows: [
          row("acct-aaaaaaaa", "2026-10-19T10:00:00Z"),
          row("acct-aaaaaaaa", "2026-10-19T10:01:00Z"),
          row("acct-aaaaaaaa", "2026-10-19T10:02:00Z"),
        ],
      },
    });
    expect(check.status).toBe("FAIL");
    expect(check.lines[0]).toContain("longest run 3");
    expect(check.lines[0]).not.toContain("acct-aaaaaaaa");
  });

  it("passes when pinned minutes are not consecutive or are split across accounts", () => {
    const check = checkFor("Gmail per-second cap", {
      quotaPeaks: {
        rows: [
          row("a1", "2026-10-19T10:00:00Z"),
          row("a1", "2026-10-19T10:01:00Z"),
          row("a1", "2026-10-19T10:03:00Z"),
          row("a2", "2026-10-19T10:02:00Z"),
        ],
      },
    });
    expect(check.status).toBe("PASS");
  });
});

describe("stuck AI", () => {
  it("fails a scope above 10% 503s and passes one at it", () => {
    const check = checkFor("Stuck AI", {
      aiRequests: {
        rows: [
          {
            scope: "user/thread-brief",
            requests: 100,
            unavailable: 11,
            events: 30,
          },
          {
            scope: "user/thread-context",
            requests: 100,
            unavailable: 10,
            events: 30,
          },
          {
            scope: "user/inbox-insights",
            requests: 3,
            unavailable: 3,
            events: 3,
          },
        ],
      },
    });
    expect(check.status).toBe("FAIL");
    expect(check.lines.filter((l) => l.includes("over limit"))).toHaveLength(1);
  });
});

describe("retry storm", () => {
  it("fails for any account over the deferred-per-minute limit", () => {
    const check = checkFor("Gmail retry storm", {
      deferredStorms: {
        rows: [{ account: "cmvxxxxxxabc123", minutes: 4, peakPerMinute: 90 }],
      },
    });
    expect(check.status).toBe("FAIL");
    expect(check.lines[0]).toContain("peak 90");
  });

  it("passes with no rows", () => {
    expect(checkFor("Gmail retry storm", {}).status).toBe("PASS");
  });
});

describe("drafting dead", () => {
  const drafting = (row: Record<string, number>) => ({ rows: [row] });

  it("fails with inbound To Reply but no suggestions and no drafts", () => {
    const check = checkFor("Drafting dead", {
      drafting: drafting({
        toReply: 12,
        draftActions: 0,
        suggested: 0,
        outcomeLogs: 9,
      }),
    });
    expect(check.status).toBe("FAIL");
  });

  it("passes when either signal is nonzero or nothing needed a reply", () => {
    for (const row of [
      { toReply: 12, draftActions: 1, suggested: 0, outcomeLogs: 9 },
      { toReply: 12, draftActions: 0, suggested: 2, outcomeLogs: 9 },
      { toReply: 0, draftActions: 0, suggested: 0, outcomeLogs: 0 },
    ]) {
      expect(
        checkFor("Drafting dead", { drafting: drafting(row) }).status,
      ).toBe("PASS");
    }
  });

  it("only warns while the outcome log line is absent", () => {
    const check = checkFor("Drafting dead", {
      drafting: drafting({
        toReply: 5,
        draftActions: 0,
        suggested: 0,
        outcomeLogs: 0,
      }),
    });
    expect(check.status).toBe("WARN");
    expect(check.lines.join(" ")).toContain("absent");
  });
});

describe("report", () => {
  it("takes the worst status and formats a section per check", () => {
    const checks = evaluateServiceHealth(
      results({
        deferredStorms: {
          rows: [{ account: "x", minutes: 1, peakPerMinute: 60 }],
        },
      }),
    );
    expect(worstStatus(checks)).toBe("FAIL");
    expect(formatServiceHealthMarkdown(checks)).toContain(
      "### FAIL: Gmail retry storm",
    );
  });

  it("builds queries that name the dataset and the thresholds", () => {
    const queries = buildServiceHealthQueries("cue");
    expect(queries.drafting).toContain("['cue']");
    expect(queries.drafting).toContain("ago(24h)");
    expect(queries.deferredStorms).toContain("deferred > 50");
    expect(queries.quotaPeaks).toContain(">= 200");
  });
});

function results(
  overrides: Partial<ServiceHealthResults> = {},
): ServiceHealthResults {
  return {
    requestLatency: empty,
    quotaPeaks: empty,
    aiRequests: empty,
    deferredStorms: empty,
    drafting: {
      rows: [{ toReply: 0, draftActions: 0, suggested: 0, outcomeLogs: 0 }],
    },
    ...overrides,
  };
}

function checkFor(name: string, overrides: Partial<ServiceHealthResults>) {
  const check = evaluateServiceHealth(results(overrides)).find((c) =>
    c.name.startsWith(name),
  );
  if (!check) throw new Error(`no check ${name}`);
  return check;
}

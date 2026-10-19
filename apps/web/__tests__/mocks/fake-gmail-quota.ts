import { Readable } from "node:stream";
import { getAuditContext } from "@/utils/audit/context";

// An independent copy of Google's published per-method costs, so the test
// measures what Gmail would charge rather than what Cue believes it costs.
// A message, draft or thread read costs three times as much in full (the
// default) or raw as in metadata or minimal format.
// https://developers.google.com/workspace/gmail/api/reference/quota
const GMAIL_COSTS: Array<[method: string, pattern: RegExp, units: number]> = [
  ["GET", /^\/profile$/, 1],
  ["GET", /^\/history$/, 2],
  ["GET", /^\/labels$/, 1],
  ["GET", /^\/labels\/[^/]+$/, 1],
  ["GET", /^\/settings\/.+$/, 1],
  ["GET", /^\/messages$/, 5],
  ["GET", /^\/messages\/[^/]+$/, 60],
  ["GET", /^\/messages\/[^/]+\/attachments\/[^/]+$/, 20],
  ["GET", /^\/threads$/, 10],
  ["GET", /^\/threads\/[^/]+$/, 120],
  ["GET", /^\/drafts$/, 5],
  ["GET", /^\/drafts\/[^/]+$/, 60],
  ["POST", /^\/messages\/send$/, 100],
  ["POST", /^\/messages\/batchModify$/, 50],
  ["POST", /^\/messages\/[^/]+\/modify$/, 5],
  ["POST", /^\/threads\/[^/]+\/modify$/, 10],
];

const RATE_LIMIT_BODY = {
  error: {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.",
    errors: [
      {
        message:
          "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'.",
        domain: "usageLimits",
        reason: "rateLimitExceeded",
      },
    ],
    status: "PERMISSION_DENIED",
  },
};

export type FakeGmailCall = {
  at: number;
  caller: string;
  units: number;
  requested: number;
  limited: boolean;
};

/**
 * A Gmail double that charges each request its documented cost and, like
 * Gmail, refuses requests once a rolling minute of accepted cost would pass
 * `unitsPerMinute`. Recent mail is `recentCount` messages; older mail is
 * `historyCount` more. With `unitsPerSecond`, it also refuses what would push
 * the last second past that many units, for a test that bounds bursts.
 */
export function createFakeGmail({
  unitsPerMinute = 6000,
  latencyMs = 250,
  recentCount = 150,
  historyCount = 4000,
  unitsPerSecond = Number.POSITIVE_INFINITY,
}: {
  unitsPerMinute?: number;
  unitsPerSecond?: number;
  latencyMs?: number;
  recentCount?: number;
  historyCount?: number;
} = {}) {
  const calls: FakeGmailCall[] = [];

  function charge(units: number) {
    const now = Date.now();
    const spentSince = (ms: number) =>
      calls
        .filter((call) => !call.limited && call.at > now - ms)
        .reduce((sum, call) => sum + call.units, 0);
    const limited =
      spentSince(60_000) + units > unitsPerMinute ||
      spentSince(1000) + units > unitsPerSecond;
    calls.push({
      at: now,
      caller: getAuditContext().source ?? "unattributed",
      units: limited ? 0 : units,
      requested: units,
      limited,
    });
    return !limited;
  }

  function costOf(method: string, url: URL) {
    const path = stripUser(url.pathname);
    const match = GMAIL_COSTS.find(
      ([m, pattern]) => m === method && pattern.test(path),
    );
    if (!match) throw new Error(`Unpriced fake Gmail call ${method} ${path}`);
    const format = url.searchParams.get("format");
    const light =
      method === "GET" &&
      /^\/(messages|drafts|threads)\/[^/]+$/.test(path) &&
      (format === "metadata" || format === "minimal");
    return light ? match[2] / 3 : match[2];
  }

  function handle(url: URL): unknown {
    const path = url.pathname.replace(/^.*\/gmail\/v1\/users\/[^/]+/, "");
    const q = url.searchParams.get("q") ?? "";
    const max = Number(url.searchParams.get("maxResults") || 100);
    const pageToken = Number(url.searchParams.get("pageToken") || 0);
    if (path === "/profile")
      return {
        emailAddress: "me@example.com",
        historyId: "9000",
        messagesTotal: recentCount + historyCount,
      };
    if (path === "/history") return { history: [], historyId: "9000" };
    if (path === "/labels")
      return {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_1", name: "Work", type: "user" },
          ...["Newsletter", "Marketing", "Receipt", "Notification"].map(
            (name, i) => ({ id: `Label_${i + 2}`, name, type: "user" }),
          ),
        ],
      };
    if (path.startsWith("/labels/"))
      return { id: "INBOX", name: "INBOX", messagesTotal: recentCount };
    if (path === "/settings/filters") return { filter: [] };
    if (path === "/settings/sendAs")
      return { sendAs: [{ sendAsEmail: "me@example.com", isPrimary: true }] };
    if (path === "/messages" || path === "/threads") {
      // Filed mail under a user label is its own set of conversations.
      const label = Number(
        url.searchParams.get("labelIds")?.match(/^Label_(\d+)$/)?.[1] ?? 0,
      );
      const [start, end] = label
        ? [100_000 * label, 100_000 * label + 20]
        : q.includes("before:")
          ? [recentCount, recentCount + historyCount]
          : q.includes("from:") || q.includes(" OR ")
            ? [0, 12]
            : [0, recentCount];
      const from = start + pageToken;
      const to = Math.min(end, from + max);
      const ids = Array.from({ length: to - from }, (_, i) => from + i);
      const next = to < end ? String(to - start) : undefined;
      return path === "/messages"
        ? {
            messages: ids.map((i) => ({ id: `m${i}`, threadId: `t${i}` })),
            nextPageToken: next,
            resultSizeEstimate: end - start,
          }
        : {
            threads: ids.map((i) => ({ id: `t${i}`, historyId: "9000" })),
            nextPageToken: next,
          };
    }
    if (path.startsWith("/messages/"))
      return message(Number(path.split("/")[2]?.slice(1)));
    if (path.startsWith("/threads/")) {
      const t = Number(path.split("/")[2]?.slice(1));
      return {
        id: `t${t}`,
        historyId: "9000",
        snippet: "Quarterly planning budget review",
        messages: [0, 1, 2].map((n) => ({
          ...message(t * 3 + n),
          threadId: `t${t}`,
        })),
      };
    }
    return {};
  }

  async function fetchImpl(input: unknown, init?: RequestInit) {
    const url = new URL(
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : String((input as Request).url),
    );
    const method = (init?.method ?? "GET").toUpperCase();
    await new Promise((resolve) => setTimeout(resolve, latencyMs));

    if (url.pathname.startsWith("/batch/")) {
      const body = String(init?.body ?? "");
      const parts = [...body.matchAll(/^GET (\S+)$/gm)].map((match) => {
        const itemUrl = new URL(match[1]!, "https://gmail.googleapis.com");
        const allowed = charge(costOf("GET", itemUrl));
        const status = allowed ? "200 OK" : "403 Forbidden";
        const json = allowed ? handle(itemUrl) : RATE_LIMIT_BODY;
        return `--batch_fake\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n`;
      });
      return new Response(`${parts.join("")}--batch_fake--`, {
        status: 200,
        headers: { "content-type": "multipart/mixed; boundary=batch_fake" },
      });
    }

    const allowed = charge(costOf(method, url));
    if (!allowed)
      return new Response(JSON.stringify(RATE_LIMIT_BODY), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const json = JSON.stringify(handle(url));
    const response = new Response(json, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    // Gaxios streams through node-fetch, whose bodies are Node streams.
    if (
      (init as { responseType?: string } | undefined)?.responseType === "stream"
    )
      Object.defineProperty(response, "body", {
        value: Readable.from([Buffer.from(json)]),
      });
    return response;
  }

  return {
    fetch: fetchImpl,
    calls,
    /** Accepted units per caller within [fromMs, toMs). */
    unitsByCaller(fromMs: number, toMs: number) {
      const totals: Record<string, number> = {};
      for (const call of calls) {
        if (call.at < fromMs || call.at >= toMs) continue;
        totals[call.caller] = (totals[call.caller] ?? 0) + call.units;
      }
      return totals;
    },
    /** Units each caller asked for within [fromMs, toMs), refused or not. */
    demandByCaller(fromMs: number, toMs: number) {
      const totals: Record<string, number> = {};
      for (const call of calls) {
        if (call.at < fromMs || call.at >= toMs) continue;
        totals[call.caller] = (totals[call.caller] ?? 0) + call.requested;
      }
      return totals;
    },
    /** The most accepted units in any rolling 60-second window. */
    peakMinuteUnits() {
      let peak = 0;
      for (const start of calls) {
        const total = calls
          .filter((c) => c.at >= start.at && c.at < start.at + 60_000)
          .reduce((sum, c) => sum + c.units, 0);
        peak = Math.max(peak, total);
      }
      return peak;
    },
    /** The most accepted units in any rolling one-second window. */
    peakSecondUnits() {
      let peak = 0;
      for (const start of calls) {
        const total = calls
          .filter((c) => c.at >= start.at && c.at < start.at + 1000)
          .reduce((sum, c) => sum + c.units, 0);
        peak = Math.max(peak, total);
      }
      return peak;
    },
    limitedCalls() {
      return calls.filter((call) => call.limited);
    },
  };
}

function stripUser(pathname: string) {
  return pathname.replace(/^.*\/gmail\/v1\/users\/[^/]+/, "");
}

function message(i: number) {
  const person = `person${i % 5}@example.com`;
  return {
    id: `m${i}`,
    threadId: `t${Math.floor(i / 3)}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Quarterly planning budget review",
    historyId: String(5000 + i),
    internalDate: String(Date.now() - i * 600_000),
    sizeEstimate: 2000,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Person ${i % 5} <${person}>` },
        { name: "To", value: "me@example.com, colleague@example.org" },
        { name: "Cc", value: "partner@example.net" },
        { name: "Subject", value: "Quarterly planning budget review" },
        { name: "Date", value: new Date(Date.now()).toUTCString() },
        { name: "Message-ID", value: `<m${i}@example.com>` },
      ],
      body: {
        size: 60,
        data: Buffer.from(
          "Can we review the quarterly planning budget numbers on Thursday?",
        ).toString("base64url"),
      },
    },
  };
}

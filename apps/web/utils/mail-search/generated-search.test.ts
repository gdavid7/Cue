import { describe, expect, it } from "vitest";
import {
  buildGeneratedSearch,
  resolveDateRange,
  type SearchIntentParts,
} from "@/utils/mail-search/generated-search";
import {
  parseSearchQuery,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";

const NONE: SearchIntentParts = {
  senders: [],
  recipients: [],
  sentByUser: false,
  keywordGroups: [],
  hasAttachment: false,
  unread: false,
  starred: false,
  label: "",
  dateRange: "none",
  lastNDays: 0,
  fromDate: "",
  toDate: "",
  explanation: "",
  isQuestion: false,
};
// Monday, 09:00 in Los Angeles.
const NOW = new Date("2026-10-19T16:00:00Z");
const GMAIL = {
  now: NOW,
  timeZone: "America/Los_Angeles",
  provider: "google" as "google" | "microsoft",
  labelNames: ["Receipts", "Work/Clients"],
};
const OUTLOOK = { ...GMAIL, provider: "microsoft" as const };

const epoch = (iso: string) => String(Date.parse(iso) / 1000);

function build(parts: Partial<SearchIntentParts>, context = GMAIL) {
  return buildGeneratedSearch({ ...NONE, ...parts }, context);
}

describe("buildGeneratedSearch", () => {
  it("groups each thing's alternatives so every group must match", () => {
    const search = build({
      senders: ["Sarah"],
      keywordGroups: [
        ["lease", "rental agreement"],
        ["signed", "executed"],
      ],
      hasAttachment: true,
    });
    expect(search).toBe(
      'from:Sarah (lease OR "rental agreement") (signed OR executed) has:attachment',
    );
    // The local search reads it the same way.
    expect(shape(parseSearchQuery(search ?? ""))).toEqual([
      "and",
      "from:Sarah",
      ["or", "lease", '"rental agreement"'],
      ["or", "signed", "executed"],
      "has:attachment",
    ]);
  });

  it("lets any of several senders match", () => {
    expect(
      build({ senders: ["sarah", "Ana Lima"], keywordGroups: [["lease"]] }),
    ).toBe('from:sarah OR from:"Ana Lima" lease');
  });

  it("writes Outlook's syntax for an Outlook account", () => {
    expect(
      build(
        {
          senders: ["sarah"],
          hasAttachment: true,
          starred: true,
          unread: true,
          label: "receipts",
          keywordGroups: [["lease"]],
        },
        OUTLOOK,
      ),
    ).toBe("from:sarah lease hasattachments:true is:flagged category:Receipts");
  });

  it("uses a label only when the account has it, under its real name", () => {
    expect(build({ label: "work clients", keywordGroups: [["acme"]] })).toBe(
      "acme label:Work/Clients",
    );
    expect(build({ label: "invented", keywordGroups: [["acme"]] })).toBe(
      "acme",
    );
  });

  it("keeps words from reading as search syntax", () => {
    expect(
      build({ keywordGroups: [["(lease)", "OR", "-draft", "re:offer"]] }),
    ).toBe('lease OR draft OR "re:offer"');
  });

  it("searches mail the user sent", () => {
    expect(build({ sentByUser: true, recipients: ["tom"] })).toBe(
      "to:tom in:sent",
    );
  });

  it("finds a day's mail with nothing else to go on", () => {
    expect(build({ dateRange: "yesterday" })).toBe(
      `after:${epoch("2026-10-18T07:00:00Z")} before:${epoch("2026-10-19T07:00:00Z")}`,
    );
  });

  it("returns null when there's nothing to search for", () => {
    expect(build({})).toBeNull();
    expect(build({ keywordGroups: [[" ", ""]], label: "invented" })).toBeNull();
  });

  it("starts a Gmail day at midnight in the account's time zone, as epoch seconds", () => {
    // 08:30 on Tuesday in Tokyo, still Monday in UTC.
    const tokyo = {
      ...GMAIL,
      now: new Date("2026-10-19T23:30:00Z"),
      timeZone: "Asia/Tokyo",
    };
    expect(build({ senders: ["sarah"], dateRange: "today" }, tokyo)).toBe(
      `from:sarah after:${epoch("2026-10-19T15:00:00Z")}`,
    );
    expect(
      build(
        { senders: ["sarah"], dateRange: "today" },
        {
          ...tokyo,
          provider: "microsoft",
        },
      ),
    ).toBe("from:sarah received>=2026-10-20");
  });
});

describe("resolveDateRange", () => {
  const range = (
    parts: Partial<SearchIntentParts>,
    { now = NOW, timeZone = "America/Los_Angeles" } = {},
  ) => {
    const resolved = resolveDateRange({ ...NONE, ...parts }, { now, timeZone });
    return (
      resolved && {
        start: resolved.startMs && new Date(resolved.startMs).toISOString(),
        end: resolved.endMs && new Date(resolved.endMs).toISOString(),
      }
    );
  };

  it("reads last week as Monday to Monday in the account's time zone", () => {
    expect(range({ dateRange: "last_week" })).toEqual({
      start: "2026-10-12T07:00:00.000Z",
      end: "2026-10-19T07:00:00.000Z",
    });
    // Berlin is on summer time until October 25.
    expect(
      range({ dateRange: "last_week" }, { timeZone: "Europe/Berlin" }),
    ).toEqual({
      start: "2026-10-11T22:00:00.000Z",
      end: "2026-10-18T22:00:00.000Z",
    });
  });

  it("starts this week on Monday", () => {
    expect(range({ dateRange: "this_week" })).toEqual({
      start: "2026-10-19T07:00:00.000Z",
      end: null,
    });
  });

  it("reads calendar months and years whole", () => {
    expect(range({ dateRange: "last_month" })).toEqual({
      start: "2026-09-01T07:00:00.000Z",
      end: "2026-10-01T07:00:00.000Z",
    });
    expect(
      range({ dateRange: "this_year" }, { timeZone: "Europe/London" }),
    ).toEqual({ start: "2026-01-01T00:00:00.000Z", end: null });
  });

  it("counts the last n days back from now, not from a midnight", () => {
    expect(range({ dateRange: "last_n_days", lastNDays: 1 })).toEqual({
      start: "2026-10-18T16:00:00.000Z",
      end: null,
    });
    expect(range({ dateRange: "last_n_days", lastNDays: 0 })).toBeNull();
  });

  it("includes the last day of a named range", () => {
    expect(
      range(
        { dateRange: "between", fromDate: "2026-09-01", toDate: "2026-09-30" },
        { timeZone: "Asia/Tokyo" },
      ),
    ).toEqual({
      start: "2026-08-31T15:00:00.000Z",
      end: "2026-09-30T15:00:00.000Z",
    });
  });

  it("drops a range that holds no past mail, or isn't a real day", () => {
    expect(
      range({ dateRange: "between", fromDate: "2027-01-01", toDate: "" }),
    ).toBeNull();
    expect(
      range({
        dateRange: "between",
        fromDate: "2026-09-10",
        toDate: "2026-09-01",
      }),
    ).toBeNull();
    expect(
      range({ dateRange: "between", fromDate: "2026-02-30", toDate: "" }),
    ).toBeNull();
    expect(range({ dateRange: "none" })).toBeNull();
  });
});

function shape(node: SearchNode): unknown {
  switch (node.kind) {
    case "and":
    case "or":
      return [node.kind, ...node.children.map(shape)];
    case "text":
      return node.exact ? `"${node.value}"` : node.value;
    case "operator":
      return `${node.name}${node.comparator}${node.value}`;
    default:
      return node.kind;
  }
}

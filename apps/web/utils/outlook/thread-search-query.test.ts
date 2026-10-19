import { describe, expect, it } from "vitest";
import {
  compileOutlookThreadSearch,
  isEmptyOutlookSearch,
} from "@/utils/outlook/thread-search-query";
import {
  buildGeneratedSearch,
  type SearchIntentParts,
} from "@/utils/mail-search/generated-search";

describe("compileOutlookThreadSearch", () => {
  it.each([
    ["keywords", "quarterly invoice", '"quarterly invoice"'],
    ["from", "from:billing@example.com", '"from:billing@example.com"'],
    ["to", "to:team@example.com", '"to:team@example.com"'],
    ["subject", "subject:test", '"subject:test"'],
    [
      "multi-word subject",
      'subject:"weekly report"',
      '"subject:\\"weekly report\\""',
    ],
    ["doesn't have", "NOT newsletter", '"size>=0 NOT newsletter"'],
    ["size greater than", "size>5MB", '"size>5242880"'],
    ["size less than", "size<10KB", '"size<10240"'],
    ["attachments", "hasattachments:true", '"hasattachments:true"'],
    [
      "received window",
      "received>=2026-09-01 received<2026-09-03",
      '"received>=2026-09-01 received<2026-09-03"',
    ],
  ])("compiles a %s query into Graph KQL", (_name, query, expected) => {
    expect(compileOutlookThreadSearch(query).search).toBe(expected);
  });

  it("combines several Outlook fields and keeps folder/flag out of KQL", () => {
    expect(
      compileOutlookThreadSearch(
        'from:alice@example.com subject:"Q3 plan" budget NOT draft size>1MB in:inbox is:flagged',
      ),
    ).toEqual({
      search:
        '"from:alice@example.com subject:\\"Q3 plan\\" budget size>1048576 NOT draft"',
      folderKey: "inbox",
      folderName: undefined,
      flagged: true,
      category: undefined,
    });
  });

  it("scopes junk, deleted, and custom folders instead of dropping them", () => {
    expect(compileOutlookThreadSearch("invoice in:junk")).toEqual({
      search: '"invoice"',
      folderKey: "junkemail",
      folderName: undefined,
      flagged: false,
      category: undefined,
    });
    expect(compileOutlookThreadSearch("invoice in:spam")).toMatchObject({
      search: '"invoice"',
      folderKey: "junkemail",
    });
    expect(compileOutlookThreadSearch("invoice in:trash")).toMatchObject({
      search: '"invoice"',
      folderKey: "deleteditems",
    });
    expect(compileOutlookThreadSearch('invoice folder:"Projects"')).toEqual({
      search: '"invoice"',
      folderKey: undefined,
      folderName: "Projects",
      flagged: false,
      category: undefined,
    });
  });

  it("keeps a quoted operator-like phrase as literal text", () => {
    expect(compileOutlookThreadSearch('"from:alice@example.com"').search).toBe(
      '"\\"from:alice@example.com\\""',
    );
  });

  it.each([
    ["an impossible day", "received>=2026-02-30"],
    ["an impossible month", "received<2026-13-01"],
    ["an oversized number", `size>${"9".repeat(400)}`],
  ])("drops a restriction with %s", (_name, query) => {
    expect(compileOutlookThreadSearch(`invoice ${query}`).search).toBe(
      '"invoice"',
    );
  });

  it("returns an empty compiled search when nothing searchable remains", () => {
    expect(isEmptyOutlookSearch(compileOutlookThreadSearch("   "))).toBe(true);
    expect(compileOutlookThreadSearch("in:inbox")).toEqual({
      search: "",
      folderKey: "inbox",
      folderName: undefined,
      flagged: false,
      category: undefined,
    });
  });
});

describe("compileOutlookThreadSearch with brackets", () => {
  it("sends brackets outside quotes to KQL as grouping, not inside a phrase", () => {
    expect(
      compileOutlookThreadSearch('(lease OR "rental agreement") signed').search,
    ).toBe('"( lease OR \\"rental agreement\\" ) signed"');
  });

  it("keeps a bracket inside a phrase as part of the phrase", () => {
    expect(compileOutlookThreadSearch('"plan (draft)"').search).toBe(
      '"\\"plan (draft)\\""',
    );
  });

  it("reads an operator after a bracket as an operator", () => {
    expect(
      compileOutlookThreadSearch('(from:sarah OR from:"Ana Lima") lease')
        .search,
    ).toBe('"( from:sarah OR from:\\"Ana Lima\\" ) lease"');
  });

  it("drops brackets that don't pair up, and groups left empty", () => {
    expect(compileOutlookThreadSearch("(lease contract").search).toBe(
      '"lease contract"',
    );
    expect(compileOutlookThreadSearch("(in:inbox) lease").search).toBe(
      '"lease"',
    );
  });
});

describe("Cue's generated Outlook searches", () => {
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
  const compile = (parts: Partial<SearchIntentParts>) =>
    compileOutlookThreadSearch(
      buildGeneratedSearch(
        { ...NONE, ...parts },
        {
          now: new Date("2026-10-19T16:00:00Z"),
          timeZone: "America/Los_Angeles",
          provider: "microsoft",
          labelNames: ["Work/Clients"],
        },
      ) ?? "",
    );

  it("keeps a phrase whole inside its group", () => {
    expect(
      compile({ keywordGroups: [["lease", "rental agreement"], ["signed"]] })
        .search,
    ).toBe('"( lease OR \\"rental agreement\\" ) signed"');
  });

  it("brackets several senders apart from a keyword group", () => {
    expect(
      compile({
        senders: ["sarah", "Priya Shah"],
        keywordGroups: [["lease", "rental agreement"]],
        hasAttachment: true,
        dateRange: "between",
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      }).search,
    ).toBe(
      '"( from:sarah OR from:\\"Priya Shah\\" ) ( lease OR \\"rental agreement\\" ) hasattachments:true received>=2026-09-01 received<2026-10-01"',
    );
  });

  it("puts a label and a flag in the scopes Graph applies beside KQL", () => {
    expect(
      compile({
        senders: ["sarah"],
        starred: true,
        label: "work clients",
      }),
    ).toMatchObject({
      search: '"from:sarah"',
      flagged: true,
      category: "Work/Clients",
    });
  });
});

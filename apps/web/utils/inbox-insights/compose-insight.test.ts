import { describe, expect, it } from "vitest";
import { composeInsight, formatWhen } from "./compose-insight";

const USER = "david@example.com";
// Tuesday, local time, so weekday names don't depend on the machine's zone.
const NOW = new Date(2026, 9, 13, 9, 0);
const LABELS: Record<string, string> = {
  "Label_To Reply": "To Reply",
  "Label_Awaiting Reply": "Awaiting Reply",
};

describe("composeInsight", () => {
  it("says nothing about an email that asks nothing", () => {
    expect(
      compose({
        from: "News <n@x.com>",
        data: { insight: none(), meeting: null, reply: null },
      }),
    ).toBeNull();
  });

  it("leads with what the email asks and when it's due", () => {
    expect(
      compose({
        from: "Jessica <j@nvidia.com>",
        labels: ["Label_To Reply"],
        data: {
          insight: {
            ...none(),
            action: "reply",
            task: "Share availability for 2 interviews",
            date: "2026-10-15",
            dateRole: "deadline",
          },
          meeting: null,
          reply: null,
        },
      }),
    ).toEqual({
      tone: "action",
      parts: ["Share availability for 2 interviews", "due Thu"],
    });
  });

  it("falls back to the reply label when there's no AI insight", () => {
    expect(
      compose({ from: "Mom <mom@x.org>", labels: ["Label_To Reply"] }),
    ).toEqual({ tone: "action", parts: ["Needs reply"] });
  });

  it("shows who you're waiting on when you wrote last", () => {
    expect(
      compose({
        from: USER,
        to: "Alex Kim <alex@ctc.com>",
        labels: ["Label_Awaiting Reply"],
        sentAt: new Date(2026, 9, 10, 9, 0),
      }),
    ).toEqual({ tone: "pending", parts: ["Waiting on Alex Kim · 3d"] });
  });

  it("keeps an offer's end date and a detail worth keeping", () => {
    expect(
      compose({
        from: "United <receipts@united.com>",
        data: {
          insight: {
            ...none(),
            date: "2026-10-18",
            dateRole: "expires",
            fact: "PX7Q2M",
            factLabel: "Confirmation",
          },
          meeting: null,
          reply: null,
        },
      }),
    ).toEqual({ tone: "info", parts: ["Ends Sun", "Confirmation PX7Q2M"] });
  });

  it("leads with a ready reply, then the meeting with the sender", () => {
    expect(
      compose({
        from: "Sarah Chen <sarah@acme.com>",
        data: {
          insight: none(),
          meeting: {
            title: "Acme renewal",
            at: new Date(2026, 9, 16, 10, 0).toISOString(),
            with: "Sarah Chen",
          },
          reply: "ready",
        },
      }),
    ).toEqual({
      tone: "ready",
      parts: ["Draft ready", "Meeting with Sarah Fri 10 AM"],
    });
  });

  it("says Cue drafted a reply in place of Needs reply", () => {
    expect(
      compose({
        from: "Sarah Chen <sarah@acme.com>",
        labels: ["Label_To Reply"],
        data: { insight: null, meeting: null, reply: "drafted" },
      }),
    ).toEqual({ tone: "ready", parts: ["Cue drafted a reply"] });
  });

  it("says a reply is blocked on missing information, ahead of the task", () => {
    expect(
      compose({
        from: "Sarah Chen <sarah@acme.com>",
        labels: ["Label_To Reply"],
        data: {
          insight: {
            ...none(),
            action: "reply",
            task: "Send the updated pricing",
          },
          meeting: null,
          reply: "needs-info",
        },
      }),
    ).toEqual({
      tone: "pending",
      parts: ["Needs info to reply", "Send the updated pricing"],
    });
  });
});

describe("composeInsight with a draft", () => {
  // The user's unsent draft is newest, but the sender is still waiting.
  it("reads the latest received message, not the user's draft", () => {
    expect(
      composeInsight({
        thread: {
          messages: [
            {
              labelIds: ["INBOX", "Label_To Reply"],
              internalDate: String(NOW.getTime()),
              headers: { from: "Mom <mom@x.org>", to: USER },
            },
            {
              labelIds: ["DRAFT"],
              internalDate: String(NOW.getTime() + 60_000),
              headers: { from: USER, to: "Mom <mom@x.org>" },
            },
          ],
        },
        labelNames: (id) => LABELS[id],
        userEmail: USER,
        data: undefined,
        now: NOW,
      }),
    ).toEqual({ tone: "action", parts: ["Needs reply"] });
  });
});

describe("formatWhen", () => {
  it("reads a bare date as that day where the user is", () => {
    expect(formatWhen("2026-10-13", NOW)).toBe("today");
    expect(formatWhen("2026-10-14", NOW)).toBe("tomorrow");
    expect(formatWhen("2026-11-25", NOW)).toBe("Nov 25");
  });
});

function compose({
  from,
  to = USER,
  labels = [],
  sentAt = NOW,
  data,
}: {
  from: string;
  to?: string;
  labels?: string[];
  sentAt?: Date;
  data?: Parameters<typeof composeInsight>[0]["data"];
}) {
  return composeInsight({
    thread: {
      messages: [
        {
          labelIds: ["INBOX", ...labels],
          internalDate: String(sentAt.getTime()),
          headers: { from, to },
        },
      ],
    },
    labelNames: (id) => LABELS[id],
    userEmail: USER,
    data,
    now: NOW,
  });
}

function none() {
  return {
    action: "none" as const,
    task: "",
    date: null,
    dateRole: null,
    fact: null,
    factLabel: null,
  };
}

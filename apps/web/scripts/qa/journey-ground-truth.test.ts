import { describe, expect, it } from "vitest";
import {
  buildGroundTruth,
  type Fact,
  JOURNEY_SUBJECT_MARKER,
  matchFacts,
  parseUiMessageStream,
} from "./journey-ground-truth";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("buildGroundTruth", () => {
  it("plants the same facts for a run tag and different ones for another", () => {
    const first = buildGroundTruth({ runTag: "r1a1", now: NOW });
    expect(buildGroundTruth({ runTag: "r1a1", now: NOW })).toEqual(first);
    expect(buildGroundTruth({ runTag: "r2a1", now: NOW }).emails).not.toEqual(
      first.emails,
    );
  });

  it("marks every planted subject with the cleanup words and sends only from example.com", () => {
    const truth = buildGroundTruth({ runTag: "r9a2", now: NOW });
    for (const email of truth.emails) {
      expect(email.subject).toContain(`${JOURNEY_SUBJECT_MARKER} r9a2`);
      expect(email.from.address).toMatch(/@example\.com$/);
    }
  });

  it("states every required fact of every question in the planted mail", () => {
    for (const runTag of ["r1a1", "r77a1", "l1abc", "r123456789a3"]) {
      const truth = buildGroundTruth({ runTag, now: NOW });
      const mail = truth.emails
        .map((e) => `${e.subject}\n${e.text}`)
        .join("\n");
      for (const question of truth.questions) {
        expect(matchFacts(mail, question.facts).missing, runTag).toEqual([]);
      }
    }
  });

  it("gives search and triage targets that are planted", () => {
    const truth = buildGroundTruth({ runTag: "r5a1", now: NOW });
    expect(truth.searchSubject).toContain(truth.searchTerm);
    const meeting = truth.emails.find((e) => e.subject === truth.triageSubject);
    expect(meeting?.text).toContain(truth.triageBodyText);
  });
});

describe("matchFacts", () => {
  const facts: Fact[] = [
    { key: "amount", required: true, anyOf: ["2384.17"] },
    {
      key: "due",
      required: true,
      anyOf: ["november 7", "nov 7", "7 november", "11/7", "2026-11-07"],
    },
    { key: "time", required: true, anyOf: ["3:40 pm", "15:40"] },
    { key: "room", required: true, anyOf: ["b4-317", "b4 317", "b4317"] },
    { key: "weekday", required: false, anyOf: ["friday"] },
  ];

  it("accepts the facts however the answer formats them", () => {
    const answer =
      "You owe **$2,384.17**, due Nov. 7th. The meeting is at 3:40pm in room B4–317.";
    expect(matchFacts(answer, facts)).toEqual({
      matched: ["amount", "due", "time", "room"],
      missing: [],
      missingOptional: ["weekday"],
    });
  });

  it("accepts 24-hour times, day-first dates and numeric dates", () => {
    expect(
      matchFacts("2384.17 on 7 November at 15:40, B4 317", facts).missing,
    ).toEqual([]);
    expect(
      matchFacts("2384.17 by 11/7, 3:40 P.M., B4-317", facts).missing,
    ).toEqual([]);
  });

  it("reports wrong or absent facts as missing", () => {
    const result = matchFacts(
      "You owe $2,384.71, due November 17 at 3:45 PM in room B4-318.",
      facts,
    );
    expect(result.missing).toEqual(["amount", "due", "time", "room"]);
  });

  it("does not match a fact inside a longer number", () => {
    expect(matchFacts("Due 11/17 or 12384.17", facts).matched).toEqual([]);
  });
});

describe("parseUiMessageStream", () => {
  const sse = (...chunks: object[]) =>
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

  it("joins the answer text and lists the tools that ran", () => {
    const parsed = parseUiMessageStream(
      `${sse(
        { type: "start" },
        { type: "tool-input-start", toolCallId: "a", toolName: "searchInbox" },
        {
          type: "tool-input-available",
          toolCallId: "a",
          toolName: "searchInbox",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "a",
          output: { messages: [] },
        },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "The invoice is " },
        { type: "text-delta", id: "t", delta: "$2,384.17." },
        { type: "finish" },
      )}data: [DONE]\n\n`,
    );
    expect(parsed).toEqual({
      text: "The invoice is $2,384.17.",
      toolCalls: ["searchInbox"],
      toolErrors: [],
      streamErrors: 0,
      finished: true,
      unparsable: 0,
    });
  });

  it("counts thrown tool errors, tools that returned an error, and stream errors", () => {
    const parsed = parseUiMessageStream(
      sse(
        {
          type: "tool-input-available",
          toolCallId: "a",
          toolName: "searchInbox",
          input: {},
        },
        { type: "tool-output-error", toolCallId: "a", errorText: "boom" },
        {
          type: "tool-input-available",
          toolCallId: "b",
          toolName: "readEmail",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "b",
          output: { error: "not found" },
        },
        {
          type: "tool-input-error",
          toolCallId: "c",
          toolName: "manageInbox",
          input: {},
          errorText: "bad",
        },
        { type: "error", errorText: "provider overloaded" },
      ),
    );
    expect(parsed.toolErrors).toEqual([
      { tool: "searchInbox", kind: "tool-output-error" },
      { tool: "readEmail", kind: "tool-returned-error" },
      { tool: "manageInbox", kind: "tool-input-error" },
    ]);
    expect(parsed.streamErrors).toBe(1);
    expect(parsed.finished).toBe(false);
  });

  it("skips lines that are not data and counts broken chunks", () => {
    const parsed = parseUiMessageStream(
      `: keep-alive\nevent: x\ndata: {not json\n\n${sse({ type: "text-delta", id: "t", delta: "ok" })}`,
    );
    expect(parsed.text).toBe("ok");
    expect(parsed.unparsable).toBe(1);
  });
});

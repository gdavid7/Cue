import { describe, expect, it } from "vitest";
import { buildEmulateSeed } from "@/scripts/emulate-seed";
import {
  buildCueDemoCalendarEvents,
  buildCueDemoInbox,
  buildCueDemoInsights,
  cueDemoReplySuggestions,
  cueDemoThreadBriefs,
} from "./cue-demo-inbox";

const NOW = new Date("2026-10-13T16:00:00Z"); // a Tuesday

describe("Cue demo inbox", () => {
  const inbox = buildCueDemoInbox(NOW);
  const messages = inbox.threads.flatMap((t) => t.messages);

  it("has mail in every Home lane", () => {
    const withLabel = (label: string) =>
      inbox.threads.filter((t) =>
        t.messages.some((m) => m.labels?.includes(label)),
      );
    expect(withLabel("To Reply").length).toBeGreaterThan(0);
    expect(withLabel("Awaiting Reply").length).toBeGreaterThan(0);
    expect(
      withLabel("Newsletter").length + withLabel("Receipt").length,
    ).toBeGreaterThan(0);
  });

  it("only uses labels it defines", () => {
    const defined = new Set(inbox.labels.map((l) => l.name));
    for (const m of messages)
      for (const label of m.labels ?? []) expect(defined).toContain(label);
  });

  it("keeps every message in the past, so it syncs", () => {
    for (const m of messages)
      expect(Date.parse(m.date)).toBeLessThan(NOW.getTime());
  });

  it("has a scripted brief only for subjects that exist", () => {
    const subjects = new Set(messages.map((m) => m.subject));
    for (const brief of cueDemoThreadBriefs)
      expect(subjects).toContain(brief.subject);
  });

  it("quotes only words the demo mail actually contains", () => {
    const subjects = new Set(messages.map((m) => m.subject));
    const bodies = messages.map((m) => m.bodyText ?? "");
    for (const { subject, object } of cueDemoReplySuggestions) {
      expect(subjects).toContain(subject);
      for (const claim of object.claims)
        expect(bodies.some((b) => b.includes(claim.quote))).toBe(true);
    }
  });

  it("notes only facts the demo mail contains, under subjects that exist", () => {
    const subjects = new Set(messages.map((m) => m.subject));
    const bodies = messages.map((m) => m.bodyText ?? "");
    for (const { subject, object } of buildCueDemoInsights(NOW)) {
      expect(subjects).toContain(subject);
      if (object.fact)
        expect(bodies.some((b) => b.includes(object.fact))).toBe(true);
    }
  });

  it("puts the renewal meeting on the coming Friday at 10am Pacific", () => {
    const renewal = buildCueDemoCalendarEvents("me@example.com", NOW).find(
      (e) => e.id === "cue_evt_acme_renewal",
    );
    expect(renewal?.start_date_time).toBe("2026-10-16T17:00:00.000Z");
  });
});

describe("buildEmulateSeed with the Cue demo", () => {
  it("seeds the demo mailbox, calendar events, and a fixed calendar token", () => {
    const seed = buildEmulateSeed("http://localhost:3000", {
      fixture: buildCueDemoInbox(NOW),
      googleName: "David Lin",
      calendarEvents: buildCueDemoCalendarEvents("developer@example.com", NOW),
      tokens: { "test-token": { login: "developer@example.com", scopes: [] } },
    });

    expect(seed.google.users).toEqual([
      { email: "developer@example.com", name: "David Lin" },
    ]);
    expect(seed.google.calendar_events).toHaveLength(4);
    expect(seed.tokens).toEqual({
      "test-token": { login: "developer@example.com", scopes: [] },
    });
    // The demo persona's own address becomes the signed-in emulator user.
    expect(JSON.stringify(seed.google.messages)).not.toContain(
      "david@brightline.io",
    );
  });

  it("leaves the default seed unchanged", () => {
    const seed = buildEmulateSeed();
    expect("tokens" in seed).toBe(false);
    expect("calendar_events" in seed.google).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildEmulateSeed } from "@/scripts/emulate-seed";
import {
  buildCueDemoCalendarEvents,
  buildCueDemoInbox,
  buildCueDemoInsights,
  buildCueDemoWorkCalendarEvents,
  buildCueDemoWorkInbox,
  cueDemoReplySuggestions,
  cueDemoThreadBriefs,
} from "./cue-demo-inbox";

const NOW = new Date("2026-10-13T16:00:00Z"); // a Tuesday
const WORK_SUBJECTS = [
  "Renewal discussion & updated pricing",
  "SSO login failures for Acme users",
  "Enterprise pricing v3",
  "ACME-482: SSO security patch deployed",
];

describe("Cue demo inbox", () => {
  const school = buildCueDemoInbox(NOW);
  const work = buildCueDemoWorkInbox(NOW);
  const mailboxes = [school, work];
  const messages = mailboxes.flatMap((inbox) =>
    inbox.threads.flatMap((t) => t.messages),
  );
  const subjects = new Set(messages.map((m) => m.subject));
  const bodies = messages.map((m) => m.bodyText ?? "");
  const threadSubject = (t: { messages: { subject: string }[] }) =>
    t.messages[0].subject;

  it("has mail in every Home lane", () => {
    const withLabel = (label: string) =>
      mailboxes
        .flatMap((inbox) => inbox.threads)
        .filter((t) => t.messages.some((m) => m.labels?.includes(label)));
    expect(withLabel("To Reply").length).toBeGreaterThan(0);
    expect(withLabel("Awaiting Reply").length).toBeGreaterThan(0);
    expect(
      withLabel("Newsletter").length + withLabel("Receipt").length,
    ).toBeGreaterThan(0);
  });

  it("puts the work threads in the work mailbox and nowhere else", () => {
    expect(work.threads.map(threadSubject)).toEqual(WORK_SUBJECTS);
    for (const subject of school.threads.map(threadSubject))
      expect(WORK_SUBJECTS).not.toContain(subject);
    expect(work.mailbox.email).toBe("david@brightline.io");
    expect(school.mailbox.email).not.toBe(work.mailbox.email);
  });

  it("keeps message ids unique across both mailboxes", () => {
    const ids = mailboxes.flatMap((inbox) => [
      ...inbox.threads.map((t) => t.id),
      ...inbox.threads.flatMap((t) => t.messages.map((m) => m.id)),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses labels each mailbox defines", () => {
    for (const inbox of mailboxes) {
      const defined = new Set(inbox.labels.map((l) => l.name));
      for (const t of inbox.threads)
        for (const m of t.messages)
          for (const label of m.labels ?? []) expect(defined).toContain(label);
    }
  });

  it("keeps every message in the past, so it syncs", () => {
    for (const m of messages)
      expect(Date.parse(m.date)).toBeLessThan(NOW.getTime());
  });

  it("has a scripted brief only for subjects that exist", () => {
    for (const brief of cueDemoThreadBriefs)
      expect(subjects).toContain(brief.subject);
  });

  it("quotes only words the demo mail actually contains", () => {
    for (const { subject, object } of cueDemoReplySuggestions) {
      expect(subjects).toContain(subject);
      for (const claim of object.claims)
        expect(bodies.some((b) => b.includes(claim.quote))).toBe(true);
    }
  });

  it("notes only facts the demo mail contains, under subjects that exist", () => {
    for (const { subject, object } of buildCueDemoInsights(NOW)) {
      expect(subjects).toContain(subject);
      if (object.fact)
        expect(bodies.some((b) => b.includes(object.fact))).toBe(true);
    }
  });

  it("puts the Acme meetings on the work calendar", () => {
    const workEvents = buildCueDemoWorkCalendarEvents("me@example.com", NOW);
    const renewal = workEvents.find((e) => e.id === "cue_evt_acme_renewal");
    // The coming Friday at 10am Pacific.
    expect(renewal?.start_date_time).toBe("2026-10-16T17:00:00.000Z");
    expect(workEvents.map((e) => e.summary)).toEqual([
      "Acme renewal meeting",
      "Call with Sarah (Acme)",
    ]);
    expect(
      buildCueDemoCalendarEvents("me@example.com", NOW).map((e) => e.summary),
    ).toEqual(["CSE 151B group meeting", "NVIDIA new-grad webinar"]);
  });
});

describe("buildEmulateSeed with the Cue demo", () => {
  const seed = buildEmulateSeed("http://localhost:3000", {
    fixture: buildCueDemoInbox(NOW),
    googleEmail: "david.lin@ucsd.edu",
    googleName: "David Lin",
    calendarEvents: buildCueDemoCalendarEvents("david.lin@ucsd.edu", NOW),
    microsoftEmail: "david@brightline.io",
    microsoftName: "David Lin",
    microsoftFixture: buildCueDemoWorkInbox(NOW),
    microsoftCalendarEvents: buildCueDemoWorkCalendarEvents(
      "david@brightline.io",
      NOW,
    ),
    tokens: { "test-token": { login: "david.lin@ucsd.edu", scopes: [] } },
  });

  it("seeds the school Gmail, its calendar, and a fixed calendar token", () => {
    expect(seed.google.users).toEqual([
      { email: "david.lin@ucsd.edu", name: "David Lin" },
    ]);
    expect(seed.google.calendar_events).toHaveLength(2);
    expect(seed.tokens).toEqual({
      "test-token": { login: "david.lin@ucsd.edu", scopes: [] },
    });
    const gmail = JSON.stringify(seed.google.messages);
    expect(gmail).not.toContain("david@brightline.io");
    for (const subject of WORK_SUBJECTS)
      expect(seed.google.messages.map((m) => m.subject).includes(subject)).toBe(
        false,
      );
  });

  it("seeds the work Outlook with exactly the work threads", () => {
    const outlook = seed.microsoft;
    expect(outlook.users).toEqual([
      { email: "david@brightline.io", name: "David Lin" },
    ]);
    const received = outlook.messages?.filter(
      (m) => m.parent_folder_id !== "sentitems",
    );
    expect([...new Set(received?.map((m) => m.subject))]).toEqual(
      WORK_SUBJECTS,
    );
    expect(
      outlook.messages?.every((m) => m.user_email === "david@brightline.io"),
    ).toBe(true);
    expect(
      outlook.messages?.every((m) => m.inference_classification === "focused"),
    ).toBe(true);
  });

  it("files Outlook mail like Gmail did, with labels as categories", () => {
    const messages = seed.microsoft.messages ?? [];
    const bySubject = (subject: string) =>
      messages.find((m) => m.subject === subject);

    const renewal = bySubject("Renewal discussion & updated pricing");
    expect(renewal).toMatchObject({
      parent_folder_id: "inbox",
      is_read: false,
      categories: ["To Reply", "Work"],
      body_content_type: "text",
    });
    expect(renewal?.body_content).toContain("enterprise pricing sheet");
    expect(bySubject("Re: SSO login failures for Acme users")).toMatchObject({
      parent_folder_id: "sentitems",
      from: { address: "david@brightline.io", name: "David Lin" },
      to_recipients: [{ address: "sarah@acmecorp.com", name: "Sarah Chen" }],
    });
    expect(bySubject("Enterprise pricing v3")?.parent_folder_id).toBe(
      "archive",
    );
    expect(
      bySubject("ACME-482: SSO security patch deployed")?.cc_recipients,
    ).toEqual([{ address: "priya@brightline.io", name: "Priya Nair" }]);
  });

  it("defines every Outlook category its mail uses", () => {
    const defined = new Set(
      seed.microsoft.categories?.map((c) => c.display_name),
    );
    for (const m of seed.microsoft.messages ?? [])
      for (const category of m.categories) expect(defined).toContain(category);
    expect(defined).toContain("Work");
  });

  it("seeds the Acme meetings on the Outlook calendar", () => {
    expect(seed.microsoft.calendar_events).toEqual([
      expect.objectContaining({
        id: "cue_evt_acme_renewal",
        subject: "Acme renewal meeting",
        calendar_id: "primary",
        user_email: "david@brightline.io",
      }),
      expect.objectContaining({
        id: "cue_evt_call_sarah",
        subject: "Call with Sarah (Acme)",
      }),
    ]);
  });
});

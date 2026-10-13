import { describe, expect, it, vi } from "vitest";
import { checkInsight } from "./extract-insight";

vi.mock("server-only", () => ({}));

const EMAIL =
  "Your trip confirmation\nYour flight is confirmed. Confirmation PX7Q2M for David Lin. Departing Wednesday, November 25.";

describe("checkInsight", () => {
  it("keeps a detail that appears in the email word for word", () => {
    const insight = checkInsight(
      {
        action: "none",
        task: "",
        date: "2026-11-25",
        dateRole: "event",
        fact: "px7q2m",
        factLabel: "Confirmation",
      },
      EMAIL,
    );

    expect(insight).toMatchObject({
      fact: "px7q2m",
      factLabel: "Confirmation",
      date: "2026-11-25",
      dateRole: "event",
    });
  });

  it("drops a detail the email doesn't contain", () => {
    const insight = checkInsight(
      {
        action: "none",
        task: "",
        date: "",
        dateRole: "none",
        fact: "PX7Q2N",
        factLabel: "Confirmation",
      },
      EMAIL,
    );

    expect(insight).toMatchObject({ fact: null, factLabel: null, date: null });
  });

  it("drops a date that doesn't parse, and a task on an email that asks nothing", () => {
    const insight = checkInsight(
      {
        action: "none",
        task: "Read the newsletter",
        date: "next Friday-ish",
        dateRole: "deadline",
        fact: "",
        factLabel: "",
      },
      EMAIL,
    );

    expect(insight).toMatchObject({ task: "", date: null, dateRole: null });
  });
});

import { describe, expect, it } from "vitest";
import {
  vacationResponderFromGmail,
  vacationResponderToGmail,
} from "./settings";

describe("Gmail vacation responder mapping", () => {
  it("round-trips the reply and its dates through Gmail's epoch strings", () => {
    const body = {
      enabled: true,
      subject: "Away",
      message: "Back Monday",
      startTime: new Date("2026-10-20T00:00:00.000Z"),
      endTime: new Date("2026-10-24T23:59:59.000Z"),
    };

    const gmail = vacationResponderToGmail(body);

    expect(gmail).toMatchObject({
      enableAutoReply: true,
      responseSubject: "Away",
      responseBodyPlainText: "Back Monday",
      restrictToContacts: false,
      startTime: String(body.startTime.getTime()),
      endTime: String(body.endTime.getTime()),
    });
    expect(vacationResponderFromGmail(gmail)).toEqual(body);
  });

  it("clears the dates when none are set", () => {
    expect(
      vacationResponderToGmail({
        enabled: false,
        subject: "",
        message: "",
        startTime: null,
        endTime: null,
      }),
    ).toMatchObject({ startTime: null, endTime: null });
  });

  it("reads a reply written in Gmail's HTML editor as text", () => {
    expect(
      vacationResponderFromGmail({
        enableAutoReply: true,
        responseBodyHtml: "<div>Away until <b>Monday</b></div>",
      }).message,
    ).toBe("Away until Monday");
  });
});

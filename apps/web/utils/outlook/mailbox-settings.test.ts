import { describe, expect, it } from "vitest";
import {
  vacationResponderFromOutlook,
  vacationResponderToOutlook,
} from "./mailbox-settings";

const base = {
  enabled: true,
  subject: "",
  message: "Away <until> Monday\nThanks",
  startTime: null,
  endTime: null,
};

describe("Outlook automatic replies mapping", () => {
  it("turns replies on for everyone, escaping the message as HTML", () => {
    expect(vacationResponderToOutlook(base)).toEqual({
      status: "alwaysEnabled",
      externalAudience: "all",
      internalReplyMessage: "Away &lt;until&gt; Monday<br>Thanks",
      externalReplyMessage: "Away &lt;until&gt; Monday<br>Thanks",
    });
  });

  it("schedules replies in UTC when dates are set", () => {
    const setting = vacationResponderToOutlook({
      ...base,
      startTime: new Date("2026-10-20T00:00:00.000Z"),
      endTime: new Date("2026-10-24T23:59:59.000Z"),
    });

    expect(setting).toMatchObject({
      status: "scheduled",
      scheduledStartDateTime: {
        dateTime: "2026-10-20T00:00:00.000",
        timeZone: "UTC",
      },
      scheduledEndDateTime: {
        dateTime: "2026-10-24T23:59:59.000",
        timeZone: "UTC",
      },
    });
    expect(vacationResponderFromOutlook(setting)).toMatchObject({
      enabled: true,
      startTime: new Date("2026-10-20T00:00:00.000Z"),
      endTime: new Date("2026-10-24T23:59:59.000Z"),
    });
  });

  it("needs a last day to schedule", () => {
    expect(() =>
      vacationResponderToOutlook({
        ...base,
        startTime: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ).toThrow("Outlook needs a last day");
  });

  it("reads Graph's seven-digit UTC times and disabled replies", () => {
    expect(
      vacationResponderFromOutlook({
        status: "scheduled",
        internalReplyMessage: "<p>Away</p>",
        scheduledStartDateTime: {
          dateTime: "2026-10-20T08:00:00.0000000",
          timeZone: "UTC",
        },
        scheduledEndDateTime: {
          dateTime: "2026-10-21T08:00:00.0000000",
          timeZone: "UTC",
        },
      }),
    ).toEqual({
      enabled: true,
      subject: "",
      message: "Away",
      startTime: new Date("2026-10-20T08:00:00.000Z"),
      endTime: new Date("2026-10-21T08:00:00.000Z"),
    });
    expect(vacationResponderFromOutlook({ status: "disabled" }).enabled).toBe(
      false,
    );
  });
});

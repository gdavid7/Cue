import { describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES, REQUIRED_SCOPES, SCOPES } from "./scopes";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_CONTACTS_ENABLED: true,
    NEXT_PUBLIC_EMAIL_SEND_ENABLED: false,
  },
}));

describe("Outlook scopes", () => {
  it("requests both contact sources when suggestions are enabled", () => {
    expect(SCOPES).toContain("Contacts.Read");
    expect(SCOPES).toContain("People.Read");
  });

  it("keeps contact access optional so existing accounts stay connected", () => {
    expect(REQUIRED_SCOPES).not.toContain("Contacts.Read");
    expect(REQUIRED_SCOPES).not.toContain("People.Read");
  });

  it("asks for calendar access at sign-in without requiring it", () => {
    const calendarAccess = CALENDAR_SCOPES.filter((scope) =>
      scope.startsWith("Calendars."),
    );

    expect(calendarAccess).not.toHaveLength(0);
    expect(SCOPES).toEqual(expect.arrayContaining(calendarAccess));
    for (const scope of calendarAccess)
      expect(REQUIRED_SCOPES).not.toContain(scope);
  });
});

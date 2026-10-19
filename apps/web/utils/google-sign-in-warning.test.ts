import { describe, expect, it } from "vitest";
import {
  getGoogleSignInWarning,
  localDayKey,
} from "@/utils/google-sign-in-warning";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-19T12:00:00");

function account({
  id = "a1",
  daysAgo = 5.5,
  provider = "google",
  disconnectedAt = null,
}: {
  id?: string;
  daysAgo?: number | null;
  provider?: string;
  disconnectedAt?: string | null;
} = {}) {
  return {
    id,
    email: `${id}@example.com`,
    account: {
      provider,
      disconnectedAt,
      refreshTokenIssuedAt:
        daysAgo === null
          ? null
          : new Date(now.getTime() - daysAgo * DAY).toISOString(),
    },
  };
}

describe("getGoogleSignInWarning", () => {
  it("stays quiet before day 5", () => {
    expect(
      getGoogleSignInWarning({ accounts: [account({ daysAgo: 4.9 })], now }),
    ).toBeNull();
  });

  it("warns from day 5 and names the expiry weekday", () => {
    const warning = getGoogleSignInWarning({
      accounts: [account({ daysAgo: 5.5 })],
      now,
    });
    expect(warning?.emailAccountId).toBe("a1");
    // Consent was Oct 14, so Google ends the sign-in on Wednesday the 21st.
    expect(warning?.weekday).toBe("Wednesday");
  });

  it("leaves already-expired sign-ins to the existing reconnect flow", () => {
    expect(
      getGoogleSignInWarning({ accounts: [account({ daysAgo: 7.1 })], now }),
    ).toBeNull();
  });

  it("ignores non-Google, disconnected and unknown-consent accounts", () => {
    expect(
      getGoogleSignInWarning({
        accounts: [
          account({ provider: "microsoft" }),
          account({ disconnectedAt: now.toISOString() }),
          account({ daysAgo: null }),
        ],
        now,
      }),
    ).toBeNull();
  });

  it("picks the account that expires first across all accounts", () => {
    const warning = getGoogleSignInWarning({
      accounts: [
        account({ id: "later", daysAgo: 5.1 }),
        account({ id: "sooner", daysAgo: 6.5 }),
      ],
      now,
    });
    expect(warning?.emailAccountId).toBe("sooner");
    expect(warning?.hasMultipleAccounts).toBe(true);
  });

  it("skips accounts dismissed today and shows the next one", () => {
    const warning = getGoogleSignInWarning({
      accounts: [
        account({ id: "sooner", daysAgo: 6.5 }),
        account({ id: "later", daysAgo: 5.1 }),
      ],
      now,
      dismissed: { sooner: localDayKey(now) },
    });
    expect(warning?.emailAccountId).toBe("later");
  });

  it("shows again the next day after a dismissal", () => {
    const tomorrow = new Date(now.getTime() + DAY);
    expect(
      getGoogleSignInWarning({
        accounts: [account({ daysAgo: 5.5 })],
        now: tomorrow,
        dismissed: { a1: localDayKey(now) },
      })?.emailAccountId,
    ).toBe("a1");
  });

  it("stays quiet once the app is verified", () => {
    expect(
      getGoogleSignInWarning({
        accounts: [account()],
        now,
        appUnverified: false,
      }),
    ).toBeNull();
  });
});

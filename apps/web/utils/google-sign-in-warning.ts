import { GOOGLE_APP_UNVERIFIED } from "@/utils/google-app-status";

const DAY_MS = 24 * 60 * 60 * 1000;
// Google expires a Testing-mode app's refresh tokens 7 days after consent.
const GOOGLE_SIGN_IN_LIFETIME_MS = 7 * DAY_MS;
const WARN_AFTER_MS = 5 * DAY_MS;

type WarnableAccount = {
  id: string;
  email: string;
  account: {
    provider: string;
    disconnectedAt: string | null;
    refreshTokenIssuedAt: string | null;
  };
};

export function getGoogleSignInWarning({
  accounts,
  now,
  dismissed = {},
  appUnverified = GOOGLE_APP_UNVERIFIED,
}: {
  accounts: WarnableAccount[];
  now: Date;
  /** Local day (see localDayKey) each account's notice was dismissed. */
  dismissed?: Record<string, string>;
  appUnverified?: boolean;
}) {
  if (!appUnverified) return null;

  const today = localDayKey(now);
  const due = accounts
    .flatMap((emailAccount) => {
      const { provider, disconnectedAt, refreshTokenIssuedAt } =
        emailAccount.account;
      if (provider !== "google" || disconnectedAt || !refreshTokenIssuedAt)
        return [];
      return [
        { emailAccount, issuedAt: new Date(refreshTokenIssuedAt).getTime() },
      ];
    })
    .filter(({ issuedAt }) => {
      const age = now.getTime() - issuedAt;
      // Past expiry the existing sign-in-again flow takes over.
      return age >= WARN_AFTER_MS && age < GOOGLE_SIGN_IN_LIFETIME_MS;
    })
    .filter(({ emailAccount }) => dismissed[emailAccount.id] !== today)
    .sort((a, b) => a.issuedAt - b.issuedAt);

  const first = due[0];
  if (!first) return null;

  const expiresAt = new Date(first.issuedAt + GOOGLE_SIGN_IN_LIFETIME_MS);
  return {
    emailAccountId: first.emailAccount.id,
    email: first.emailAccount.email,
    weekday: expiresAt.toLocaleDateString("en-US", { weekday: "long" }),
    hasMultipleAccounts:
      accounts.filter(({ account }) => account.provider === "google").length >
      1,
  };
}

export function localDayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

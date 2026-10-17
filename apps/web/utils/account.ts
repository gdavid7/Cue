import { cookies } from "next/headers";
import { auth } from "@/utils/auth";
import { redirect } from "next/navigation";
import { after } from "next/server";
import prisma from "@/utils/prisma";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  parseLastEmailAccountCookieValue,
} from "@/utils/cookies";
import { buildLoginRedirectUrl, buildRedirectUrl } from "@/utils/redirect";
import { createScopedLogger } from "@/utils/logger";
import { flushLoggerSafely } from "@/utils/logger-flush";
import {
  getMailRedirectPath,
  getOrderedEmailAccountIds,
} from "@/utils/mail-url.server";

const logger = createScopedLogger("account-redirect");

export async function redirectToEmailAccountPath(
  path: `/${string}`,
  searchParams?: Record<string, string | string[] | undefined>,
  // Pages that already resolved the session pass it to skip a second lookup.
  knownSession?: NonNullable<Awaited<ReturnType<typeof auth>>>,
) {
  const timing = createRedirectTiming(path, searchParams);
  const session =
    knownSession ?? (await measureRedirectStep(timing, "auth", () => auth()));
  const userId = session?.user.id;
  if (!userId) {
    logRedirectTiming(timing, {
      outcome: "login",
      usedLastEmailAccountCookie: false,
      usedFallbackAccountLookup: false,
      foundEmailAccount: false,
    });
    redirect(buildLoginRedirectUrl(buildRedirectUrl(path, searchParams)));
  }

  const { emailAccountId, usedLastEmailAccountCookie } =
    path === "/mail"
      ? await measureRedirectStep(timing, "email-accounts", () =>
          resolveMailAccount(userId),
        )
      : await resolveAccount(timing, userId);

  if (!emailAccountId) {
    logRedirectTiming(timing, {
      outcome: "connect-mailbox",
      usedLastEmailAccountCookie,
      usedFallbackAccountLookup: !usedLastEmailAccountCookie,
      foundEmailAccount: false,
    });
    redirect(
      buildRedirectUrl("/connect-mailbox", {
        next: buildRedirectUrl(path, searchParams),
      }),
    );
  }

  // Mail is addressed by account position (`/mail/u/{n}`), not by id.
  const mailPath =
    path === "/mail"
      ? await getMailRedirectPath({ userId, emailAccountId, searchParams })
      : null;
  const redirectUrl =
    mailPath ?? buildRedirectUrl(`/${emailAccountId}${path}`, searchParams);

  logRedirectTiming(timing, {
    outcome: "account-path",
    usedLastEmailAccountCookie,
    usedFallbackAccountLookup: !usedLastEmailAccountCookie,
    foundEmailAccount: true,
  });
  redirect(redirectUrl);
}

// Mail is addressed by account position, so the ordered account list it needs
// anyway also confirms the last-used account, in one lookup.
async function resolveMailAccount(userId: string) {
  const [accountIds, lastEmailAccountId] = await Promise.all([
    getOrderedEmailAccountIds(userId),
    getLastEmailAccountIdFromCookie(userId),
  ]);
  const usedLastEmailAccountCookie =
    !!lastEmailAccountId && accountIds.includes(lastEmailAccountId);
  return {
    emailAccountId: usedLastEmailAccountCookie
      ? lastEmailAccountId
      : (accountIds[0] ?? null),
    usedLastEmailAccountCookie,
  };
}

async function resolveAccount(timing: RedirectTiming, userId: string) {
  const lastEmailAccountId = await measureRedirectStep(
    timing,
    "last-email-account-cookie",
    () => getConfirmedLastEmailAccountId(userId),
  );
  if (lastEmailAccountId) {
    return {
      emailAccountId: lastEmailAccountId,
      usedLastEmailAccountCookie: true,
    };
  }

  const emailAccount = await measureRedirectStep(
    timing,
    "fallback-email-account-lookup",
    () =>
      prisma.emailAccount.findFirst({
        where: { userId },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
  );
  return {
    emailAccountId: emailAccount?.id ?? null,
    usedLastEmailAccountCookie: false,
  };
}

async function getConfirmedLastEmailAccountId(
  userId: string,
): Promise<string | null> {
  try {
    const lastEmailAccountId = await getLastEmailAccountIdFromCookie(userId);
    if (!lastEmailAccountId) return null;

    const emailAccount = await prisma.emailAccount.findFirst({
      where: { id: lastEmailAccountId, userId },
      select: { id: true },
    });
    return emailAccount?.id ?? null;
  } catch {
    return null;
  }
}

async function getLastEmailAccountIdFromCookie(
  userId: string,
): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    return parseLastEmailAccountCookieValue({
      userId,
      cookieValue: cookieStore.get(LAST_EMAIL_ACCOUNT_COOKIE)?.value,
    });
  } catch {
    return null;
  }
}

type RedirectTiming = {
  path: string;
  searchParamKeys: string[];
  startedAt: number;
  stepDurationsMs: Record<string, number>;
};

function createRedirectTiming(
  path: `/${string}`,
  searchParams?: Record<string, string | string[] | undefined>,
): RedirectTiming {
  return {
    path,
    searchParamKeys: Object.keys(searchParams ?? {}).sort(),
    startedAt: Date.now(),
    stepDurationsMs: {},
  };
}

async function measureRedirectStep<T>(
  timing: RedirectTiming,
  step: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    timing.stepDurationsMs[step] = Date.now() - startedAt;
  }
}

function logRedirectTiming(
  timing: RedirectTiming,
  metadata: {
    outcome: "account-path" | "connect-mailbox" | "login";
    usedLastEmailAccountCookie: boolean;
    usedFallbackAccountLookup: boolean;
    foundEmailAccount: boolean;
  },
) {
  const durationMs = Date.now() - timing.startedAt;
  logger.info("Resolved account redirect", {
    path: timing.path,
    searchParamKeys: timing.searchParamKeys,
    durationMs,
    stepDurationsMs: timing.stepDurationsMs,
    ...metadata,
  });

  after(async () => {
    await flushLoggerSafely(logger, {
      path: timing.path,
      durationMs,
      outcome: metadata.outcome,
    });
  });
}

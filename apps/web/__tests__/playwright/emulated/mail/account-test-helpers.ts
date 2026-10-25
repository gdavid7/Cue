import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Account } from "@/generated/prisma/client";

/**
 * Connects another account for the signed-in user. By default it reads its
 * own seeded mailbox (playwright.config.mjs), with copies of the primary's
 * mail, so the two accounts share no message. `mailbox: "primary"` makes it
 * read the primary's mailbox instead: every message then reached both
 * accounts, as one email delivered to two of the user's addresses does.
 */
export async function createSecondEmailAccount(
  primaryEmailAccountId: string,
  {
    signature,
    mailbox = "own",
  }: { signature?: string; mailbox?: "own" | "primary" } = {},
) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const suffix = randomUUID();
  const accountId = `playwright-account-${suffix}`;
  const id = `playwright-email-account-${suffix}`;
  const name = "Playwright Secondary";

  try {
    const own = mailbox === "own" ? await freeExtraMailbox(client) : undefined;
    const email = own?.email ?? `playwright-secondary-${suffix}@gmail.com`;
    await client.query("BEGIN");
    // A mailbox of its own is reached with its fixed emulator token, which
    // never expires, so the app never refreshes it into the primary's.
    const accountResult = await client.query<Pick<Account, "userId">>(
      `INSERT INTO "Account"
        (id, "createdAt", "updatedAt", "userId", provider, type,
         "providerAccountId", refresh_token, "refreshTokenExpiresAt",
         access_token, expires_at, token_type, scope)
       SELECT $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, email_account."userId",
         account.provider, 'oidc', $2,
         COALESCE($4, account.refresh_token),
         account."refreshTokenExpiresAt",
         COALESCE($5, account.access_token),
         CASE WHEN $5::text IS NULL THEN account.expires_at
           ELSE CURRENT_TIMESTAMP + interval '1 year' END,
         account.token_type, account.scope
       FROM "EmailAccount" email_account
       JOIN "Account" account ON account.id = email_account."accountId"
       WHERE email_account.id = $3 AND account.refresh_token IS NOT NULL
       RETURNING "userId"`,
      [
        accountId,
        `playwright-provider-${suffix}`,
        primaryEmailAccountId,
        own ? `${own.token}-no-refresh` : null,
        own?.token ?? null,
      ],
    );
    const userId = accountResult.rows[0]?.userId;
    if (!userId)
      throw new Error("Could not clone the Playwright account credentials");

    await client.query(
      `INSERT INTO "EmailAccount"
        (id, email, name, signature, "createdAt", "updatedAt", "userId", "accountId")
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5, $6)`,
      [id, email, name, signature, userId, accountId],
    );
    await client.query("COMMIT");
    return {
      accountId,
      email,
      id,
      name,
      accessToken: own?.token,
      /** This account's copy of a message seeded in the primary mailbox. */
      seededMessageId: (primaryId: string) =>
        own ? `${primaryId}${own.idSuffix}` : primaryId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export async function deleteSecondEmailAccount(accountId: string) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DELETE FROM "Account" WHERE id = $1`, [accountId]);
  } finally {
    await client.end();
  }
}

async function freeExtraMailbox(client: Client) {
  const mailboxes: { email: string; token: string; idSuffix: string }[] =
    JSON.parse(process.env.PLAYWRIGHT_EXTRA_MAILBOXES ?? "[]");
  const used = await client.query<{ email: string }>(
    `SELECT email FROM "EmailAccount" WHERE email = ANY($1)`,
    [mailboxes.map((mailbox) => mailbox.email)],
  );
  const taken = new Set(used.rows.map((row) => row.email));
  const free = mailboxes.find((mailbox) => !taken.has(mailbox.email));
  if (!free) throw new Error("Every extra Playwright mailbox is in use");
  return free;
}

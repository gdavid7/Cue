import { expect } from "@playwright/test";
import { Client } from "pg";
import { test } from "../playwright-test";
import { getEmailAccountId } from "../account-test-helpers";

test("opens chat directly on a new mailbox without an onboarding cookie", async ({
  page,
}) => {
  const emailAccountId = await getEmailAccountId(page);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // A new mailbox has only the reply tracking rules it starts with, none of
    // the person's own.
    const rules = await client.query<{ systemType: string | null }>(
      'SELECT "systemType" FROM "Rule" WHERE "emailAccountId" = $1',
      [emailAccountId],
    );
    expect(rules.rows.map((rule) => rule.systemType).sort()).toEqual([
      "ACTIONED",
      "AWAITING_REPLY",
      "FYI",
      "TO_REPLY",
    ]);
  } finally {
    await client.end();
  }
  await page.context().clearCookies({ name: "viewed_assistant_onboarding" });

  await page.goto(`/${emailAccountId}/assistant`);
  await expect(page).toHaveURL(
    (url) => url.pathname === `/${emailAccountId}/assistant`,
  );
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.goto(`/${emailAccountId}/assistant?onboarding=true`);
  await expect(page).toHaveURL(
    (url) => url.pathname === `/${emailAccountId}/assistant`,
  );
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

import { expect } from "@playwright/test";
import { Client } from "pg";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";

type FirstRunState = {
  userId: string;
  emailAccountId: string;
  completedOnboardingAt: Date | null;
  dismissedHints: string[];
  ruleCount: number;
};

let previousState: FirstRunState | undefined;

test.beforeEach(async () => {
  previousState = await withClient(async (client) => {
    const result = await client.query<FirstRunState>(
      `SELECT u.id AS "userId", ea.id AS "emailAccountId",
              u."completedOnboardingAt", u."dismissedHints",
              (SELECT count(*)::int FROM "Rule" r
               WHERE r."emailAccountId" = ea.id) AS "ruleCount"
       FROM "User" u
       INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL],
    );
    const state = result.rows[0];
    if (!state) throw new Error("Could not find the Playwright account");

    // As a brand-new user: onboarding not done, inbox style not chosen yet.
    await client.query(
      `UPDATE "User"
       SET "completedOnboardingAt" = NULL,
           "dismissedHints" = array_remove("dismissedHints", $2)
       WHERE id = $1`,
      [state.userId, `inbox-style:${state.emailAccountId}`],
    );
    return state;
  });
});

test.afterEach(async () => {
  const state = previousState;
  previousState = undefined;
  if (!state) return;
  await withClient((client) =>
    client.query(
      `UPDATE "User"
       SET "completedOnboardingAt" = $2, "dismissedHints" = $3
       WHERE id = $1`,
      [state.userId, state.completedOnboardingAt, state.dismissedHints],
    ),
  );
});

test("a new user lands in mail, picks an inbox style, and gets the tour", async ({
  page,
}, testInfo) => {
  const state = previousState;
  if (!state) throw new Error("First-run state was not prepared");

  await page.goto("/welcome-redirect");
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/, {
    timeout: 60_000,
  });

  const card = page.getByRole("region", {
    name: "Let Cue find what needs you",
  });
  await expect(card).toBeVisible({ timeout: 60_000 });
  const cueTabs = card.getByRole("checkbox", { name: /Needs reply/ });
  await expect(cueTabs).toBeChecked();
  await capturePlaywrightCheckpoint(page, testInfo, "first-run-inbox-style");

  // Unchecked, the choice adds nothing to the mailbox: no labels, rules or tabs.
  await cueTabs.click();
  await expect(cueTabs).not.toBeChecked();
  await card.getByRole("radio", { name: /One inbox/ }).click();
  await card.getByRole("button", { name: "Set up my inbox" }).click();
  await expect(card).toBeHidden({ timeout: 30_000 });

  const tour = page.getByLabel("Getting started");
  await expect(tour.getByRole("button", { name: "Skip tour" })).toBeVisible({
    timeout: 30_000,
  });
  await capturePlaywrightCheckpoint(page, testInfo, "first-run-tour");
  await tour.getByRole("button", { name: "Skip tour" }).click();
  await expect(tour).toBeHidden();

  await expect(
    page.getByRole("button", { name: "Needs reply", exact: true }),
  ).toHaveCount(0);

  const persisted = await withClient(async (client) => {
    const result = await client.query<{
      completed: boolean;
      ruleCount: number;
    }>(
      `SELECT u."completedOnboardingAt" IS NOT NULL AS completed,
              (SELECT count(*)::int FROM "Rule" r
               WHERE r."emailAccountId" = $2) AS "ruleCount"
       FROM "User" u WHERE u.id = $1`,
      [state.userId, state.emailAccountId],
    );
    return result.rows[0];
  });
  expect(persisted).toEqual({ completed: true, ruleCount: state.ruleCount });
});

async function withClient<T>(callback: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

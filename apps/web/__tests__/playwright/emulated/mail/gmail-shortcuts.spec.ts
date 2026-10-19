import { expect, type Page } from "@playwright/test";
import { test } from "../playwright-test";
import { playwrightMailProvider } from "../mail-provider";
import {
  conversationWithSubject,
  openMail,
  readLatestMailMutation,
} from "./mail-test-helpers";

const ARCHIVE_THREAD = "thr_playwright_archive";

test("archives the selected conversation with the right bracket and restores it", async ({
  page,
}) => {
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(
    page,
    conversations,
    "Archive Action Message",
  );
  await row.getByRole("checkbox", { includeHidden: true }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();

  await page.keyboard.press("]");

  await expect(row).toHaveCount(0);
  await expectMutation(page, emailAccountId, "archive");

  await page.keyboard.press("z");
  await expect(row).toBeVisible();
  // The next test reloads the mailbox; the restore has to have landed first.
  await expectMutation(page, emailAccountId, "unarchive");
});

test("marks the selected conversation important with = and not important with -", async ({
  page,
}) => {
  test.skip(
    playwrightMailProvider === "microsoft",
    "Importance is a Gmail concept.",
  );
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(
    page,
    conversations,
    "Archive Action Message",
  );
  await row.getByRole("checkbox", { includeHidden: true }).click();

  await page.keyboard.press("=");
  await expectMutation(page, emailAccountId, "set_important_state", {
    important: true,
  });

  await row.getByRole("checkbox", { includeHidden: true }).click();
  await page.keyboard.press("-");
  await expectMutation(page, emailAccountId, "set_important_state", {
    important: false,
  });
});

test("moves between the messages of an open conversation with n and p", async ({
  page,
}) => {
  const { conversations } = await openMail(page);
  await conversationWithSubject(
    page,
    conversations,
    "Re: Reader Navigation Message",
  ).click();
  const messages = page.locator("[data-thread-message-id]");
  await expect(messages.nth(1)).toBeVisible();

  await messages.first().focus();
  await page.keyboard.press("n");
  await expect(messages.nth(1)).toBeFocused();

  await page.keyboard.press("p");
  await expect(messages.first()).toBeFocused();
});

async function expectMutation(
  page: Page,
  emailAccountId: string,
  kind: string,
  payload?: Record<string, unknown>,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind,
          threadId: ARCHIVE_THREAD,
          ...(payload ? { payload } : {}),
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}

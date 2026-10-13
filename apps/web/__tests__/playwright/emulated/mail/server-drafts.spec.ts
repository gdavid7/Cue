import { expect } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { isMicrosoftPlaywright } from "../mail-provider";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  openMail,
  openMailboxFromSidebar,
} from "./mail-test-helpers";

test.skip(
  isMicrosoftPlaywright(),
  "Multiple Gmail draft messages on one conversation are seeded in the Google emulator.",
);

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("preserves multiple server drafts without reply headers", async ({
  page,
}, testInfo) => {
  const { conversations } = await openMail(page);
  await conversationWithSubject(
    page,
    conversations,
    "Multiple Server Drafts",
  ).click();
  // Like Gmail, one draft is open at a time: the newest. The other is a row.
  const editors = page.getByRole("textbox", { name: "Email message" });
  const collapsed = page.getByTestId("collapsed-draft");
  await expect(editors).toHaveCount(1);
  await expect(editors).toContainText("Second saved reply");
  await expect(collapsed).toHaveCount(1);
  await expect(collapsed).toContainText("First saved reply");

  await collapsed.click();
  await expect(editors).toHaveCount(1);
  await expect(editors).toContainText("First saved reply");
  await expect(collapsed).toContainText("Second saved reply");
  await editors.fill("Independent first edit");
  await expect(
    page.getByText("First saved reply", { exact: true }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "multiple-server-drafts");

  // A forward takes the one open composer, and closing it hands back the draft.
  await page
    .locator('[data-thread-message-id="msg_playwright_multi_draft_parent"]')
    .getByRole("button", { name: "Forward", exact: true })
    .click();
  await expect(editors).toHaveCount(1);
  await expect(collapsed).toHaveCount(2);
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(editors).toContainText("Independent first edit");
  await expect(collapsed).toHaveCount(1);

  const pendingDiscards = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let discards = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (
      request.headers()["next-action"] &&
      (body.includes("msg_playwright_multi_draft_first") ||
        body.includes("msg_playwright_multi_draft_second")) &&
      !body.includes("messageHtml")
    ) {
      await pendingDiscards[discards++].promise;
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  // Discarding the open draft opens the other one.
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(editors).toContainText("Second saved reply");
  await expect(collapsed).toHaveCount(0);
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(editors).toHaveCount(0);
  await expect.poll(() => discards).toBe(1);
  pendingDiscards[0].resolve();
  await expect(editors).toHaveCount(1);
  await expect.poll(() => discards).toBe(2);
  pendingDiscards[1].resolve();
  // Both failed, so both come back, still with one of them open.
  await expect(editors).toHaveCount(1);
  await expect(collapsed).toHaveCount(1);
  await expect(editors).toContainText("Independent first edit");
  await expect(collapsed).toContainText("Second saved reply");
  await capturePlaywrightCheckpoint(page, testInfo, "restored-server-drafts");
});

test("preserves multiple server drafts without a sent parent", async ({
  page,
}, testInfo) => {
  const { conversations } = await openMail(page);
  await openMailboxFromSidebar(page, "Drafts");
  await conversationWithSubject(
    page,
    conversations,
    "Drafts Without Parent",
  ).click();
  const editors = page.getByRole("textbox", { name: "Email message" });
  const collapsed = page.getByTestId("collapsed-draft");
  await expect(editors).toHaveCount(1);
  await expect(editors).toContainText("Second saved reply");
  await expect(collapsed).toContainText("First saved reply");
  await collapsed.click();
  await expect(editors).toContainText("First saved reply");
  await editors.fill("Independent first edit");
  await expect(
    page.getByText("First saved reply", { exact: true }),
  ).toHaveCount(0);
  await expect(collapsed).toContainText("Second saved reply");
  await capturePlaywrightCheckpoint(page, testInfo, "draft-only-composers");
});

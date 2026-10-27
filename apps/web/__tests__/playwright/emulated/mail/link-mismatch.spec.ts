import { expect } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

test("hints when a link shows one address but goes to another", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  await page.goto(
    `/${emailAccountId}/mail?thread-id=thr_playwright_link_mismatch`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(
    page.getByRole("heading", { name: "Link Mismatch Statement" }),
  ).toBeVisible({ timeout: 60_000 });

  const frame = page
    .frameLocator('iframe[title="Email content preview"]')
    .last();
  const mismatched = frame.getByRole("link", {
    name: "account.example.com/statement",
  });
  await expect(mismatched).toHaveAttribute(
    "href",
    "https://login.example.net/statement",
  );
  await expect(mismatched).toHaveAttribute("title", "login.example.net");
  // Text and destination share example.com, so this link is left alone.
  await expect(
    frame.getByRole("link", { name: "example.com/help" }),
  ).not.toHaveAttribute("title", /.+/);

  await expect(
    page.getByText("1 link shows one address but goes to another"),
  ).toBeVisible();
  await expect(page.getByText(/^Hid \d+ tracker/)).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "link-mismatch-reader");
});

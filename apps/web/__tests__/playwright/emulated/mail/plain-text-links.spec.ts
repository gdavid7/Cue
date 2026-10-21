import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

test("renders links in plain text messages", async ({ page }) => {
  const { emailAccountId } = await openMail(page);
  await page.goto(
    `/${emailAccountId}/mail?thread-id=thr_playwright_plain_links`,
    {
      waitUntil: "domcontentloaded",
    },
  );

  const plainMessage = page.locator(
    'li[data-thread-message-id="msg_playwright_plain_links"]',
  );
  await expect(plainMessage).toBeVisible({ timeout: 60_000 });
  const domainLink = plainMessage.getByRole("link", {
    name: "service.new/account",
    exact: true,
  });
  const secureLink = plainMessage.getByRole("link", {
    name: "https://staging.example.com/verify?token=value",
    exact: true,
  });
  await expect(domainLink).toHaveAttribute(
    "href",
    "http://service.new/account",
  );
  await expect(secureLink).toHaveAttribute(
    "href",
    "https://staging.example.com/verify?token=value",
  );
  await expect(domainLink).toHaveAttribute("target", "_blank");
  await expect(domainLink).toHaveAttribute("rel", "noopener noreferrer");

  // The sender wrapped this URL across three lines inside <...>.
  const wrappedLink = plainMessage.locator(`a[href="${WRAPPED_URL}"]`);
  await expect(wrappedLink).toHaveCount(1);
  await expect(wrappedLink).toHaveAttribute("target", "_blank");
});

test("links a long bare URL in an HTML message", async ({ page }) => {
  const { emailAccountId } = await openMail(page);
  await page.goto(
    `/${emailAccountId}/mail?thread-id=thr_playwright_plain_links`,
    {
      waitUntil: "domcontentloaded",
    },
  );

  const htmlMessage = page.locator(
    'li[data-thread-message-id="msg_playwright_html_links"]',
  );
  await expect(htmlMessage).toBeVisible({ timeout: 60_000 });
  // The test above may already have opened the thread and marked it read,
  // which leaves this earlier message collapsed.
  const toggle = htmlMessage.locator("[data-message-toggle][aria-expanded]");
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
  const link = htmlMessage
    .frameLocator("iframe")
    .getByRole("link", { name: LONG_HTML_URL, exact: true });
  await expect(link).toHaveAttribute("href", LONG_HTML_URL, {
    timeout: 60_000,
  });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

const LONG_HTML_URL = `https://click.example.com/ls/click?upn=${"u001.aB3-_x9".repeat(22)}&utm_source=newsletter`;
const WRAPPED_URL = `https://links.example.com/reset/${"Zq8-Lm4_Tr2".repeat(12)}`;

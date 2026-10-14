import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import {
  getIntegrationRow,
  getIntegrationToolCard,
  openIntegrations,
  resetIntegrationTestState,
  setupIntegrationTestState,
} from "./integration-test-helpers";

test.beforeEach(async () => {
  await setupIntegrationTestState();
});

test.afterEach(async () => {
  await resetIntegrationTestState();
});

test("persists which read tools are enabled", async ({ page }) => {
  test.setTimeout(360_000);
  await openIntegrations(page);

  const notionRow = getIntegrationRow(page, "Notion");
  await expect(notionRow.getByText("Connected", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  await notionRow.getByRole("button", { name: "Integration actions" }).click();
  await page
    .getByRole("menuitem", { name: "Manage tools (1 of 2 on)" })
    .click();

  const fetchToolCard = getIntegrationToolCard(page, "notion-fetch");
  const fetchToolSwitch = fetchToolCard.getByRole("switch");
  await expect(fetchToolSwitch).toBeChecked();
  await fetchToolSwitch.click();
  await expect(page.getByText("Tool updated", { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  await openIntegrations(page);
  await expect(notionRow.getByText("Connected", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  await notionRow.getByRole("button", { name: "Integration actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Manage tools (0 of 2 on)" }),
  ).toBeVisible();
});

test("persists pause state and disconnects the integration", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openIntegrations(page);

  const notionRow = getIntegrationRow(page, "Notion");
  await expect(notionRow.getByText("Connected", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  await notionRow.getByRole("button", { name: "Integration actions" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(page.getByText("Notion paused", { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  await openIntegrations(page);
  await expect(notionRow.getByText("Paused", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await notionRow.getByRole("button", { name: "Integration actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Resume" })).toBeVisible();
  await page.keyboard.press("Escape");

  await notionRow.getByRole("button", { name: "Integration actions" }).click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(
    page.getByText("Disconnected successfully", { exact: true }),
  ).toBeVisible({ timeout: 120_000 });

  await openIntegrations(page);
  // Apps Composio doesn't host are listed only while connected.
  await page.getByRole("button", { name: /^Show \d+ more apps$/ }).click();
  await expect(
    page.getByRole("button", { name: "Show fewer apps" }),
  ).toBeVisible();
  await expect(notionRow).toHaveCount(0);
});

import { test, expect, check, scenario } from "../support/groundtruth";

test("c1: muting Archive Action Message moves it from inbox to Muted", async ({ page }) => {
  await scenario("signed-in");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await page.goto("/mail");
  const row = page.getByRole("option", { name: /Archive Action Message/ });
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Mute/ }).click();
  await expect(page.getByText("Muted", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByRole("listbox", { name: "Conversations" })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("link", { name: "Muted" }).click();
  const muted = page.getByRole("list", { name: "Muted conversations" });
  await check(page, "c1 · inbox no longer lists it, Muted lists it", muted, async () => {
    await expect(muted.getByText("Archive Action Message")).toBeVisible();
  });
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByRole("listbox", { name: "Conversations" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Archive Action Message/ })).toHaveCount(0);
});

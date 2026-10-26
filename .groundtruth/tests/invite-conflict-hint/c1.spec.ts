import { test, expect, check, scenario } from "../support/groundtruth";

test("c1: invite card shows single conflict", async ({ page }) => {
  await scenario("invite-one-conflict");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/);
  const search = page.getByRole("combobox", { name: "Search mail" });
  await search.fill("Calendar Invitation");
  await search.press("Enter");
  await page.getByRole("option", { name: /Calendar Invitation Message/ }).click();
  const card = page.getByRole("region", { name: "Calendar invitation" });
  await expect(card).toBeVisible();
  await check(page, "c1 · card says Conflicts with Product planning with notetaker, no 'and … more'", card, async () => {
    await expect(card).toContainText("Conflicts with Product planning with notetaker");
    await expect(card).not.toContainText(/and \d+ more/);
  });
});

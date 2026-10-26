import { test, expect, check, scenario } from "../support/groundtruth";

test("c3: invitation card says free when calendar is empty", async ({ page }) => {
  await scenario("invite-free");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page.getByRole("listbox", { name: "Conversations" })).toBeVisible({ timeout: 30000 });
  const search = page.getByRole("combobox", { name: "Search mail" });
  await search.fill("Calendar Invitation");
  await search.press("Enter");
  await page.getByRole("option", { name: /Calendar Invitation Message/ }).click();
  const card = page.getByRole("region", { name: "Calendar invitation" });
  await expect(card).toBeVisible();
  await check(page, "c3 · invitation card says You’re free then and names no conflict", card, async () => {
    await expect(card).toContainText("You’re free then");
    await expect(card).not.toContainText(/conflict/i);
    await expect(card).not.toContainText("Product planning with notetaker");
    await expect(card).not.toContainText("Hiring sync");
  });
});

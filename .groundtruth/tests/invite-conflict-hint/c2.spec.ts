import { test, expect, check, scenario } from "../support/groundtruth";

test("c2: invitation card shows Hiring sync conflict and 1 more", async ({ page }) => {
  await scenario("invite-two-conflicts");
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
  await check(page, "c2 · card says Conflicts with Hiring sync and and 1 more", card, async () => {
    await expect(card).toContainText("Conflicts with Hiring sync");
    await expect(card).toContainText("and 1 more");
  });
});

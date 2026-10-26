import { test, expect, check, scenario } from "../support/groundtruth";

test("c4: invite with no calendar shows RSVP buttons but no conflict/free line", async ({ page }) => {
  await scenario("invite-no-calendar");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/);
  const row = page.getByRole("option", { name: /Calendar Invitation Message/ });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const card = page.getByRole("region", { name: "Calendar invitation" });
  await expect(card).toBeVisible();
  await check(page, "c4 · invitation card has Yes/No/Maybe, no conflict or free line", card, async () => {
    await expect(card.getByRole("button", { name: "Yes" })).toBeVisible();
    await expect(card.getByRole("button", { name: "No", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Maybe" })).toBeVisible();
    await expect(card).not.toContainText("Conflicts with");
    await expect(card).not.toContainText(/You.re free then/);
  });
});

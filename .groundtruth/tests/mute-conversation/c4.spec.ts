import { test, expect, check, scenario } from "../support/groundtruth";

test("c4: Undo after Mute restores the conversation to the inbox", async ({ page }) => {
  await scenario("signed-in");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/);
  const row = page.getByRole("option", { name: /Archive Action Message/ });
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Mute/ }).click();
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByText("Restored")).toBeVisible();
  await page.goto("/mail/u/0/muted");
  const muted = page.getByText("Nothing muted", { exact: false });
  await check(page, "c4 · Muted view does not list the conversation", muted, async () => {
    await expect(muted).toBeVisible();
    await expect(page.getByText("Archive Action Message")).toHaveCount(0);
  });
  await page.goto("/mail/u/0/inbox");
  const inboxRow = page.getByRole("option", { name: /Archive Action Message/ });
  await check(page, "c4 · inbox lists Archive Action Message again", inboxRow, async () => {
    await expect(inboxRow).toBeVisible();
  });
});

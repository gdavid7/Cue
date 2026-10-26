import { test, expect, check, scenario } from "../support/groundtruth";

test("c6: Shift+M opens internal comment box without muting", async ({ page }) => {
  await scenario("team-workspace");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  const option = page.getByRole("option", { name: /Re: Reader Navigation Message/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByTestId("thread-reader")).toBeVisible();
  await page.keyboard.press("Shift+M");
  const box = page.getByRole("combobox", { name: "Internal comment" });
  await check(page, "c6 · internal comment box opens, conversation not muted", box, async () => {
    await expect(box).toBeVisible();
    await page.getByRole("link", { name: /^Inbox/ }).click();
    await expect(page.getByRole("option", { name: /Re: Reader Navigation Message/ })).toBeVisible();
  });
});

import { test, expect, check, scenario } from "../support/groundtruth";

test("c3: muted conversation stays out of inbox, shows in Muted with Wren's reply", async ({ page }) => {
  test.setTimeout(120000);
  await scenario("muted-conversation-with-reply");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/, { timeout: 30000 });
  const list = page.getByRole("listbox", { name: "Conversations" });
  await expect(list).toBeVisible({ timeout: 30000 });
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(page.getByText("Offsite venue shortlist", { exact: false })).toHaveCount(0);

  const muted = page.getByRole("link", { name: "Muted" });
  if (!(await muted.isVisible())) {
    await page.getByRole("button", { name: "More" }).click();
  }
  await muted.click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/muted/);
  const item = page.getByRole("button", { name: /Re: Offsite venue shortlist/ }).first();
  await expect(item).toBeVisible();
  await item.click();

  const reader = page.getByTestId("thread-reader");
  await check(page, "c3 · inbox lacks the conversation, Muted lists it, reply shown", reader, async () => {
    await expect(reader.getByText("Update: the lakeside venue is free in May.")).toBeVisible();
  });

  await page.getByRole("link", { name: /^Inbox/ }).first().click();
  await expect(page.getByRole("listbox", { name: "Conversations" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Offsite venue shortlist", { exact: false })).toHaveCount(0);
});

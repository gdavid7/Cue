import { test, expect, check, scenario } from "../support/groundtruth";

test("c5: unmuting removes conversation from Muted and keeps it out of inbox", async ({ page }) => {
  await scenario("muted-conversation-with-reply");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail\.com Smoke Test User/ }).first().click();
  await page.waitForURL(/\/mail\/u\/0\/inbox/);
  await page.goto("/mail/u/0/muted");
  await expect(page.getByText("Re: Offsite venue shortlist")).toBeVisible();
  await page.getByRole("button", { name: "Unmute" }).click();
  const toast = page.getByText("Unmuted", { exact: true });
  await check(page, "c5 · Unmuted toast, gone from Muted", toast, async () => {
    await expect(toast).toBeVisible();
    await expect(page.getByText("Re: Offsite venue shortlist")).toHaveCount(0);
  });
  await page.getByRole("link", { name: /^Inbox/ }).click();
  const list = page.getByRole("listbox", { name: "Conversations" });
  await expect(list).toBeVisible();
  await check(page, "c5 · stays out of inbox", list, async () => {
    await expect(list.getByText("Offsite venue shortlist")).toHaveCount(0);
  });
});

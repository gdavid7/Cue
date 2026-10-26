import { test, expect, check, scenario } from "../support/groundtruth";

test("c2: muting with m moves conversation from inbox to Muted", async ({ page }) => {
  test.setTimeout(180000);
  await scenario("signed-in");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: /groundtruth-test@gmail.com Smoke Test User/ }).click();
  await expect(page).toHaveURL(/\/mail\/u\/0\/inbox/);
  const row = page.getByRole("option", { name: /Keyboard Navigation Message/ });
  // mail syncs in gradually; the row can arrive late
  await expect(row).toBeAttached({ timeout: 90000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByRole("heading", { name: "Keyboard Navigation Message" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.getByText("Muted", { exact: true }).first()).toBeVisible();
  // Muted lives under "More" in the sidebar
  const nav = page.getByRole("navigation", { name: "Mailboxes" });
  const mutedLink = nav.getByRole("link", { name: "Muted", exact: true });
  if (!(await mutedLink.isVisible())) {
    await nav.getByRole("button", { name: "More", exact: true }).click();
  }
  await mutedLink.click();
  const muted = page.getByRole("list", { name: "Muted conversations" });
  await check(page, "c2 · Muted view lists it", muted, async () => {
    await expect(muted).toContainText("Keyboard Navigation Message");
  });
  await nav.getByRole("link", { name: /^Inbox/ }).click();
  const list = page.getByRole("listbox", { name: "Conversations" });
  await expect(list).toBeVisible();
  await expect(page.getByRole("option", { name: /Reply Workflow Message/ })).toBeAttached({ timeout: 60000 });
  await check(page, "c2 · inbox no longer lists it", list, async () => {
    await expect(page.getByRole("option", { name: /Keyboard Navigation Message/ })).toHaveCount(0);
  });
});

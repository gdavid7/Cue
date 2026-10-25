import { expect } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  openMail,
  readLatestMailMutation,
} from "./mail-test-helpers";
import { mailEngineConnectionCopy } from "@/utils/mail-engine/connection-notice";

const THREAD_ID = "thr_playwright_archive";
const SUBJECT = "Archive Action Message";
const CHANGES_WAITING = `1 change waiting to reach ${
  isMicrosoftPlaywright() ? "Outlook" : "Gmail"
}`;

test("archives offline, says so, and lands the archive after reconnecting", async ({
  page,
  context,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const conversation = conversationWithSubject(page, conversations, SUBJECT);
  await expect(conversation).toHaveCount(1);
  const offlineTitle = mailEngineConnectionCopy("offline", undefined)?.title;
  if (!offlineTitle) throw new Error("Offline notice copy is missing");
  const offlineStatus = page
    .getByRole("status")
    .filter({ hasText: offlineTitle });
  const latestArchive = () =>
    readLatestMailMutation(page, {
      emailAccountId,
      kind: "archive",
      threadId: THREAD_ID,
    });

  let archived = false;
  const cleanupErrors: unknown[] = [];
  try {
    await expect(offlineStatus).toHaveCount(0);
    await context.setOffline(true);
    await expect(offlineStatus).toBeVisible();

    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    archived = true;
    await expect(conversation).toHaveCount(0);
    // Queued, not sent: nothing can reach the provider while offline.
    await expect.poll(latestArchive).toMatchObject({ kind: "archive" });
    expect((await latestArchive())?.status).not.toBe("succeeded");
    await expect(offlineStatus).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "archive-queued-offline");

    // A change that can't go out for a while says so in the sidebar. With
    // nothing pending the sidebar checks once a minute, then every 10 s.
    const changesWaiting = page.getByRole("button", { name: CHANGES_WAITING });
    await expect(changesWaiting).toBeVisible({ timeout: 90_000 });
    await changesWaiting.click();
    const popover = page.getByRole("dialog");
    await expect(popover.getByText("Changes waiting")).toBeVisible();
    await expect(popover.getByText(/1 change · Archive/)).toBeVisible();
    await expect(
      popover.getByRole("button", { name: "Try now" }),
    ).toBeDisabled();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "changes-waiting-offline",
    );
    await page.keyboard.press("Escape");

    await context.setOffline(false);
    await expect
      .poll(latestArchive, { timeout: 60_000 })
      .toMatchObject({ status: "succeeded" });
    await expect(offlineStatus).toHaveCount(0, { timeout: 30_000 });
    await expect(conversation).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: CHANGES_WAITING }),
    ).toHaveCount(0, { timeout: 45_000 });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "archive-after-reconnect",
    );
  } finally {
    await context.setOffline(false);
    if (archived) {
      await page.request
        .post(`/api/threads/${THREAD_ID}/unarchive`, {
          headers: { "X-Email-Account-ID": emailAccountId },
        })
        .then((response) => expect(response.ok()).toBe(true))
        .catch((error) => {
          cleanupErrors.push(error);
        });
    }
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

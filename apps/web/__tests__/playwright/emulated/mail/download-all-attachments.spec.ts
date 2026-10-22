import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { getEmailAccountId } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  insertMessageWithAttachments,
  removeMessage,
} from "./attachment-message-helpers";

let inserted: { threadId: string; messageId: string } | undefined;
let subject = "";
let notes = "";

test.beforeEach(async ({ page }, testInfo) => {
  const token = `z${testInfo.retry}${Date.now().toString(36)}`;
  subject = `Download all ${token}`;
  notes = `notes-${token}.txt`;
  inserted = await insertMessageWithAttachments(page, {
    subject,
    attachments: [
      {
        name: notes,
        type: "text/plain",
        bytes: Buffer.from("first notes"),
        inline: false,
      },
      {
        name: `plan-${token}.txt`,
        type: "text/plain",
        bytes: Buffer.from("the plan"),
        inline: false,
      },
      // Same name as the first: both must survive in the archive.
      {
        name: notes,
        type: "text/plain",
        bytes: Buffer.from("second notes"),
        inline: false,
      },
    ],
  });
});

test.afterEach(async ({ page }) => {
  // Other specs share the mailbox.
  if (inserted) await removeMessage(page, inserted.messageId);
  inserted = undefined;
});

test("downloads every attachment of a message as one zip", async ({
  page,
}, testInfo) => {
  await openInsertedThread(page);
  const downloadAll = page.getByRole("button", { name: "Download all (3)" });
  await expect(downloadAll).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "download-all-button");

  const download = page.waitForEvent("download");
  await downloadAll.click();
  const savedFile = await download;

  expect(savedFile.suggestedFilename()).toBe(`${subject} attachments.zip`);
  expect(await savedFile.failure()).toBeNull();
  const savedPath = await savedFile.path();
  expect(savedPath).not.toBeNull();
  const entries = unzipSync(new Uint8Array(await readFile(savedPath!)));
  const texts = Object.values(entries).map((data) =>
    new TextDecoder().decode(data),
  );
  expect(Object.keys(entries)).toHaveLength(3);
  expect(Object.keys(entries)).toContain(notes);
  expect(texts.sort()).toEqual(["first notes", "second notes", "the plan"]);
  await expect(downloadAll).toBeEnabled();
});

test("can be reached and used from the keyboard", async ({ page }) => {
  await openInsertedThread(page);
  const downloadAll = page.getByRole("button", { name: "Download all (3)" });
  await downloadAll.focus();
  await expect(downloadAll).toBeFocused();

  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});

async function openInsertedThread(page: Page) {
  if (!inserted) throw new Error("No message was inserted");
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/mail?thread-id=${inserted.threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(notes, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}
